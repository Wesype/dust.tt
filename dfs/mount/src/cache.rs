//! A cache of server replies, so the mount can answer a repeated `lookup` or `getattr` without a
//! round trip to the server.
//!
//! What it holds. Two maps:
//! - `attrs`: an object's attributes, from a `Stat` or `Lookup` reply.
//! - `names`: what a name in a directory points to, from a `Lookup` reply: the object found, or
//!   none when the server answered `ENOENT`, so repeated lookups of a missing name stay local too.
//!
//! How entries get in. After each `Stat` or `Lookup`, `Fs` installs the reply with `sent`, the
//! instant it sent the request. The reply may describe the server as it was at any point after the
//! request left, so its age is counted from the earliest such point: stamping when the reply
//! arrives would understate it. Replies can arrive out of order, so a reply never replaces one
//! from a request sent later.
//!
//! When entries are served. An entry is served only while less than the TTL has passed since
//! `sent`, then ignored, and the next request goes to the server. The TTL is the cache's share of
//! the mount's delay budget (`Budget::cache_ttl`, 750 ms by default), so another mount's change
//! shows here within the budget. A zero TTL caches nothing. `Fs` uses a found name only while its
//! object's attributes are live too.
//!
//! When entries are dropped. A live entry never is: there is no size limit, and memory is bounded
//! by the replies received within one TTL. An expired entry stays in its map until a sweep, which
//! scans the whole map, since entries are not ordered by age: sweeping on every install would cost
//! a full scan each time. So `install` sweeps only when a map grows to `prune_at` entries, dropping
//! every expired entry, then sets `prune_at` to `PRUNE_GROWTH_FACTOR` (2) times the entries left,
//! at least `PRUNE_MIN_ENTRIES`, and shrinks the map to that. A sweep that leaves `n` entries is
//! followed by at least `n` installs before the next one scans `2n`: constant time per install on
//! average, and a map never holds more than twice the entries live at the last sweep, or
//! `PRUNE_MIN_ENTRIES`.

use dfs_protocol::{ObjectId, rpc::Attr};
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

/// The lowest `prune_at`, so a small cache does not sweep on every install. Not tuned: any small
/// floor works, and this many entries cost little memory.
const PRUNE_MIN_ENTRIES: usize = 1024;
/// After a sweep, the next one waits until a map holds this many times the entries left.
const PRUNE_GROWTH_FACTOR: usize = 2;

/// The two maps, served for `ttl`.
/**
 * @cc [owner:fontanierh,label:product] stamped-at-send
 * Callers MUST pass as `sent` an instant taken before the request was sent, never after its reply,
 * so no reply is served for longer than the TTL from its request.
 */
pub(crate) struct Cache {
    ttl: Duration,
    attrs: Stamped<ObjectId, Attr>,
    names: Stamped<(ObjectId, String), Option<ObjectId>>,
}

/// Values, each with the instant its request was sent.
struct Stamped<K, V> {
    entries: HashMap<K, (V, Instant)>,
    /// The size at which the next `install` sweeps expired entries.
    prune_at: usize,
}

impl Cache {
    pub(crate) fn new(ttl: Duration) -> Self {
        Self {
            ttl,
            attrs: Stamped::new(),
            names: Stamped::new(),
        }
    }

    pub(crate) fn attr(&self, object: ObjectId, now: Instant) -> Option<&Attr> {
        self.attrs.get(&object, now, self.ttl)
    }

    /// The object `name` names in `directory`: `Some(None)` when it names none.
    pub(crate) fn name(
        &self,
        directory: ObjectId,
        name: &str,
        now: Instant,
    ) -> Option<Option<ObjectId>> {
        self.names
            .get(&(directory, name.to_owned()), now, self.ttl)
            .copied()
    }

    /// Keeps `attr`, the attributes of `object` from a request sent at `sent`.
    pub(crate) fn install_attr(&mut self, object: ObjectId, attr: Attr, sent: Instant) {
        self.attrs.install(object, attr, sent, self.ttl);
    }

    /// Keeps what `name` names in `directory`, from a request sent at `sent`.
    pub(crate) fn install_name(
        &mut self,
        directory: ObjectId,
        name: String,
        object: Option<ObjectId>,
        sent: Instant,
    ) {
        self.names
            .install((directory, name), object, sent, self.ttl);
    }
}

impl<K: Eq + std::hash::Hash, V> Stamped<K, V> {
    fn new() -> Self {
        Self {
            entries: HashMap::new(),
            prune_at: PRUNE_MIN_ENTRIES,
        }
    }

    /**
     * @cc [owner:fontanierh,label:product] ttl-at-serve
     * `get` MUST return a value only while less than the TTL has passed since its request was
     * sent. A zero TTL MUST serve nothing.
     */
    fn get(&self, key: &K, now: Instant, ttl: Duration) -> Option<&V> {
        let (value, sent) = self.entries.get(key)?;
        (now.saturating_duration_since(*sent) < ttl).then_some(value)
    }

    /**
     * @cc [owner:fontanierh,label:product] newest-request-wins
     * `install` MUST NOT replace a value with one from a request sent earlier.
     */
    /**
     * @cc [owner:fontanierh,label:performance] bounded-by-live-entries
     * When the map reaches `prune_at` entries, `install` MUST drop the expired ones, set
     * `prune_at` to `PRUNE_GROWTH_FACTOR` times the entries left, at least `PRUNE_MIN_ENTRIES`, and
     * shrink the map's capacity to `prune_at`, so expired entries and the space they took do not
     * pile up and pruning stays amortized constant time.
     */
    fn install(&mut self, key: K, value: V, sent: Instant, ttl: Duration) {
        // Nothing would ever be served.
        if ttl.is_zero() {
            return;
        }
        if let Some((_, current)) = self.entries.get(&key)
            && *current > sent
        {
            return;
        }
        self.entries.insert(key, (value, sent));
        if self.entries.len() >= self.prune_at {
            let now = Instant::now();
            self.entries
                .retain(|_, (_, sent)| now.saturating_duration_since(*sent) < ttl);
            self.prune_at = (self.entries.len() * PRUNE_GROWTH_FACTOR).max(PRUNE_MIN_ENTRIES);
            // `retain` scans the whole capacity, so a burst's capacity must not outlive it.
            self.entries.shrink_to(self.prune_at);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TTL: Duration = Duration::from_millis(750);

    fn attr(size: u64) -> Attr {
        Attr {
            size,
            ..Attr::default()
        }
    }

    #[test]
    fn replies_are_served_until_the_ttl_from_their_request() {
        let mut cache = Cache::new(TTL);
        let object = ObjectId::new_v7();
        let sent = Instant::now();
        cache.install_attr(object, attr(1), sent);
        assert_eq!(cache.attr(object, sent).map(|a| a.size), Some(1));
        assert_eq!(
            cache
                .attr(object, sent + TTL - Duration::from_millis(1))
                .map(|a| a.size),
            Some(1)
        );
        assert!(cache.attr(object, sent + TTL).is_none());
    }

    #[test]
    fn missing_names_are_kept_too() {
        let mut cache = Cache::new(TTL);
        let directory = ObjectId::new_v7();
        let found = ObjectId::new_v7();
        let sent = Instant::now();
        cache.install_name(directory, "a".to_owned(), Some(found), sent);
        cache.install_name(directory, "b".to_owned(), None, sent);
        assert_eq!(cache.name(directory, "a", sent), Some(Some(found)));
        assert_eq!(cache.name(directory, "b", sent), Some(None));
        assert_eq!(cache.name(directory, "c", sent), None);
    }

    #[test]
    fn a_zero_ttl_serves_nothing() {
        let mut cache = Cache::new(Duration::ZERO);
        let object = ObjectId::new_v7();
        let sent = Instant::now();
        cache.install_attr(object, attr(1), sent);
        assert!(cache.attr(object, sent).is_none());
    }

    #[test]
    fn an_older_request_does_not_replace_a_newer_one() {
        let mut cache = Cache::new(TTL);
        let object = ObjectId::new_v7();
        let first = Instant::now();
        let second = first + Duration::from_millis(1);
        cache.install_attr(object, attr(2), second);
        cache.install_attr(object, attr(1), first);
        assert_eq!(cache.attr(object, second).map(|a| a.size), Some(2));
    }

    #[test]
    fn expired_entries_are_dropped_as_the_cache_grows() {
        let ttl = Duration::from_millis(1);
        let mut cache = Cache::new(ttl);
        let sent = Instant::now() - ttl;
        for _ in 0..PRUNE_MIN_ENTRIES * 3 {
            cache.install_attr(ObjectId::new_v7(), attr(0), sent);
        }
        assert!(cache.attrs.entries.len() < PRUNE_MIN_ENTRIES);
    }
}
