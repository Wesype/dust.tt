use std::collections::HashMap;

use dfs_protocol::{
    ObjectId,
    rpc::{LockState, ObjectKind, ObjectLock},
};
use foundationdb::{
    FdbBindingError, RangeOption, Transaction,
    options::StreamingMode,
    tuple::{pack, unpack},
};

use super::{Error, ObjectResource};
use crate::{
    clock,
    storage::{
        self,
        resources::{
            keys::{namespace_subspace, tenant_subspace},
            session::SessionResource,
        },
    },
};

const LOCK_SWEEP_BATCH_SIZE: usize = 100;

pub const LOCK_TTL_MS: u64 = 60_000;
pub const LOCK_TAKEOVER_GRACE_MS: u64 = 5_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LockId([u8; 16]);

impl LockId {
    fn generate() -> Self {
        Self(*uuid::Uuid::new_v7(uuid::Timestamp::now(uuid::NoContext)).as_bytes())
    }

    pub fn as_bytes(&self) -> &[u8; 16] {
        &self.0
    }
}

impl TryFrom<&[u8]> for LockId {
    type Error = Error;

    fn try_from(bytes: &[u8]) -> Result<Self, Self::Error> {
        let uuid = uuid::Uuid::from_slice(bytes).map_err(|_| Error::InvalidLockId)?;
        if uuid.get_version() != Some(uuid::Version::SortRand)
            || uuid.get_variant() != uuid::Variant::RFC4122
        {
            return Err(Error::InvalidLockId);
        }
        Ok(Self(uuid.into_bytes()))
    }
}

pub fn lock_ids_by_object(locks: Vec<ObjectLock>) -> Result<HashMap<ObjectId, LockId>, Error> {
    let mut lock_ids = HashMap::with_capacity(locks.len());
    for lock in locks {
        lock.object_id.validate().map_err(|_| Error::InvalidId)?;
        let lock_id = LockId::try_from(lock.lock_id.as_slice())?;
        if lock_ids.insert(lock.object_id, lock_id).is_some() {
            return Err(Error::InvalidLockId);
        }
    }
    Ok(lock_ids)
}

#[must_use]
#[derive(Debug, PartialEq)]
pub struct ExpiredLocks(Vec<(ObjectId, LockState)>);

impl ExpiredLocks {
    pub(in crate::storage::resources) fn clear(self, tx: &Transaction, tenant_id: &str) {
        for (object_id, lock) in self.0 {
            ObjectResource::clear_lock(tx, tenant_id, object_id, &lock);
        }
    }
}

impl ObjectResource {
    pub async fn lock(
        tx: &Transaction,
        session: &SessionResource,
        object_id: ObjectId,
        lock_id: Option<LockId>,
    ) -> Result<LockState, storage::Error<Error>> {
        let (object, mode) = Self::modes_for_session(tx, session, &[object_id])
            .await?
            .pop()
            .flatten()
            .ok_or(Error::NotFound)?;
        if !mode.can_read() || !mode.can_write() {
            return Err(Error::Forbidden.into());
        }
        if object.kind == ObjectKind::Symlink {
            return Err(Error::UnsupportedKind.into());
        }
        let now_ms = clock::now_ms().map_err(|_| Error::TimestampGeneration)?;
        Self::lock_at(tx, &session.tenant.tenant_id, object_id, lock_id, now_ms).await
    }

    async fn lock_at(
        tx: &Transaction,
        tenant_id: &str,
        object_id: ObjectId,
        lock_id: Option<LockId>,
        now_ms: u64,
    ) -> Result<LockState, storage::Error<Error>> {
        let previous = Self::fetch_lock(tx, tenant_id, object_id).await?;
        let expires_at_ms = now_ms
            .checked_add(LOCK_TTL_MS)
            .ok_or(Error::TimestampGeneration)?;
        let lock = match lock_id {
            Some(lock_id) => {
                let previous = previous
                    .as_ref()
                    .filter(|previous| {
                        previous.lock_id == lock_id.as_bytes() && now_ms < previous.expires_at
                    })
                    .ok_or(Error::LockLost)?;
                LockState {
                    lock_id: previous.lock_id.clone(),
                    expires_at: previous.expires_at.max(expires_at_ms),
                }
            }
            None => {
                if previous
                    .as_ref()
                    .is_some_and(|previous| now_ms < previous.expires_at + LOCK_TAKEOVER_GRACE_MS)
                {
                    return Err(Error::WouldBlock.into());
                }
                LockState {
                    lock_id: LockId::generate().as_bytes().to_vec(),
                    expires_at: expires_at_ms,
                }
            }
        };
        if let Some(previous) = previous {
            Self::clear_lock(tx, tenant_id, object_id, &previous);
        }
        tx.set(
            &Self::lock_key(tenant_id, object_id),
            &pack(&(lock.lock_id.as_slice(), lock.expires_at)),
        );
        tx.set(
            &Self::lock_expiry_key(tenant_id, object_id, lock.expires_at),
            &[],
        );
        Ok(lock)
    }

    pub async fn unlock(
        tx: &Transaction,
        tenant_id: &str,
        object_id: ObjectId,
        lock_id: LockId,
    ) -> Result<(), storage::Error<Error>> {
        object_id.validate().map_err(|_| Error::InvalidId)?;
        if let Some(lock) = Self::fetch_lock(tx, tenant_id, object_id).await?
            && lock.lock_id == lock_id.as_bytes()
        {
            Self::clear_lock(tx, tenant_id, object_id, &lock);
        }
        Ok(())
    }

    /**
     * @cc [owner:id13,label:backend;concurrency] check-locks-no-writes
     * Checks MUST NOT write. Expired locks MUST be returned for the caller to clear only after its
     * operation succeeds, so a failed operation leaves lock state unchanged.
     */
    pub async fn check_locks(
        tx: &Transaction,
        session: &SessionResource,
        targets: &[ObjectId],
        lock_ids: &HashMap<ObjectId, LockId>,
    ) -> Result<ExpiredLocks, storage::Error<Error>> {
        let now_ms = clock::now_ms().map_err(|_| Error::TimestampGeneration)?;
        Self::check_locks_at(tx, &session.tenant.tenant_id, targets, lock_ids, now_ms).await
    }

    async fn check_locks_at(
        tx: &Transaction,
        tenant_id: &str,
        targets: &[ObjectId],
        lock_ids: &HashMap<ObjectId, LockId>,
        now_ms: u64,
    ) -> Result<ExpiredLocks, storage::Error<Error>> {
        let mut expired = Vec::new();
        for (index, object_id) in targets.iter().enumerate() {
            if targets[..index].contains(object_id) {
                continue;
            }
            let lock = Self::fetch_lock(tx, tenant_id, *object_id).await?;
            if let Some(lock_id) = lock_ids.get(object_id) {
                if !lock.as_ref().is_some_and(|lock| {
                    lock.lock_id == lock_id.as_bytes() && now_ms < lock.expires_at
                }) {
                    return Err(Error::LockLost.into());
                }
            } else if let Some(lock) = lock {
                if now_ms < lock.expires_at + LOCK_TAKEOVER_GRACE_MS {
                    return Err(Error::WouldBlock.into());
                }
                expired.push((*object_id, lock));
            }
        }
        Ok(ExpiredLocks(expired))
    }

    /**
     * @cc [owner:id13,label:backend;concurrency] cleanup-takeover-grace
     * Cleanup MUST NOT clear a lock before `expires_at + LOCK_TAKEOVER_GRACE_MS`.
     */
    pub async fn clear_expired_locks(
        tx: &Transaction,
        now_ms: u64,
    ) -> Result<usize, storage::Error<Error>> {
        let Some(cutoff_ms) = now_ms.checked_sub(LOCK_TAKEOVER_GRACE_MS) else {
            return Ok(0);
        };
        let prefix = namespace_subspace().subspace(&"lock-expiry");
        let range = RangeOption {
            limit: Some(LOCK_SWEEP_BATCH_SIZE),
            mode: StreamingMode::WantAll,
            ..RangeOption::from((
                prefix.range().0,
                prefix
                    .subspace(&cutoff_ms.to_be_bytes().as_slice())
                    .range()
                    .1,
            ))
        };
        let entries = tx
            .get_range(&range, 1, false)
            .await
            .map_err(FdbBindingError::from)?;
        let processed = entries.len();
        for entry in entries {
            let (_, tenant_id, object_bytes): (Vec<u8>, String, Vec<u8>) = prefix
                .unpack(entry.key())
                .map_err(FdbBindingError::PackError)?;
            let object_id = ObjectId::try_from(object_bytes.as_slice())
                .map_err(storage::Error::<Error>::InvalidObjectId)?;
            tx.clear(&Self::lock_key(&tenant_id, object_id));
            tx.clear(entry.key());
        }
        Ok(processed)
    }

    pub(super) async fn fetch_lock(
        tx: &Transaction,
        tenant_id: &str,
        object_id: ObjectId,
    ) -> Result<Option<LockState>, storage::Error<Error>> {
        let Some(value) = tx
            .get(&Self::lock_key(tenant_id, object_id), false)
            .await
            .map_err(FdbBindingError::from)?
        else {
            return Ok(None);
        };
        let (lock_id, expires_at): (Vec<u8>, u64) =
            unpack(&value).map_err(FdbBindingError::PackError)?;
        LockId::try_from(lock_id.as_slice()).map_err(|_| Error::InvalidStoredLock)?;
        Ok(Some(LockState {
            lock_id,
            expires_at,
        }))
    }

    pub(in crate::storage::resources) fn clear_lock(
        tx: &Transaction,
        tenant_id: &str,
        object_id: ObjectId,
        lock: &LockState,
    ) {
        tx.clear(&Self::lock_key(tenant_id, object_id));
        tx.clear(&Self::lock_expiry_key(
            tenant_id,
            object_id,
            lock.expires_at,
        ));
    }

    fn lock_key(tenant_id: &str, object_id: ObjectId) -> Vec<u8> {
        tenant_subspace(tenant_id).pack(&("object", object_id.as_bytes().as_slice(), "lock"))
    }

    fn lock_expiry_key(tenant_id: &str, object_id: ObjectId, expires_at_ms: u64) -> Vec<u8> {
        namespace_subspace().pack(&(
            "lock-expiry",
            expires_at_ms.to_be_bytes().as_slice(),
            tenant_id,
            object_id.as_bytes().as_slice(),
        ))
    }
}

#[cfg(test)]
#[path = "../../../../tests/resources/object/locks.rs"]
pub(crate) mod tests;
