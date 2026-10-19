//! The delay budget: how the maximum delay splits between the write delay and the cache TTL. The
//! maximum delay is configurable per mount and bounds how late it may show another mount's changes,
//! server and network time aside.

use std::time::Duration;

/// The maximum delay when the mount is not configured with one.
/**
 * @cc [owner:fontanierh,label:product] default-max-delay
 * `DEFAULT_MAX_DELAY` MUST be 1 s. It is the delay mounts promise when not configured otherwise,
 * so it MUST NOT be raised to ease the cache or the write log.
 */
pub const DEFAULT_MAX_DELAY: Duration = Duration::from_secs(1);
/// The write delay gets `1 / WRITE_DELAY_DIVISOR` of the maximum delay.
const WRITE_DELAY_DIVISOR: u32 = 4;
/// The longest write delay, however long the maximum delay is configured to be.
const WRITE_DELAY_MAX: Duration = Duration::from_secs(1);

/// The configured maximum delay split in two. Both parts are measured on the mount's clock.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Budget {
    write_delay: Duration,
    cache_ttl: Duration,
}

impl Budget {
    /**
     * @cc [owner:fontanierh,label:product] delay-split
     * `new` MUST set the write delay to `min(max_delay / WRITE_DELAY_DIVISOR, WRITE_DELAY_MAX)` and
     * the cache TTL to the rest, so the two add up to `max_delay`.
     */
    pub fn new(max_delay: Duration) -> Self {
        let write_delay = (max_delay / WRITE_DELAY_DIVISOR).min(WRITE_DELAY_MAX);
        Self {
            write_delay,
            cache_ttl: max_delay - write_delay,
        }
    }

    /// The longest a change should wait in the mount, from its acknowledgment until it leaves in an
    /// `Apply`. A target: a change only leaves once the `Apply` in flight returns.
    pub fn write_delay(&self) -> Duration {
        self.write_delay
    }

    /// How long a cached server reply may be served, from when its request was sent. A hard limit.
    pub fn cache_ttl(&self) -> Duration {
        self.cache_ttl
    }
}

impl Default for Budget {
    fn default() -> Self {
        Self::new(DEFAULT_MAX_DELAY)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn millis(budget: Budget) -> (u128, u128) {
        (
            budget.write_delay().as_millis(),
            budget.cache_ttl().as_millis(),
        )
    }

    #[test]
    fn the_default_splits_one_second_into_a_quarter_and_the_rest() {
        assert_eq!(millis(Budget::default()), (250, 750));
    }

    #[test]
    fn the_write_delay_is_at_most_one_second() {
        assert_eq!(millis(Budget::new(Duration::from_secs(8))), (1_000, 7_000));
    }

    #[test]
    fn a_zero_delay_caches_nothing_and_writes_at_once() {
        assert_eq!(millis(Budget::new(Duration::ZERO)), (0, 0));
    }
}
