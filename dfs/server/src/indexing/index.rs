//! The index stage: publishes objects to Elasticsearch.

use super::stage::Batch;

/// Target encoded size of one bulk request, including bulk metadata.
pub const BULK_TARGET_BYTES: usize = 1_000_000;

/**
 * @cc [owner:flvndvd,label:backend;concurrency] index-clear-after-publish
 * An object's index dirty key MUST be cleared only after its bulk item succeeded, and only with a
 * matching work stamp. Failed bulk items MUST stay dirty.
 */
/**
 * @cc [owner:flvndvd,label:product] index-document-per-route
 * Missing and excluded objects MUST be tombstoned. Other objects MUST be written with their current
 * name and metadata, plus native text for `text/` MIME type files or the current extraction for
 * extracted files. Other binary files MUST be written without text.
 */
/**
 * @cc [owner:flvndvd,label:performance] index-bulk-size
 * Bulk requests MUST NOT exceed `BULK_TARGET_BYTES` unless they hold a single document.
 */
pub async fn process(batch: Batch) -> anyhow::Result<()> {
    todo!()
}
