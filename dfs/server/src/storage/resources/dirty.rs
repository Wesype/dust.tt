//! Per-object pending work of the indexing pipeline stages (TRANSACTIONAL_OUTBOUND.md).
//!
//! Skeleton: signatures and contracts only, implementation follows.
#![allow(unused_variables)]

use std::fmt;

use dfs_protocol::ObjectId;
use foundationdb::{Transaction, tuple::Subspace};

use crate::storage;

/// Stages whose pending work lives in dirty ranges. The router reads outbox events instead.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum DirtyStage {
    Extract,
    Index,
}

#[derive(Debug)]
pub enum Error {
    InvalidValue,
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidValue => f.write_str("invalid dirty value"),
        }
    }
}

impl std::error::Error for Error {}

/// An FDB commit versionstamp.
pub type WorkStamp = [u8; 10];

/// Pending work for one object in one stage.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Dirty {
    pub object_id: ObjectId,
    /// FDB commit versionstamp of the latest write to this key.
    pub work_stamp: WorkStamp,
    pub source_version: u64,
    /// Latest source change, in Unix milliseconds. Drives the debounce.
    pub changed_at_ms: u64,
    /// First unprocessed source change, in Unix milliseconds. Drives lag reporting.
    pub pending_since_ms: u64,
}

/// One page of due dirty keys and when the next not-yet-due key becomes due.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Claim {
    pub due: Vec<Dirty>,
    pub next_due_at_ms: Option<u64>,
    pub next_after: Option<ObjectId>,
}

/**
 * @cc [owner:flvndvd,label:backend;security] dirty-key-layout
 * Dirty keys MUST live at `dfs-v1-{env}/<stage>/<tenant_id>/dirty/<object_id>` and failed keys at
 * `dfs-v1-{env}/<stage>/<tenant_id>/failed/<object_id>`. A tenant's dirty and failed keys MUST NOT
 * be readable or writable through another tenant's ID.
 */
pub fn dirty_subspace(stage: DirtyStage, tenant_id: &str) -> Subspace {
    todo!()
}

pub fn failed_subspace(stage: DirtyStage, tenant_id: &str) -> Subspace {
    todo!()
}

/**
 * @cc [owner:flvndvd,label:backend;concurrency] mark-preserves-pending-since
 * Marking an object dirty MUST set `changed_at_ms` and `source_version` to the new change and stamp
 * the key at commit. When the key already exists, `pending_since_ms` MUST keep its earlier value.
 */
pub async fn mark(
    tx: &Transaction,
    stage: DirtyStage,
    tenant_id: &str,
    object_id: ObjectId,
    source_version: u64,
    changed_at_ms: u64,
) -> Result<(), storage::Error<Error>> {
    todo!()
}

/**
 * @cc [owner:flvndvd,label:backend;performance] claim-due-only
 * `claim` MUST return at most `limit` keys after `after`, in object ID order, whose
 * `changed_at_ms` is at least the debounce window older than `now_ms`. Keys not yet due MUST be
 * skipped and reported through `next_due_at_ms`. `claim` MUST NOT write.
 */
pub async fn claim(
    tx: &Transaction,
    stage: DirtyStage,
    tenant_id: &str,
    after: Option<ObjectId>,
    now_ms: u64,
    limit: usize,
) -> Result<Claim, storage::Error<Error>> {
    todo!()
}

/**
 * @cc [owner:flvndvd,label:backend;concurrency] clear-if-matching
 * Clearing MUST read the key with conflict tracking and remove it only when its `work_stamp`
 * equals the processed one. A newer stamp MUST stay dirty. A missing key is already cleared.
 */
pub async fn clear_if_matching(
    tx: &Transaction,
    stage: DirtyStage,
    tenant_id: &str,
    dirty: &Dirty,
) -> Result<bool, storage::Error<Error>> {
    todo!()
}

/**
 * @cc [owner:flvndvd,label:backend;error-handling] fail-if-matching
 * A terminal failure MUST move the key from the dirty range to the failed range in one transaction,
 * only when its `work_stamp` equals the processed one. A newer stamp MUST stay dirty and MUST NOT
 * be recorded as failed.
 */
pub async fn fail_if_matching(
    tx: &Transaction,
    stage: DirtyStage,
    tenant_id: &str,
    dirty: &Dirty,
    error_category: &str,
) -> Result<bool, storage::Error<Error>> {
    todo!()
}

/**
 * @cc [owner:flvndvd,label:backend;performance] list-tenants-skip-scan
 * `list_tenants` MUST return at most `limit` distinct tenants with at least one dirty key, after
 * `after`, reading one key per tenant and seeking past that tenant's prefix. It MUST NOT read
 * failed ranges.
 */
pub async fn list_tenants(
    tx: &Transaction,
    stage: DirtyStage,
    after: Option<&str>,
    limit: usize,
) -> Result<Vec<String>, storage::Error<Error>> {
    todo!()
}
