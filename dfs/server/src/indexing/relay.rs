//! The relay: finds tenants with pending work and wakes their stage workflows.

use std::time::Duration;

/// How often the Temporal Schedule `dfs-relay` restarts the relay.
pub const SCHEDULE_INTERVAL: Duration = Duration::from_secs(60);
/// How long one relay activity polls before returning.
pub const RUN_DURATION: Duration = Duration::from_secs(55);
pub const POLL_INTERVAL: Duration = Duration::from_secs(5);

/// What one relay activity run did, reported as metrics.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RelayReport {
    pub polls: usize,
    pub woken_router: usize,
    pub woken_extract: usize,
    pub woken_index: usize,
}

/**
 * @cc [owner:flvndvd,label:backend;concurrency] relay-wakes-every-pending-tenant
 * Within one run, the relay MUST wake `dfs/router/<tenant>` for every tenant with outbox events,
 * and `dfs/extract/<tenant>` or `dfs/index/<tenant>` for every tenant with keys in that stage's
 * dirty range, through Signal-With-Start. Each stage and tenant MUST be woken the first time a poll
 * finds its work, and at most once per run.
 */
/**
 * @cc [owner:flvndvd,label:backend] relay-is-read-only
 * The relay MUST NOT write FDB and MUST NOT read failed ranges.
 */
/**
 * @cc [owner:flvndvd,label:performance;concurrency] relay-bounded-run
 * A run MUST return within `RUN_DURATION`, MUST heartbeat at least every `POLL_INTERVAL`, and MUST
 * scan in bounded pages so one large tenant cannot delay others. Failing to wake one tenant MUST
 * NOT stop the run.
 */
pub async fn run() -> anyhow::Result<RelayReport> {
    todo!()
}
