//! The router stage: classifies changed objects into extract or index work.

use super::stage::Batch;

/// Where the router sends one object.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Route {
    Extract,
    Index,
}

/// What the router knows about an object's current state.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Current {
    Missing,
    Directory { excluded: bool },
    File { mime_type: String, excluded: bool },
}

/**
 * @cc [owner:flvndvd,label:product] route-by-current-state
 * Missing, excluded, and directory objects MUST route to `Index`. A non-excluded file MUST route to
 * `Extract` when it has a binary MIME type that `has_extractor` accepts, and to `Index` otherwise.
 * Only the object's own `dfs.search.exclude` xattr counts as exclusion.
 */
pub fn route(current: &Current, has_extractor: impl Fn(&str) -> bool) -> Route {
    todo!()
}

/**
 * @cc [owner:flvndvd,label:backend;concurrency] route-and-delete-atomically
 * Dirty keys for routed objects and the deletion of the events they came from MUST commit in one
 * `with_idempotent_transaction`. Deleted events MUST be exactly the ones read for this batch.
 */
/**
 * @cc [owner:flvndvd,label:backend;error-handling] router-wake-best-effort
 * After commit, `process` MUST wake each affected stage workflow at most once. A failed wake MUST
 * NOT fail the activity, since the relay finds the dirty keys again.
 */
pub async fn process(batch: Batch) -> anyhow::Result<()> {
    todo!()
}
