//! Mounts a dfs session with the `dfs-fuse` binary and checks it through ordinary file calls.
//!
//! The harness starts the dfs server in this process (`dfs_api::serve` on a local port), creates a
//! tenant and a session, then runs `dfs-fuse` on a temporary directory, as a user would. The server
//! stores its data in the FoundationDB cluster named by `FDB_CLUSTER_FILE`, and mounting needs
//! `/dev/fuse` and `fusermount3`, so this test runs only on Linux, as in CI.
//!
//! All checks run under the single `mount` test below; to add one, write a `fn` taking the mount
//! and call it from there.
#![cfg(target_os = "linux")]

use anyhow::{Context, Result, bail};
use dfs_api::{
    clock,
    storage::{
        fdb,
        resources::{
            directory::DirectoryResource, keys::tenant_subspace, object::ObjectResource,
            tenant::TenantResource,
        },
    },
};
use dfs_protocol::{
    ObjectId,
    rpc::{
        AllowGrant, CreateSessionRequest, CreateTenantRequest, DenyGrant, Grant, GrantUpdate,
        ObjectKind, dfs_client::DfsClient, grant,
    },
};
use nix::{
    errno::Errno,
    sys::signal::{Signal, kill},
    unistd::Pid,
};
use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::{ErrorKind, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus},
    thread,
    time::{Duration, Instant},
};
use tokio::net::TcpListener;
use tonic::{Request, transport::Channel};

const MASTER_KEY: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const SUBJECT: &str = "u:fuse-test";
/// The folder the mount shows at its root, holding the tenant's root directory.
const FOLDER: &str = "files";
/// The readable file in the folder, and its content.
const FILE_NAME: &str = "report.txt";
const FILE_CONTENT: &[u8] = b"hello";
/// The file in the folder the session cannot read.
const UNREADABLE_NAME: &str = "secret.txt";
/// Read and write for the owner only, as `dfs-fuse` requires of the session key file.
const PRIVATE: u32 = 0o600;
/// How long `dfs-fuse` may take to mount, or to exit once asked to.
const MOUNT_TIMEOUT: Duration = Duration::from_secs(10);
const EXIT_TIMEOUT: Duration = Duration::from_secs(10);
/// How often to check whether `dfs-fuse` mounted or exited.
const POLL_INTERVAL: Duration = Duration::from_millis(50);

/// The FDB network boots once per process and cannot restart once stopped, so every check runs
/// under this one test, which holds the guard and drops it before the binary exits.
#[test]
fn mount() -> Result<()> {
    // SAFETY: the only `boot` in this test binary; `_network` is dropped when this test returns.
    #[allow(unsafe_code)]
    let _network = unsafe { foundationdb::boot() };
    // The server keeps running on this runtime while the checks make blocking file calls.
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    let (endpoint, tenant, session_key) = runtime.block_on(async {
        let (endpoint, channel) = serve().await?;
        let tenant = Tenant::create(&channel).await?;
        let session_key = tenant.session_key(&channel).await?;
        anyhow::Ok((endpoint, tenant, session_key))
    })?;
    let directory = TempDir::new()?;
    let key_file = directory.0.join("session-key");
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(PRIVATE)
        .open(&key_file)?
        .write_all(session_key.as_bytes())?;
    let mountpoint = directory.0.join("mnt");
    fs::create_dir(&mountpoint)?;
    let start = || Mount::start(&endpoint, &key_file, tenant.root_id, &mountpoint);

    let mount = start()?;
    root_lists_folders(&mount)?;
    folders_list_readable_files(&mount)?;
    files_stat_and_read(&mount)?;
    missing_and_unreadable_names_are_not_found(&mount)?;
    writes_are_not_supported(&mount)?;
    fsync_succeeds(&mount)?;
    sigterm_unmounts(mount)?;
    external_unmount_exits(start()?)
}

async fn serve() -> Result<(String, Channel)> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let endpoint = format!("http://{}", listener.local_addr()?);
    tokio::spawn(dfs_api::serve(listener, MASTER_KEY, std::future::pending()));
    let channel = Channel::from_shared(endpoint.clone())?.connect().await?;
    Ok((endpoint, channel))
}

fn with_authorization<T>(message: T, authorization: &str) -> Result<Request<T>> {
    let mut request = Request::new(message);
    request
        .metadata_mut()
        .insert("authorization", authorization.parse()?);
    Ok(request)
}

/// A tenant whose root `SUBJECT` can read and write, holding `FILE_NAME`, which `SUBJECT` can read,
/// and `UNREADABLE_NAME`, which it cannot.
struct Tenant {
    key: String,
    root_id: ObjectId,
}

impl Tenant {
    async fn create(channel: &Channel) -> Result<Self> {
        let tenant = DfsClient::new(channel.clone())
            .create_tenant(with_authorization(
                CreateTenantRequest {
                    tenant_id: ObjectId::new_v7().to_string(),
                    root_grants: vec![Grant {
                        kind: Some(grant::Kind::Allow(AllowGrant {
                            subject: SUBJECT.to_owned(),
                            mode: 0o6,
                        })),
                    }],
                },
                &format!("Bearer {MASTER_KEY}"),
            )?)
            .await?
            .into_inner();

        // File creation RPCs are not implemented yet. Directory children also write the entries
        // `Lookup` and `List` read.
        let tx = fdb::database()?.create_trx()?;
        let resource = TenantResource::fetch(&tx, &tenant.tenant_id)
            .await?
            .context("missing tenant")?;
        let root = ObjectResource::fetch(&tx, &resource, &tenant.root_id)
            .await?
            .context("missing root")?;
        let mut root = DirectoryResource::try_from(root)?;
        let mut file = root
            .create_child(
                &tx,
                ObjectId::new_v7(),
                FILE_NAME.to_owned(),
                ObjectKind::File,
                None,
                HashMap::new(),
            )
            .await?;
        file.size = FILE_CONTENT.len() as u64;
        file.record_content_change(&tx, clock::now_ms()?);
        tx.set(
            &tenant_subspace(&tenant.tenant_id).pack(&(
                "block",
                file.object_id.as_bytes().as_slice(),
                0_u64,
            )),
            FILE_CONTENT,
        );
        let mut unreadable = root
            .create_child(
                &tx,
                ObjectId::new_v7(),
                UNREADABLE_NAME.to_owned(),
                ObjectKind::File,
                None,
                HashMap::new(),
            )
            .await?;
        unreadable.update_grants(
            &tx,
            &[GrantUpdate {
                grant: Grant {
                    kind: Some(grant::Kind::Deny(DenyGrant { mode: 0o4 })),
                },
                remove: false,
            }],
        )?;
        tx.commit().await?;

        Ok(Self {
            key: tenant.tenant_key,
            root_id: tenant.root_id,
        })
    }

    async fn session_key(&self, channel: &Channel) -> Result<String> {
        let session = DfsClient::new(channel.clone())
            .create_session(with_authorization(
                CreateSessionRequest {
                    subjects: vec![SUBJECT.to_owned()],
                },
                &format!("Bearer {}", self.key),
            )?)
            .await?
            .into_inner();
        Ok(session.session_key)
    }
}

/// A directory removed on drop.
struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Result<Self> {
        let path = std::env::temp_dir().join(format!("dfs-fuse-mount-{}", std::process::id()));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir(&path)?;
        Ok(Self(path))
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// A running `dfs-fuse`. On drop, kills it and unmounts, so a failed check leaves no mount behind.
struct Mount {
    child: Child,
    mountpoint: PathBuf,
}

impl Mount {
    /// Runs `dfs-fuse` on `mountpoint` with `FOLDER` at its root, and waits until it is mounted.
    fn start(endpoint: &str, key_file: &Path, folder: ObjectId, mountpoint: &Path) -> Result<Self> {
        let unmounted = fs::metadata(mountpoint)?.dev();
        let mut mount = Self {
            child: Command::new(env!("CARGO_BIN_EXE_dfs-fuse"))
                .arg("--endpoint")
                .arg(endpoint)
                .arg("--session-key-file")
                .arg(key_file)
                .arg("--folder")
                .arg(format!("{FOLDER}={folder}"))
                .arg(mountpoint)
                .spawn()?,
            mountpoint: mountpoint.to_owned(),
        };
        let deadline = Instant::now() + MOUNT_TIMEOUT;
        while fs::metadata(mountpoint)?.dev() == unmounted {
            if let Some(status) = mount.child.try_wait()? {
                bail!("dfs-fuse exited before mounting: {status}");
            }
            if Instant::now() >= deadline {
                bail!("dfs-fuse did not mount within {MOUNT_TIMEOUT:?}");
            }
            thread::sleep(POLL_INTERVAL);
        }
        Ok(mount)
    }

    fn path(&self, relative: &str) -> PathBuf {
        self.mountpoint.join(relative)
    }

    /// Waits for `dfs-fuse` to exit and checks the mountpoint is no longer mounted.
    fn wait(&mut self) -> Result<ExitStatus> {
        let deadline = Instant::now() + EXIT_TIMEOUT;
        loop {
            if let Some(status) = self.child.try_wait()? {
                let parent = self
                    .mountpoint
                    .parent()
                    .context("mountpoint has no parent")?;
                if fs::metadata(&self.mountpoint)?.dev() != fs::metadata(parent)?.dev() {
                    bail!("dfs-fuse exited without unmounting");
                }
                return Ok(status);
            }
            if Instant::now() >= deadline {
                bail!("dfs-fuse did not exit within {EXIT_TIMEOUT:?}");
            }
            thread::sleep(POLL_INTERVAL);
        }
    }
}

impl Drop for Mount {
    fn drop(&mut self) {
        if matches!(self.child.try_wait(), Ok(None)) {
            let _ = self.child.kill();
            let _ = self.child.wait();
            let _ = Command::new("fusermount3")
                .arg("-u")
                .arg("-z")
                .arg(&self.mountpoint)
                .status();
        }
    }
}

fn names(directory: &Path) -> Result<Vec<String>> {
    let mut names = fs::read_dir(directory)?
        .map(|entry| Ok(entry?.file_name().to_string_lossy().into_owned()))
        .collect::<Result<Vec<_>>>()?;
    names.sort();
    Ok(names)
}

fn assert_errno<T: std::fmt::Debug>(result: std::io::Result<T>, expected: Errno) {
    let error = result.err();
    assert_eq!(
        error.as_ref().and_then(std::io::Error::raw_os_error),
        Some(expected as i32),
        "{error:?}"
    );
}

fn root_lists_folders(mount: &Mount) -> Result<()> {
    assert_eq!(names(&mount.mountpoint)?, [FOLDER]);
    assert!(fs::metadata(mount.path(FOLDER))?.is_dir());
    Ok(())
}

fn folders_list_readable_files(mount: &Mount) -> Result<()> {
    assert_eq!(names(&mount.path(FOLDER))?, [FILE_NAME]);
    Ok(())
}

fn files_stat_and_read(mount: &Mount) -> Result<()> {
    let path = mount.path(&format!("{FOLDER}/{FILE_NAME}"));
    let metadata = fs::metadata(&path)?;
    assert!(metadata.is_file());
    assert_eq!(metadata.len(), FILE_CONTENT.len() as u64);
    assert_eq!(fs::read(&path)?, FILE_CONTENT);
    Ok(())
}

fn missing_and_unreadable_names_are_not_found(mount: &Mount) -> Result<()> {
    for name in ["missing.txt", UNREADABLE_NAME] {
        let error = fs::metadata(mount.path(&format!("{FOLDER}/{name}"))).err();
        assert_eq!(error.map(|e| e.kind()), Some(ErrorKind::NotFound), "{name}");
    }
    Ok(())
}

// TODO(writes): these fail until write support lands, then check the writes instead.
fn writes_are_not_supported(mount: &Mount) -> Result<()> {
    assert_errno(
        File::create(mount.path(&format!("{FOLDER}/new.txt"))),
        Errno::EOPNOTSUPP,
    );
    assert_errno(
        fs::create_dir(mount.path(&format!("{FOLDER}/new"))),
        Errno::EOPNOTSUPP,
    );
    assert_errno(
        OpenOptions::new()
            .write(true)
            .open(mount.path(&format!("{FOLDER}/{FILE_NAME}"))),
        Errno::EOPNOTSUPP,
    );
    Ok(())
}

fn fsync_succeeds(mount: &Mount) -> Result<()> {
    File::open(mount.path(FOLDER))?.sync_all()?;
    File::open(mount.path(&format!("{FOLDER}/{FILE_NAME}")))?.sync_all()?;
    Ok(())
}

fn sigterm_unmounts(mut mount: Mount) -> Result<()> {
    let pid = i32::try_from(mount.child.id())?;
    kill(Pid::from_raw(pid), Signal::SIGTERM)?;
    assert!(mount.wait()?.success());
    Ok(())
}

fn external_unmount_exits(mut mount: Mount) -> Result<()> {
    let status = Command::new("fusermount3")
        .arg("-u")
        .arg(&mount.mountpoint)
        .status()?;
    assert!(status.success());
    assert!(mount.wait()?.success());
    Ok(())
}
