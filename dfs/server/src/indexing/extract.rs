//! The extract stage: turns binary files into stored text, then hands off to index.

use super::stage::Batch;

/**
 * @cc [owner:flvndvd,label:backend;concurrency] extract-handoff-atomic
 * For each object, switching the current extraction generation, clearing its extract dirty key with
 * a matching work stamp, and marking it index dirty MUST commit in one transaction. Output for a
 * source version that changed during extraction MUST NOT become current.
 */
/**
 * @cc [owner:flvndvd,label:backend;error-handling] extract-retry-reuses-output
 * A retried `process` MUST reuse committed output for an unchanged source and extractor version
 * instead of extracting again.
 */
/**
 * @cc [owner:flvndvd,label:backend;error-handling] extract-terminal-failure
 * An extractor's terminal error MUST move only that object to the extract failed range and MUST NOT
 * fail the rest of the batch. Transient errors MUST fail the activity so Temporal retries it.
 */
pub async fn process(batch: Batch) -> anyhow::Result<()> {
    todo!()
}
