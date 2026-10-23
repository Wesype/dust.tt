//! The indexing pipeline: relay, then router, extract, and index stages
//! (TRANSACTIONAL_OUTBOUND.md).
//!
//! Skeleton: signatures and contracts only, implementation follows. Temporal wiring is added with
//! the implementation.
#![allow(unused_variables)]

pub mod extract;
pub mod index;
pub mod relay;
pub mod router;
pub mod stage;

/// Due-time window: an object is processed once its latest change is this old.
pub const DEBOUNCE_MILLISECONDS: u64 = 10_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Stage {
    Router,
    Extract,
    Index,
}

/// Per-stage sizing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StageConfig {
    pub task_queue: &'static str,
    pub batch_objects: usize,
    /// How many `process` activities one tenant's run of this stage keeps going at once, each on
    /// its own batch. Per-tenant overrides may raise it.
    pub max_parallel_batches: usize,
}

pub const ROUTER: StageConfig = StageConfig {
    task_queue: "dfs-router",
    batch_objects: 1_000,
    max_parallel_batches: 1,
};

pub const EXTRACT: StageConfig = StageConfig {
    task_queue: "dfs-extract",
    batch_objects: 10,
    max_parallel_batches: 4,
};

pub const INDEX: StageConfig = StageConfig {
    task_queue: "dfs-index",
    batch_objects: 100,
    max_parallel_batches: 8,
};

impl Stage {
    pub fn config(self) -> StageConfig {
        match self {
            Self::Router => ROUTER,
            Self::Extract => EXTRACT,
            Self::Index => INDEX,
        }
    }

    /**
     * @cc [owner:flvndvd,label:backend;concurrency] one-workflow-per-stage-and-tenant
     * Workflow IDs MUST be `dfs/<stage>/<tenant_id>`, with stage `router`, `extract`, or `index`,
     * so every wake-up for a stage and tenant reaches the same execution.
     */
    pub fn workflow_id(self, tenant_id: &str) -> String {
        todo!()
    }
}
