use std::{collections::HashMap, sync::Arc};

use dfs_protocol::{
    ObjectId,
    rpc::{Grant, grant},
};
use foundationdb::{FdbBindingError, RangeOption, Transaction};
use futures::{StreamExt, TryStreamExt, stream};

use super::{
    Error, GRANT_MODE_MASK, GRANT_READ_MODE, GRANT_WRITE_MODE, ObjectResource, hints::Hint,
};
use crate::storage::{
    self,
    resources::{CONCURRENT_READS, session::SessionResource},
};

/// Effective read/write grant bits, before conversion to POSIX owner permissions.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Mode(u32);

impl Mode {
    pub fn can_read(self) -> bool {
        self.0 & GRANT_READ_MODE != 0
    }

    pub fn can_write(self) -> bool {
        self.0 & GRANT_WRITE_MODE != 0
    }

    pub fn bits(self) -> u32 {
        self.0
    }
}

#[derive(Default)]
struct ObjectMode {
    allow: u32,
    deny: u32,
}

impl ObjectResource {
    /**
     * @cc [owner:spolu,label:backend;security] object-granted-modes
     * Ordinary sessions MUST read each target and its full ancestry through the tenant root in
     * the caller's transaction with conflict tracking. Changed parents MUST be followed from fresh
     * records. Complete cached grants MUST replace grant reads only when grants_version matches;
     * cache misses MUST read every explicit grant in that transaction with conflict tracking.
     * Results MUST preserve input order and duplicates, with None for missing targets and zero
     * mode for existing targets without access. Ordinary sessions MUST fail closed on broken or
     * cyclic ancestry. Each returned object MUST be the record used to evaluate its mode, without
     * optional metadata.
     */
    /**
     * @cc [owner:spolu,label:backend;security] superuser-granted-modes
     * Sessions containing the exact subject "superuser" MUST receive read and write on every
     * existing object in their tenant, regardless of grants. Checks MUST still fetch targets in
     * the caller's transaction with conflict tracking, preserving missing objects and invalid-ID
     * errors. Ancestry and grants need not be read; other tenants MUST remain inaccessible.
     */
    /**
     * @cc [owner:spolu,label:backend;security] grant-cache-committed-state
     * Callers MUST NOT stage grant updates before or concurrently with modes_for_session. Namespace
     * writes MAY precede it: ordinary sessions re-read parents, and newly created objects MUST
     * have empty grants. Within an object's lifetime, cached grants and their versions MUST
     * describe the same state. Staged nonempty grants MUST NOT enter the shared cache.
     */
    /**
     * @cc [owner:spolu,label:backend;security] inherited-grant-evaluation
     * For ordinary sessions, starting with zero at the root, each object MUST remove local DENY
     * bits from inherited permissions before adding ALLOW bits whose subjects exactly match the
     * session. Evaluation MUST continue through zero permissions so a deeper ALLOW can restore
     * access. Only read and write bits may be returned.
     */
    pub async fn modes_for_session(
        tx: &Transaction,
        session: &SessionResource,
        object_ids: &[ObjectId],
    ) -> Result<Vec<Option<(Self, Mode)>>, storage::Error<Error>> {
        let tenant = &session.tenant;
        if session.is_superuser() {
            for id in object_ids {
                id.validate().map_err(|_| Error::InvalidId)?;
            }
            let reads: Vec<_> = object_ids
                .iter()
                .map(|id| async move {
                    Ok(Self::fetch(tx, tenant, id)
                        .await?
                        .map(|object| (object, Mode(GRANT_MODE_MASK))))
                })
                .collect();
            return stream::iter(reads)
                .buffered(CONCURRENT_READS)
                .try_collect()
                .await;
        }
        let hints = &session.tree_hints;
        let objects = hints.fetch_ancestry(tx, tenant, object_ids).await?;

        let mut grants_by_object = hints
            .cached_grants(
                &tenant.tenant_id,
                objects
                    .values()
                    .map(|object| (object.object_id, object.grants_version)),
            )
            .await;
        let reads: Vec<_> = objects
            .values()
            .filter(|object| !grants_by_object.contains_key(&object.object_id))
            .map(|object| async move {
                let grants = object.load_grants(tx).await?;
                Ok::<_, storage::Error<Error>>((object.object_id, Arc::from(grants)))
            })
            .collect();
        let grants: Vec<_> = stream::iter(reads)
            .buffer_unordered(CONCURRENT_READS)
            .try_collect()
            .await?;
        grants_by_object.extend(grants);

        let mut resolved = HashMap::new();
        let mut results = Vec::with_capacity(object_ids.len());
        for id in object_ids {
            if !objects.contains_key(id) {
                results.push(None);
                continue;
            }
            let mut path = Vec::new();
            let mut current = *id;
            let mut mode = loop {
                if let Some(mode) = resolved.get(&current) {
                    break *mode;
                }
                let object = objects.get(&current).ok_or(Error::InvalidAncestry)?;
                path.push(current);
                if current == tenant.root_id {
                    break Mode::default();
                }
                current = object.parent_id.ok_or(Error::InvalidAncestry)?;
            };
            for id in path.into_iter().rev() {
                let grants = grants_by_object.get(&id).ok_or(Error::InvalidAncestry)?;
                let object_mode = Self::mode_for_grants(session, grants)?;
                mode = Mode((mode.0 & !object_mode.deny) | object_mode.allow);
                resolved.insert(id, mode);
            }
            let object = objects.get(id).ok_or(Error::InvalidAncestry)?;
            results.push(Some((object.clone(), mode)));
        }
        hints
            .remember(
                &tenant.tenant_id,
                objects.values().filter_map(|object| {
                    let grants = grants_by_object.remove(&object.object_id)?;
                    Some((
                        object.object_id,
                        Hint {
                            parent_id: object.parent_id,
                            grants_version: object.grants_version,
                            grants,
                        },
                    ))
                }),
                object_ids
                    .iter()
                    .filter(|id| !objects.contains_key(id))
                    .copied(),
            )
            .await;
        Ok(results)
    }

    pub(super) async fn load_grants(
        &self,
        tx: &Transaction,
    ) -> Result<Vec<Grant>, storage::Error<Error>> {
        let mut grants = Vec::new();
        let mut next_range = Some(RangeOption::from(self.grant_subspace().range()));
        let mut iteration = 1;
        while let Some(range) = next_range {
            let batch = tx
                .get_range(&range, iteration, false)
                .await
                .map_err(FdbBindingError::from)?;
            next_range = range.next_range(&batch);
            for entry in &batch {
                grants.push(self.grant_from_key(entry.key())?);
            }
            iteration += 1;
        }
        Ok(grants)
    }

    fn mode_for_grants(session: &SessionResource, grants: &[Grant]) -> Result<ObjectMode, Error> {
        let mut mode = ObjectMode::default();
        for grant in grants {
            match &grant.kind {
                Some(grant::Kind::Allow(allow)) => {
                    if session.subjects.contains(&allow.subject) {
                        mode.allow |= allow.mode;
                    }
                }
                Some(grant::Kind::Deny(deny)) => mode.deny |= deny.mode,
                None => return Err(Error::InvalidStoredGrant),
            }
        }
        Ok(mode)
    }
}
