use std::fmt;

use crate::storage::{self, fdb};
use foundationdb::{Transaction, tuple::Versionstamp};

pub const BATCH_SIZE: usize = 100;

#[derive(Debug)]
pub enum Error {
    TooManyEvents,
    InvalidCursor,
    InvalidEvent,
    TimestampGeneration,
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::TooManyEvents => "too many outbox events in one transaction",
            Self::InvalidCursor => "invalid outbox cursor",
            Self::InvalidEvent => "invalid stored outbox event",
            Self::TimestampGeneration => "outbox timestamp generation failed",
        })
    }
}

impl std::error::Error for Error {}

impl From<Error> for storage::Error<Error> {
    fn from(error: Error) -> Self {
        Self::Resource(error)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OutboxEvent {
    pub event_id: Versionstamp,
    pub created_at_ms: u64,
    pub payload: Vec<u8>,
}

pub struct EventPage {
    pub events: Vec<OutboxEvent>,
    pub next_after: Option<String>,
}

pub struct PartitionPage {
    pub partition_ids: Vec<String>,
    pub next_after: Option<String>,
}

/**
 * @cc [owner:id13,label:backend;concurrency] outbox-enqueue-atomicity
 * Outbox MUST remain purely infrastructure, with no domain knowledge or domain-specific dependencies.
 * Partition IDs and payloads MUST remain opaque; domain validation, event selection, and routing
 * belong to callers. Enqueue MUST append timestamped payloads in the caller's transaction without
 * overwriting earlier events.
 * Reads MUST leave events intact and return at most 100 events or nonempty partitions per page,
 * with exclusive continuation. Committed `event_id` values MUST be strictly increasing within each
 * partition.
 * Empty partitions MUST return no events and MUST NOT appear in `list_partitions`.
 */
impl OutboxEvent {
    pub fn enqueue(
        _tx: &fdb::Transaction,
        _partition_id: &str,
        _payloads: &[Vec<u8>],
    ) -> Result<(), storage::Error<Error>> {
        Ok(())
    }

    /**
     * @cc [owner:id13,label:backend;concurrency] outbox-remove
     * Remove MUST delete only the supplied event IDs from the supplied partition in the caller's
     * transaction. Missing events MUST be ignored; invalid IDs MUST fail before staging deletions.
     */
    pub fn remove(
        _tx: &Transaction,
        _partition_id: &str,
        _event_ids: &[Versionstamp],
    ) -> Result<(), storage::Error<Error>> {
        Ok(())
    }

    pub async fn list(
        _tx: &Transaction,
        _partition_id: &str,
        _after: Option<&str>,
    ) -> Result<EventPage, storage::Error<Error>> {
        Ok(EventPage {
            events: Vec::new(),
            next_after: None,
        })
    }

    pub async fn list_partitions(
        _tx: &Transaction,
        _after: Option<&str>,
    ) -> Result<PartitionPage, storage::Error<Error>> {
        Ok(PartitionPage {
            partition_ids: Vec::new(),
            next_after: None,
        })
    }
}
