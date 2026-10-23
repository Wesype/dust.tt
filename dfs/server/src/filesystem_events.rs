use dfs_protocol::{
    ObjectId,
    rpc::{GrantUpdate, Mutation},
};

use crate::storage::resources::object;

#[derive(Debug, PartialEq, Eq)]
pub struct FilesystemEvent {
    pub object_id: ObjectId,
}

/**
 * @cc [owner:id13,label:backend;concurrency] filesystem-outbox-transaction
 * FilesystemEvent MUST only construct event payloads, without transaction access or storage I/O.
 * Successful Apply operations MUST identify their object and changed parents, including removed IDs.
 * Read-DENY changes MUST identify their object; failed operations and ALLOW-only changes MUST yield nothing.
 * Callers MUST deduplicate object IDs within each transaction and enqueue their encoded payloads
 * under the tenant partition. Filesystem changes and events MUST commit or roll back together;
 * any enqueue failure MUST abort the entire transaction, including all successful operations.
 */
impl FilesystemEvent {
    pub fn from_apply(
        _object_ids: &[ObjectId],
        _mutations: &[Result<Mutation, object::Error>],
    ) -> Result<Vec<Self>, object::Error> {
        Ok(Vec::new())
    }

    pub fn from_grant_update(
        _object_id: ObjectId,
        _changes: &[GrantUpdate],
    ) -> Result<Option<Self>, object::Error> {
        Ok(None)
    }

    pub fn into_payload(self) -> Vec<u8> {
        Vec::new()
    }
}
