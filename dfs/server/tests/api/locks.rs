use super::{allow, create_directory_child};
use crate::{MASTER_KEY, error_code, serve, with_authorization};
use anyhow::{Context, Result};
use dfs_api::storage::{
    fdb,
    resources::{object::ObjectResource, tenant::TenantResource},
};
use dfs_protocol::{
    ObjectId,
    rpc::{
        self, ApplyRequest, CreateSessionRequest, CreateTenantRequest, ErrorCode, LockRequest,
        ObjectKind, ObjectLock, UpdateOperation, dfs_client::DfsClient, operation::Operation,
    },
};

pub(crate) async fn locks_enforce_ownership_release_and_tenant_scope() -> Result<()> {
    let mut client = DfsClient::new(serve().await?);
    let tenant = client
        .create_tenant(with_authorization(
            CreateTenantRequest {
                tenant_id: ObjectId::new_v7().to_string(),
                root_grants: vec![allow("writer", 0o6), allow("reader", 0o4)],
            },
            &format!("Bearer {MASTER_KEY}"),
        )?)
        .await?
        .into_inner();
    let tenant_authorization = format!("Bearer {}", tenant.tenant_key);
    let session = client
        .create_session(with_authorization(
            CreateSessionRequest {
                subjects: vec!["writer".into()],
            },
            &tenant_authorization,
        )?)
        .await?
        .into_inner();
    let authorization = format!("Bearer {}", session.session_key);
    let reader = client
        .create_session(with_authorization(
            CreateSessionRequest {
                subjects: vec!["reader".into()],
            },
            &tenant_authorization,
        )?)
        .await?
        .into_inner();
    let tx = fdb::database()?.create_trx()?;
    let resource = TenantResource::fetch(&tx, &tenant.tenant_id)
        .await?
        .context("tenant missing")?;
    let file =
        create_directory_child(&tx, &resource, &tenant.root_id, "locked", ObjectKind::File).await?;
    tx.commit().await?;
    let before = ObjectResource::fetch(&fdb::database()?.create_trx()?, &resource, &file)
        .await?
        .context("file missing")?;
    let denied = client
        .lock(with_authorization(
            LockRequest {
                object_id: file,
                lock_id: None,
            },
            &format!("Bearer {}", reader.session_key),
        )?)
        .await
        .err()
        .context("expected forbidden")?;
    assert_eq!(error_code(&denied)?, ErrorCode::Forbidden);
    let lock = client
        .lock(with_authorization(
            LockRequest {
                object_id: file,
                lock_id: None,
            },
            &authorization,
        )?)
        .await?
        .into_inner();
    let conflict = client
        .lock(with_authorization(
            LockRequest {
                object_id: file,
                lock_id: None,
            },
            &authorization,
        )?)
        .await
        .err()
        .context("expected contention")?;
    assert_eq!(error_code(&conflict)?, ErrorCode::WouldBlock);
    let refreshed = client
        .lock(with_authorization(
            LockRequest {
                object_id: file,
                lock_id: Some(lock.lock_id.clone()),
            },
            &authorization,
        )?)
        .await?
        .into_inner();
    assert_eq!(refreshed.lock_id, lock.lock_id);
    assert!(refreshed.expires_at >= lock.expires_at);
    let after = ObjectResource::fetch(&fdb::database()?.create_trx()?, &resource, &file)
        .await?
        .context("file missing")?;
    assert_eq!(
        (before.attr_version, before.content_version, before.ctime_ms),
        (after.attr_version, after.content_version, after.ctime_ms)
    );
    let update = rpc::Operation {
        operation: Some(Operation::Update(UpdateOperation {
            object_id: file,
            ..Default::default()
        })),
    };
    let blocked = client
        .apply(with_authorization(
            ApplyRequest {
                operations: vec![update.clone()],
                locks: vec![],
            },
            &authorization,
        )?)
        .await?
        .into_inner();
    assert_eq!(
        blocked.results[0]
            .error
            .as_ref()
            .context("expected blocked mutation")?
            .code(),
        ErrorCode::WouldBlock
    );
    let proof = ObjectLock {
        object_id: file,
        lock_id: lock.lock_id.clone(),
    };
    let success = client
        .apply(with_authorization(
            ApplyRequest {
                operations: vec![update.clone()],
                locks: vec![proof.clone()],
            },
            &authorization,
        )?)
        .await?
        .into_inner();
    assert!(success.results[0].mutation.is_some());
    let duplicate = client
        .apply(with_authorization(
            ApplyRequest {
                operations: vec![update.clone()],
                locks: vec![proof.clone(), proof.clone()],
            },
            &authorization,
        )?)
        .await
        .err()
        .context("expected duplicate rejection")?;
    assert_eq!(error_code(&duplicate)?, ErrorCode::InvalidInput);
    let malformed = client
        .lock(with_authorization(
            LockRequest {
                object_id: file,
                lock_id: Some(vec![0; 16]),
            },
            &authorization,
        )?)
        .await
        .err()
        .context("expected malformed rejection")?;
    assert_eq!(error_code(&malformed)?, ErrorCode::InvalidInput);

    let other_tenant = client
        .create_tenant(with_authorization(
            CreateTenantRequest {
                tenant_id: ObjectId::new_v7().to_string(),
                root_grants: vec![allow("writer", 0o6)],
            },
            &format!("Bearer {MASTER_KEY}"),
        )?)
        .await?
        .into_inner();
    let other_session = client
        .create_session(with_authorization(
            CreateSessionRequest {
                subjects: vec!["writer".into()],
            },
            &format!("Bearer {}", other_tenant.tenant_key),
        )?)
        .await?
        .into_inner();
    client
        .unlock(with_authorization(
            proof.clone(),
            &format!("Bearer {}", other_session.session_key),
        )?)
        .await?;
    let conflict = client
        .lock(with_authorization(
            LockRequest {
                object_id: file,
                lock_id: None,
            },
            &authorization,
        )?)
        .await
        .err()
        .context("cross-tenant unlock must preserve the lock")?;
    assert_eq!(error_code(&conflict)?, ErrorCode::WouldBlock);
    let malformed = client
        .unlock(with_authorization(
            ObjectLock {
                object_id: file,
                lock_id: vec![0; 15],
            },
            &authorization,
        )?)
        .await
        .err()
        .context("expected malformed unlock rejection")?;
    assert_eq!(error_code(&malformed)?, ErrorCode::InvalidInput);
    client
        .unlock(with_authorization(
            proof.clone(),
            &format!("Bearer {}", reader.session_key),
        )?)
        .await?;
    let lost = client
        .lock(with_authorization(
            LockRequest {
                object_id: file,
                lock_id: Some(lock.lock_id),
            },
            &authorization,
        )?)
        .await
        .err()
        .context("expected released token")?;
    assert_eq!(error_code(&lost)?, ErrorCode::LockLost);
    let missing = client
        .lock(with_authorization(
            LockRequest {
                object_id: ObjectId::new_v7(),
                lock_id: None,
            },
            &authorization,
        )?)
        .await
        .err()
        .context("expected missing object")?;
    assert_eq!(error_code(&missing)?, ErrorCode::NotFound);
    let replacement = client
        .lock(with_authorization(
            LockRequest {
                object_id: file,
                lock_id: None,
            },
            &authorization,
        )?)
        .await?
        .into_inner();
    client
        .unlock(with_authorization(proof, &authorization)?)
        .await?;
    let conflict = client
        .lock(with_authorization(
            LockRequest {
                object_id: file,
                lock_id: None,
            },
            &authorization,
        )?)
        .await
        .err()
        .context("stale unlock must preserve replacement")?;
    assert_eq!(error_code(&conflict)?, ErrorCode::WouldBlock);
    client
        .unlock(with_authorization(
            ObjectLock {
                object_id: file,
                lock_id: replacement.lock_id,
            },
            &authorization,
        )?)
        .await?;
    let root_lock = client
        .lock(with_authorization(
            LockRequest {
                object_id: tenant.root_id,
                lock_id: None,
            },
            &authorization,
        )?)
        .await?
        .into_inner();
    let operations = vec![
        Operation::Create(rpc::CreateOperation {
            parent_id: tenant.root_id,
            object_id: ObjectId::new_v7(),
            name: "blocked".into(),
            kind: ObjectKind::File.into(),
            ..Default::default()
        }),
        Operation::Move(rpc::MoveOperation {
            object_id: file,
            parent_id: tenant.root_id,
            name: "blocked-rename".into(),
            ..Default::default()
        }),
        Operation::Remove(rpc::RemoveOperation {
            object_id: file,
            parent_id: tenant.root_id,
            kind: ObjectKind::File.into(),
        }),
    ];
    let result = client
        .apply(with_authorization(
            ApplyRequest {
                operations: operations
                    .into_iter()
                    .map(|operation| rpc::Operation {
                        operation: Some(operation),
                    })
                    .collect(),
                locks: vec![],
            },
            &authorization,
        )?)
        .await?
        .into_inner();
    assert_eq!(result.results.len(), 3);
    for result in result.results {
        assert_eq!(
            result
                .error
                .context("parent lock must block mutation")?
                .code(),
            ErrorCode::WouldBlock
        );
    }
    let result = client
        .apply(with_authorization(
            ApplyRequest {
                operations: vec![update],
                locks: vec![],
            },
            &authorization,
        )?)
        .await?
        .into_inner();
    assert!(result.results[0].mutation.is_some());
    client
        .unlock(with_authorization(
            ObjectLock {
                object_id: tenant.root_id,
                lock_id: root_lock.lock_id,
            },
            &authorization,
        )?)
        .await?;
    Ok(())
}
