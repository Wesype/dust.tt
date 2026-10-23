//! The stage workflow shared by router, extract, and index.

use dfs_protocol::ObjectId;

use super::Stage;

/// A batch handed to one `process` activity.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Batch {
    pub tenant_id: String,
    pub object_ids: Vec<ObjectId>,
}

/// The result of a `claim` activity.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Claimed {
    pub batches: Vec<Batch>,
    pub next_due_at_ms: Option<u64>,
    pub next_after: Option<ObjectId>,
}

/// Workflow state carried across Continue-As-New.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct StageState {
    pub after: Option<ObjectId>,
}

/**
 * @cc [owner:flvndvd,label:backend;concurrency] claim-disjoint-batches
 * `claim` MUST return at most `max_batches` batches of at most the stage's `batch_objects` due
 * objects, all after `after`, with no object in two batches. It MUST NOT write FDB.
 */
pub async fn claim(
    stage: Stage,
    tenant_id: &str,
    after: Option<ObjectId>,
    max_batches: usize,
) -> anyhow::Result<Claimed> {
    todo!()
}

/**
 * @cc [owner:flvndvd,label:backend;concurrency] stage-in-flight-limit
 * A stage workflow MUST keep at most the stage's `max_parallel_batches` `process` activities
 * running for its tenant, and MUST NOT start a batch containing an object that a running batch
 * holds.
 */
/**
 * @cc [owner:flvndvd,label:backend] stage-drains-then-exits
 * The workflow MUST keep claiming until no key is due, then sleep until the next due time or a
 * `wake`. It MUST exit only when its input range is empty and no batch is in flight.
 */
/**
 * @cc [owner:flvndvd,label:performance] stage-continue-as-new
 * The workflow MUST continue as new when Temporal suggests it, carrying only `StageState`.
 */
pub async fn workflow(stage: Stage, tenant_id: String, state: StageState) -> anyhow::Result<()> {
    todo!()
}
