//! The write log: the mount's changes, in the order it acknowledged them, on their way to the
//! server.
//!
//! A change is acknowledged as soon as it is queued here, before it reaches the server. `run` sends
//! the queue in `Apply` calls, one at a time: when a call returns, the next one leaves at once with
//! everything queued since, up to `APPLY_MAX_OPERATIONS` operations and `APPLY_MAX_REQUEST_BYTES`.
//! There is no timer: a lone change leaves at once, and changes queued while a call runs leave
//! together in the next.
//!
//! Each operation succeeds or fails on its own. A failed operation, or every operation of a call
//! that failed as a whole, is dropped: it is logged and never sent again, and the next `sync`
//! reports the first such failure. A call whose reply is lost may or may not have been applied, so
//! it is not replayed either.

use crate::{errno::Errno, remote::Remote};
use dfs_protocol::rpc::{Mutation, operation};
use std::{
    collections::VecDeque,
    sync::{Mutex, MutexGuard, PoisonError},
};
use tokio::sync::{Notify, watch};

/// Most operations one `Apply` carries.
const APPLY_MAX_OPERATIONS: usize = 512;
/// Most bytes of one encoded `Apply` request: the API's 4 MiB request limit.
const APPLY_MAX_REQUEST_BYTES: usize = 4 * 1024 * 1024;

/// The queue of acknowledged changes, and the task that sends it. `run` must be running for
/// changes to leave, and for `sync` to return.
pub struct WriteLog {
    state: Mutex<State>,
    /// Woken when an operation is queued.
    queued: Notify,
    /// How many operations ever queued have finished: committed or dropped.
    finished: watch::Sender<u64>,
}

struct State {
    queue: VecDeque<operation::Operation>,
    /// How many operations were ever queued.
    pushed: u64,
    /// The first failure since the last `sync`.
    failure: Option<Errno>,
}

impl WriteLog {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(State {
                queue: VecDeque::new(),
                pushed: 0,
                failure: None,
            }),
            queued: Notify::new(),
            finished: watch::Sender::new(0),
        }
    }

    /// Must not be held across an `.await`.
    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Queues `operation` after every change queued before it. The change counts as acknowledged
    /// once this returns.
    /**
     * @cc [owner:fontanierh,label:performance] push-never-waits
     * `push` MUST NOT wait for the server or for `run`: it only queues the operation and wakes
     * `run`.
     */
    pub fn push(&self, operation: operation::Operation) {
        let mut state = self.state();
        state.queue.push_back(operation);
        state.pushed += 1;
        drop(state);
        self.queued.notify_one();
    }

    /// Sends the queue to the server, forever. Run it as one task per log.
    /**
     * @cc [owner:fontanierh,label:concurrency;product] ordered-commit
     * `run` MUST have at most one `Apply` in flight, and MUST send the queue in order: each call
     * takes operations from the front, and the next leaves only once the previous one returned.
     */
    /**
     * @cc [owner:fontanierh,label:product] dropped-never-resent
     * Every operation `run` takes MUST finish once its call returns, committed or dropped. A
     * dropped operation MUST NOT be sent again, whether it failed on its own, its call failed, or
     * its reply was lost.
     */
    pub async fn run(&self, remote: &Remote) {
        loop {
            let batch: Vec<_> = {
                let mut state = self.state();
                let count = batch_len(&state.queue);
                state.queue.drain(..count).collect()
            };
            if batch.is_empty() {
                self.queued.notified().await;
                continue;
            }
            let count = batch.len() as u64;
            let summaries: Vec<Summary> = batch.iter().map(Summary::of).collect();
            let results = remote.apply(batch).await;
            self.finish(&summaries, results);
            self.finished.send_modify(|finished| *finished += count);
        }
    }

    /// Records what the call for `summaries` did.
    /**
     * @cc [owner:fontanierh,label:logging;security] drops-logged-without-content
     * `finish` MUST log every dropped operation with its kind, object ID and errno only, never
     * names, extended attributes or written data.
     */
    fn finish(&self, summaries: &[Summary], results: Result<Vec<Result<Mutation, Errno>>, Errno>) {
        let errors: Vec<Option<Errno>> = match results {
            // TODO(cache): install the committed attributes and names.
            Ok(results) => results.into_iter().map(Result::err).collect(),
            Err(errno) => vec![Some(errno); summaries.len()],
        };
        let dropped: Vec<(&Summary, Errno)> = summaries
            .iter()
            .zip(errors)
            .filter_map(|(summary, errno)| Some((summary, errno?)))
            .collect();
        if let Some((_, errno)) = dropped.first() {
            self.state().failure.get_or_insert(*errno);
        }
        // Outside the lock: a slow log sink must not hold up `push`.
        for (summary, errno) in dropped {
            tracing::warn!(
                operation = summary.kind,
                object_id = %summary.object_id,
                errno = errno.0,
                "dropped a change the server did not apply"
            );
        }
    }

    /// Waits until every change queued before the call has finished, then reports the first
    /// failure since the previous `sync`.
    /**
     * @cc [owner:fontanierh,label:product] sync-barrier
     * `sync` MUST return only once every operation queued before it was called has finished,
     * committed or dropped. It MUST fail with the first failure recorded since the previous `sync`
     * returned, and report each failure to one `sync` only.
     */
    pub async fn sync(&self) -> Result<(), Errno> {
        let target = self.state().pushed;
        // The log owns the sender, so the channel cannot close while `self` is borrowed.
        let _ = self
            .finished
            .subscribe()
            .wait_for(|finished| *finished >= target)
            .await;
        self.state().failure.take().map_or(Ok(()), Err)
    }
}

impl Default for WriteLog {
    fn default() -> Self {
        Self::new()
    }
}

/// How many operations from the front of `queue` the next batch takes: at most
/// `APPLY_MAX_OPERATIONS` operations and `APPLY_MAX_REQUEST_BYTES` encoded, but always the first
/// operation, however large, so the server decides about it.
/**
 * @cc [owner:fontanierh,label:api] batch-limits
 * A batch MUST hold at most `APPLY_MAX_OPERATIONS` operations, and its encoded `Apply` request MUST
 * fit `APPLY_MAX_REQUEST_BYTES`, unless it holds a single operation. A non-empty queue MUST give a
 * non-empty batch.
 */
fn batch_len(queue: &VecDeque<operation::Operation>) -> usize {
    let mut bytes = 0;
    let mut count = 0;
    for operation in queue.iter() {
        let size = encoded_size(operation);
        if count == APPLY_MAX_OPERATIONS || (count > 0 && bytes + size > APPLY_MAX_REQUEST_BYTES) {
            break;
        }
        bytes += size;
        count += 1;
    }
    count
}

/// The bytes `operation` adds to an encoded `ApplyRequest`: the tag and length of its `Operation`
/// message, and that message, whose only field is `operation`.
fn encoded_size(operation: &operation::Operation) -> usize {
    let message = operation.encoded_len();
    // `ApplyRequest.operations` is field 1, so its tag takes one byte.
    1 + prost::length_delimiter_len(message) + message
}

/// What a dropped operation is logged with: never names or data.
struct Summary {
    kind: &'static str,
    object_id: dfs_protocol::ObjectId,
}

impl Summary {
    fn of(operation: &operation::Operation) -> Self {
        let (kind, object_id) = match operation {
            operation::Operation::Create(create) => ("create", create.object_id),
            operation::Operation::Update(update) => ("update", update.object_id),
            operation::Operation::Write(write) => ("write", write.object_id),
            operation::Operation::Move(r#move) => ("move", r#move.object_id),
            operation::Operation::Remove(remove) => ("remove", remove.object_id),
        };
        Self { kind, object_id }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dfs_protocol::{
        ObjectId,
        rpc::{ApplyRequest, Operation, WriteOperation},
    };
    use prost::Message;
    use tonic::transport::Channel;

    fn write(size: usize) -> operation::Operation {
        operation::Operation::Write(WriteOperation {
            object_id: ObjectId::new_v7(),
            offset: 0,
            data: vec![0; size],
            append: false,
        })
    }

    fn queue(sizes: &[usize]) -> VecDeque<operation::Operation> {
        sizes.iter().map(|size| write(*size)).collect()
    }

    #[test]
    fn a_batch_holds_at_most_the_operation_limit() {
        assert_eq!(
            batch_len(&queue(&[1; APPLY_MAX_OPERATIONS + 3])),
            APPLY_MAX_OPERATIONS
        );
        assert_eq!(batch_len(&queue(&[1; 3])), 3);
        assert_eq!(batch_len(&queue(&[])), 0);
    }

    #[test]
    fn a_batch_fits_the_request_size() {
        let queue = queue(&[APPLY_MAX_REQUEST_BYTES / 3; 4]);
        let count = batch_len(&queue);
        assert_eq!(count, 2);
        let request = ApplyRequest {
            operations: queue
                .into_iter()
                .take(count)
                .map(|operation| Operation {
                    operation: Some(operation),
                })
                .collect(),
            locks: Vec::new(),
        };
        assert!(request.encoded_len() <= APPLY_MAX_REQUEST_BYTES);
    }

    #[test]
    fn an_operation_over_the_request_size_leaves_alone() {
        assert_eq!(batch_len(&queue(&[APPLY_MAX_REQUEST_BYTES, 1])), 1);
        assert_eq!(batch_len(&queue(&[1, APPLY_MAX_REQUEST_BYTES])), 1);
    }

    #[tokio::test]
    async fn sync_reports_a_failure_once() -> Result<(), Errno> {
        // Nothing listens there, so every call fails.
        let channel = Channel::from_static("http://127.0.0.1:1").connect_lazy();
        let remote = Remote::new(channel, &"0".repeat(64))?;
        let log = std::sync::Arc::new(WriteLog::new());
        assert_eq!(log.sync().await, Ok(()));
        let runner = log.clone();
        tokio::spawn(async move { runner.run(&remote).await });
        log.push(write(1));
        log.push(write(1));
        assert!(log.sync().await.is_err());
        assert_eq!(log.sync().await, Ok(()));
        Ok(())
    }
}
