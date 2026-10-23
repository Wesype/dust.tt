//! A cache of file content, so reading a file again does not go to the server.
//!
//! What it holds: file bytes, by object and `content_version`. Files up to `WHOLE_FILE_MAX_BYTES`
//! are kept whole, larger files in `BLOCK_BYTES` blocks. A part is kept only if a read returned
//! all of it, so the cache never holds a cut-off part.
//!
//! When it serves bytes: only for the `content_version` they were read at. `Fs` asks with the
//! `content_version` of a live cached attribute. So bytes can stay past the cache TTL without ever
//! being stale: when the attribute expires, one `Stat` refreshes it, and the bytes are usable
//! again if the content did not change.
//!
//! When it drops bytes: the cache holds at most `budget_bytes`. Each entry counts its length plus
//! `ENTRY_OVERHEAD_BYTES`, so many tiny files still count. When an install goes over the budget,
//! the least recently used entries go first. Bytes of an old `content_version` are never served
//! again, and go the same way.

use dfs_protocol::ObjectId;
use std::{
    collections::{BTreeMap, HashMap},
    ops::Range,
    sync::Arc,
};

/// The block size for files kept in blocks. Same as the server's (`BLOCK_SIZE_BYTES`).
pub(crate) const BLOCK_BYTES: u64 = 64 * 1024;
/// Files up to this size are kept whole: one `Read` request returns all of them.
pub(crate) const WHOLE_FILE_MAX_BYTES: u64 = dfs_protocol::READ_MAX_BYTES as u64;
/// A rough cost of an entry beyond its bytes (key, map slot, use order). Not measured: it only
/// makes tiny entries count against the budget.
const ENTRY_OVERHEAD_BYTES: usize = 128;

/// Which part of a file an entry holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
enum Part {
    Whole,
    /// The block at this index: bytes from `index * BLOCK_BYTES`.
    Block(u64),
}

struct Entry {
    content_version: u64,
    bytes: Arc<[u8]>,
    /// When the entry was last installed or read, as a position in `Content::by_use`.
    used: u64,
}

/// What `Content::read` found.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Read {
    /// The bytes asked for.
    Hit(Hit),
    /// Some bytes are missing. Read from `from` to get the first missing part: 0 for a file kept
    /// whole, else the start of the first missing block.
    Miss { from: u64 },
}

/// Bytes `read` found. They point into the cache, they are not a copy. Call `to_vec` after
/// releasing the cache's lock, so copying a large read does not block other reads.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Hit(Vec<(Arc<[u8]>, Range<usize>)>);

impl Hit {
    pub(crate) fn to_vec(&self) -> Vec<u8> {
        let mut data = Vec::with_capacity(self.0.iter().map(|(_, range)| range.len()).sum());
        for (bytes, range) in &self.0 {
            data.extend_from_slice(&bytes[range.clone()]);
        }
        data
    }
}

/**
 * @cc [owner:fontanierh,label:product] read-under-live-attribute
 * Callers MUST look bytes up with the `content_version` of a live cached attribute of the object,
 * and install them with the `content_version` and size the read returned, so cached bytes are
 * never served once the server's content changed and the cache TTL passed.
 */
/**
 * @cc [owner:fontanierh,label:performance] within-budget
 * After any `install`, the entries' lengths plus `ENTRY_OVERHEAD_BYTES` each, summed, MUST NOT
 * exceed `budget_bytes`. Entries MUST be dropped least recently installed or read first. An entry
 * larger than the budget MUST NOT be kept.
 */
pub(crate) struct Content {
    budget_bytes: usize,
    held_bytes: usize,
    entries: HashMap<(ObjectId, Part), Entry>,
    /// The entries' keys by last use, least recent first.
    by_use: BTreeMap<u64, (ObjectId, Part)>,
    next_use: u64,
}

impl Content {
    pub(crate) fn new(budget_bytes: usize) -> Self {
        Self {
            budget_bytes,
            held_bytes: 0,
            entries: HashMap::new(),
            by_use: BTreeMap::new(),
            next_use: 0,
        }
    }

    /// Bytes of `object` at `content_version`, from `offset`, at most `length`, stopping at `size`.
    /**
     * @cc [owner:fontanierh,label:product] same-content-version
     * `read` MUST return bytes only from entries installed with the `content_version` it is given.
     */
    /**
     * @cc [owner:fontanierh,label:product] exact-range
     * `read` MUST return a miss, or exactly the bytes from `offset` to `offset + length` (or to
     * `size` if smaller), never fewer. A miss's `from` MUST be 0 for a file kept whole, else the
     * start of the first missing block in that range.
     */
    /**
     * @cc [owner:fontanierh,label:performance] no-copy-under-lock
     * `read` MUST NOT copy cached bytes, and callers MUST copy a `Hit` only after releasing the
     * cache's lock, so a large read does not block other reads.
     */
    pub(crate) fn read(
        &mut self,
        object: ObjectId,
        content_version: u64,
        size: u64,
        offset: u64,
        length: u64,
    ) -> Read {
        let end = offset.saturating_add(length).min(size);
        if offset >= end {
            return Read::Hit(Hit::default());
        }
        if size <= WHOLE_FILE_MAX_BYTES {
            return match self.slice(object, Part::Whole, content_version, 0, offset, end) {
                Some(part) => Read::Hit(Hit(vec![part])),
                None => Read::Miss { from: 0 },
            };
        }
        let mut parts = Vec::new();
        // Each block the range touches: from the block holding its first byte to the one holding
        // its last (`end` is exclusive).
        for index in offset / BLOCK_BYTES..=(end - 1) / BLOCK_BYTES {
            let start = index * BLOCK_BYTES;
            let from = offset.max(start);
            let to = end.min(start.saturating_add(BLOCK_BYTES));
            match self.slice(object, Part::Block(index), content_version, start, from, to) {
                Some(part) => parts.push(part),
                None => return Read::Miss { from: start },
            }
        }
        Read::Hit(Hit(parts))
    }

    /// Keeps what a read returned: `data`, from `offset`, of `object` at `content_version`, a file
    /// of `size` bytes.
    /**
     * @cc [owner:fontanierh,label:product] complete-parts-only
     * `install` MUST keep a file whole only when `data` is all of its `size` bytes, and a block
     * only when `data` covers all of it: `BLOCK_BYTES`, or up to `size` for the last block.
     */
    /**
     * @cc [owner:fontanierh,label:product] newest-version-wins
     * `install` MUST NOT replace a part with one of an older `content_version`.
     */
    pub(crate) fn install(
        &mut self,
        object: ObjectId,
        content_version: u64,
        size: u64,
        offset: u64,
        data: &[u8],
    ) {
        let data_end = offset.saturating_add(data.len() as u64);
        // `read` serves an empty file without an entry.
        if size == 0 {
            return;
        }
        if size <= WHOLE_FILE_MAX_BYTES {
            if offset == 0 && data_end == size {
                self.put(object, Part::Whole, content_version, data);
            }
            return;
        }
        // No block starts at or after `offset` when the next boundary is past `u64::MAX`.
        let Some(mut start) = offset.checked_next_multiple_of(BLOCK_BYTES) else {
            return;
        };
        while start < size {
            let end = size.min(start.saturating_add(BLOCK_BYTES));
            if end > data_end {
                return;
            }
            let (Ok(from), Ok(to)) = (
                usize::try_from(start - offset),
                usize::try_from(end - offset),
            ) else {
                return;
            };
            self.put(
                object,
                Part::Block(start / BLOCK_BYTES),
                content_version,
                &data[from..to],
            );
            start = end;
        }
    }

    /// The part of `object` that starts at `start`, if kept for `content_version`, with the range
    /// of its bytes from `from` to `to`. Marks it as used.
    fn slice(
        &mut self,
        object: ObjectId,
        part: Part,
        content_version: u64,
        start: u64,
        from: u64,
        to: u64,
    ) -> Option<(Arc<[u8]>, Range<usize>)> {
        let key = (object, part);
        let entry = self
            .entries
            .get_mut(&key)
            .filter(|entry| entry.content_version == content_version)?;
        let used = self.next_use;
        self.next_use += 1;
        self.by_use.remove(&entry.used);
        self.by_use.insert(used, key);
        entry.used = used;
        let from = usize::try_from(from - start).ok()?;
        let to = usize::try_from(to - start).ok()?;
        entry.bytes.get(from..to)?;
        Some((entry.bytes.clone(), from..to))
    }

    fn put(&mut self, object: ObjectId, part: Part, content_version: u64, bytes: &[u8]) {
        let key = (object, part);
        let charge = bytes.len() + ENTRY_OVERHEAD_BYTES;
        if charge > self.budget_bytes
            || self
                .entries
                .get(&key)
                .is_some_and(|entry| entry.content_version > content_version)
        {
            return;
        }
        self.remove(&key);
        let used = self.next_use;
        self.next_use += 1;
        self.entries.insert(
            key,
            Entry {
                content_version,
                bytes: Arc::from(bytes),
                used,
            },
        );
        self.by_use.insert(used, key);
        self.held_bytes += charge;
        while self.held_bytes > self.budget_bytes {
            let Some((_, oldest)) = self.by_use.pop_first() else {
                break;
            };
            self.remove(&oldest);
        }
    }

    fn remove(&mut self, key: &(ObjectId, Part)) {
        if let Some(entry) = self.entries.remove(key) {
            self.by_use.remove(&entry.used);
            self.held_bytes -= entry.bytes.len() + ENTRY_OVERHEAD_BYTES;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A file held in blocks: three full blocks and a short last one.
    const LARGE: u64 = WHOLE_FILE_MAX_BYTES + 3 * BLOCK_BYTES + 10;

    fn content(size: u64) -> Vec<u8> {
        (0..size).map(|i| (i % 251) as u8).collect()
    }

    /// What the entries take, counted afresh.
    fn held(cache: &Content) -> usize {
        cache
            .entries
            .values()
            .map(|entry| entry.bytes.len() + ENTRY_OVERHEAD_BYTES)
            .sum()
    }

    fn hit(read: Read) -> Option<Vec<u8>> {
        match read {
            Read::Hit(hit) => Some(hit.to_vec()),
            Read::Miss { .. } => None,
        }
    }

    fn range(data: &[u8], from: u64, to: u64) -> Vec<u8> {
        data[from as usize..to as usize].to_vec()
    }

    #[test]
    fn small_files_are_held_whole_for_their_content_version() {
        let mut cache = Content::new(usize::MAX);
        let object = ObjectId::new_v7();
        let data = content(100);
        assert_eq!(cache.read(object, 1, 100, 0, 10), Read::Miss { from: 0 });
        // Part of a small file is not kept.
        cache.install(object, 1, 100, 0, &data[..50]);
        assert_eq!(cache.read(object, 1, 100, 0, 10), Read::Miss { from: 0 });
        cache.install(object, 1, 100, 0, &data);
        assert_eq!(
            hit(cache.read(object, 1, 100, 10, 1000)),
            Some(range(&data, 10, 100))
        );
        assert_eq!(cache.read(object, 2, 100, 0, 10), Read::Miss { from: 0 });
        // A hit shares the entry's bytes instead of copying them.
        let entry = cache.entries[&(object, Part::Whole)].bytes.clone();
        assert!(matches!(
            cache.read(object, 1, 100, 0, 10),
            Read::Hit(Hit(parts)) if Arc::ptr_eq(&parts[0].0, &entry)
        ));
        // An empty file needs no entry.
        assert_eq!(hit(cache.read(object, 3, 0, 0, 10)), Some(Vec::new()));
    }

    #[test]
    fn large_files_are_held_in_complete_blocks() {
        let mut cache = Content::new(usize::MAX);
        let object = ObjectId::new_v7();
        let data = content(LARGE);
        let first_block = WHOLE_FILE_MAX_BYTES / BLOCK_BYTES;
        // From mid-block: the partial block before the first boundary is not kept.
        let offset = first_block * BLOCK_BYTES + 1;
        cache.install(object, 1, LARGE, offset, &data[offset as usize..]);
        assert_eq!(
            cache.read(object, 1, LARGE, offset, 10),
            Read::Miss {
                from: first_block * BLOCK_BYTES
            }
        );
        let start = (first_block + 1) * BLOCK_BYTES;
        assert_eq!(
            cache.read(object, 1, LARGE, start - 1, 2),
            Read::Miss {
                from: first_block * BLOCK_BYTES
            }
        );
        // Across blocks, through the short last one.
        assert_eq!(
            hit(cache.read(object, 1, LARGE, start + 5, LARGE)),
            Some(range(&data, start + 5, LARGE))
        );
        // A read that ends mid-block keeps only the blocks it covered.
        let other = ObjectId::new_v7();
        cache.install(other, 1, LARGE, 0, &data[..(BLOCK_BYTES + 1) as usize]);
        assert_eq!(
            hit(cache.read(other, 1, LARGE, 0, BLOCK_BYTES)),
            Some(range(&data, 0, BLOCK_BYTES))
        );
        assert_eq!(
            cache.read(other, 1, LARGE, BLOCK_BYTES, 1),
            Read::Miss { from: BLOCK_BYTES }
        );
    }

    #[test]
    fn an_older_content_version_does_not_replace_a_newer_one() {
        let mut cache = Content::new(usize::MAX);
        let object = ObjectId::new_v7();
        cache.install(object, 2, 1, 0, b"b");
        cache.install(object, 1, 1, 0, b"a");
        assert_eq!(hit(cache.read(object, 2, 1, 0, 1)), Some(b"b".to_vec()));
        assert_eq!(cache.read(object, 1, 1, 0, 1), Read::Miss { from: 0 });
    }

    #[test]
    fn the_least_recently_used_entries_go_first() {
        let size = 100;
        // Room for two entries.
        let mut cache = Content::new(2 * (size + ENTRY_OVERHEAD_BYTES));
        let data = content(size as u64);
        let [a, b, c] = [ObjectId::new_v7(), ObjectId::new_v7(), ObjectId::new_v7()];
        cache.install(a, 1, size as u64, 0, &data);
        cache.install(b, 1, size as u64, 0, &data);
        // Reading `a` makes `b` the least recently used.
        assert!(matches!(cache.read(a, 1, size as u64, 0, 1), Read::Hit(_)));
        cache.install(c, 1, size as u64, 0, &data);
        assert!(matches!(cache.read(a, 1, size as u64, 0, 1), Read::Hit(_)));
        assert_eq!(cache.read(b, 1, size as u64, 0, 1), Read::Miss { from: 0 });
        assert!(matches!(cache.read(c, 1, size as u64, 0, 1), Read::Hit(_)));
        assert_eq!(cache.held_bytes, held(&cache));
        assert!(cache.held_bytes <= cache.budget_bytes);
    }

    #[test]
    fn tiny_files_count_against_the_budget() {
        let mut cache = Content::new(10 * (1 + ENTRY_OVERHEAD_BYTES));
        for _ in 0..100 {
            cache.install(ObjectId::new_v7(), 1, 1, 0, b"a");
        }
        assert_eq!(cache.held_bytes, held(&cache));
        assert_eq!(cache.entries.len(), 10);
        assert_eq!(cache.by_use.len(), 10);
    }

    #[test]
    fn an_entry_larger_than_the_budget_is_not_kept() {
        let mut cache = Content::new(ENTRY_OVERHEAD_BYTES + 1);
        let object = ObjectId::new_v7();
        cache.install(object, 1, 2, 0, b"ab");
        assert_eq!(cache.read(object, 1, 2, 0, 2), Read::Miss { from: 0 });
        assert_eq!(cache.held_bytes, 0);
    }

    #[test]
    fn blocks_near_the_largest_size_do_not_overflow() {
        let mut cache = Content::new(2 * BLOCK_BYTES as usize);
        let object = ObjectId::new_v7();
        let last = (u64::MAX - 1) / BLOCK_BYTES * BLOCK_BYTES;
        assert_eq!(
            cache.read(object, 1, u64::MAX, u64::MAX - 3, 3),
            Read::Miss { from: last }
        );
        cache.install(object, 1, u64::MAX, u64::MAX - 3, b"abc");
        assert_eq!(cache.held_bytes, 0);
        let data = content(u64::MAX - last);
        cache.install(object, 1, u64::MAX, last, &data);
        assert_eq!(
            hit(cache.read(object, 1, u64::MAX, u64::MAX - 3, 3)),
            Some(range(&data, data.len() as u64 - 3, data.len() as u64))
        );
    }
}
