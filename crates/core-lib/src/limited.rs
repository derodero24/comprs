//! Size-limited output sink for streaming decompression.

use std::io::{self, Write};

use crate::ComprsError;

/// A [`Write`] sink that collects decompressed output into a `Vec<u8>` but
/// refuses to grow past a fixed byte budget.
///
/// Streaming decoders such as flate2's write-side decoders and brotli's
/// `DecompressorWriter` hand their output to the inner writer one internal
/// buffer at a time. The first write that would exceed the budget fails
/// before the decoder inflates any further, so peak memory stays at about the
/// budget plus one decoder buffer, however far a single input chunk expands.
///
/// The budget covers everything written over the sink's lifetime, not only
/// the output collected since the last [`LimitedVec::take`]. Once exceeded,
/// every later write fails too.
pub(crate) struct LimitedVec {
    buf: Vec<u8>,
    limit: usize,
    remaining: usize,
    exceeded: bool,
    /// Context reported in [`ComprsError::SizeLimit`].
    context: &'static str,
}

impl LimitedVec {
    /// Create an empty sink that accepts at most `limit` bytes in total.
    pub(crate) fn new(limit: usize, context: &'static str) -> Self {
        Self {
            buf: Vec::new(),
            limit,
            remaining: limit,
            exceeded: false,
            context,
        }
    }

    /// Take the output collected since the previous call.
    pub(crate) fn take(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.buf)
    }

    /// Capacity of the buffer holding output that has not been taken yet.
    pub(crate) fn capacity(&self) -> usize {
        self.buf.capacity()
    }

    /// Let `fill` append output directly to the buffer, for decoders such as
    /// `flate2::Decompress::decompress_vec` that write into spare capacity.
    ///
    /// If the buffer is full, it first grows by at least `min_spare` bytes
    /// (doubling), but its capacity never exceeds what the budget can still
    /// fill plus one byte. `fill` therefore cannot overshoot the budget by
    /// more than one byte, and an overshoot fails like an oversized write.
    pub(crate) fn append_with<T>(
        &mut self,
        min_spare: usize,
        fill: impl FnOnce(&mut Vec<u8>) -> io::Result<T>,
    ) -> io::Result<T> {
        if self.exceeded {
            return Err(limit_exceeded());
        }
        let len = self.buf.len();
        if self.buf.capacity() == len {
            let target = len
                .saturating_add(self.buf.capacity().max(min_spare))
                .min(len.saturating_add(self.remaining).saturating_add(1));
            self.buf.reserve_exact(target - len);
        }
        let result = fill(&mut self.buf);
        let appended = self.buf.len() - len;
        if appended > self.remaining {
            self.buf.truncate(len);
            self.exceeded = true;
            return Err(limit_exceeded());
        }
        self.remaining -= appended;
        result
    }

    /// Convert an error from the decoder writing into this sink into a
    /// [`ComprsError`]: [`ComprsError::SizeLimit`] once the budget is
    /// exhausted, otherwise [`ComprsError::Operation`] with `context`.
    pub(crate) fn error(&self, e: io::Error, context: &'static str) -> ComprsError {
        if self.exceeded {
            ComprsError::SizeLimit {
                context: self.context,
                limit: self.limit,
            }
        } else {
            ComprsError::Operation {
                context,
                source: e.into(),
            }
        }
    }
}

fn limit_exceeded() -> io::Error {
    io::Error::other("decompressed output exceeds the size limit")
}

impl Write for LimitedVec {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        if self.exceeded || data.len() > self.remaining {
            self.exceeded = true;
            return Err(limit_exceeded());
        }
        let needed = self.buf.len() + data.len();
        if needed > self.buf.capacity() {
            // Grow geometrically, but never past what the budget can still fill.
            let target = needed
                .max(self.buf.capacity().saturating_mul(2))
                .min(self.buf.len() + self.remaining);
            self.buf.reserve_exact(target - self.buf.len());
        }
        self.buf.extend_from_slice(data);
        self.remaining -= data.len();
        Ok(data.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_output_up_to_the_limit() {
        let mut sink = LimitedVec::new(10, "test");
        sink.write_all(b"hello").unwrap();
        sink.write_all(b"world").unwrap();
        assert_eq!(sink.take(), b"helloworld");
    }

    #[test]
    fn budget_spans_take_calls() {
        let mut sink = LimitedVec::new(8, "test");
        sink.write_all(b"12345").unwrap();
        assert_eq!(sink.take(), b"12345");
        let err = sink.write_all(b"6789").unwrap_err();
        assert!(matches!(
            sink.error(err, "test"),
            ComprsError::SizeLimit { limit: 8, .. }
        ));
    }

    #[test]
    fn rejects_the_write_that_crosses_the_limit_without_buffering_it() {
        let mut sink = LimitedVec::new(10, "test");
        sink.write_all(b"12345678").unwrap();
        assert!(sink.write_all(b"abc").is_err());
        assert_eq!(sink.buf, b"12345678");
        assert!(sink.buf.capacity() <= 10);
    }

    #[test]
    fn stays_exceeded() {
        let mut sink = LimitedVec::new(4, "test");
        assert!(sink.write_all(b"12345").is_err());
        let err = sink.write_all(b"1").unwrap_err();
        assert!(matches!(
            sink.error(err, "test"),
            ComprsError::SizeLimit { .. }
        ));
    }

    #[test]
    fn capacity_never_exceeds_the_limit() {
        let limit = 100_000;
        let mut sink = LimitedVec::new(limit, "test");
        while sink.write_all(&[0u8; 4096]).is_ok() {}
        assert!(sink.buf.len() <= limit);
        assert!(sink.buf.capacity() <= limit);
    }

    #[test]
    fn append_with_reserves_at_most_one_byte_past_the_budget() {
        let mut sink = LimitedVec::new(10, "test");
        sink.append_with(4096, |buf| {
            assert_eq!(buf.capacity(), 11);
            buf.extend_from_slice(b"0123456789");
            Ok(())
        })
        .unwrap();
        assert_eq!(sink.take(), b"0123456789");
    }

    #[test]
    fn append_with_rejects_output_past_the_budget() {
        let mut sink = LimitedVec::new(10, "test");
        let err = sink
            .append_with(4096, |buf| {
                buf.extend_from_slice(b"0123456789!");
                Ok(())
            })
            .unwrap_err();
        assert!(matches!(
            sink.error(err, "test"),
            ComprsError::SizeLimit { limit: 10, .. }
        ));
        assert!(sink.write_all(b"x").is_err());
    }

    #[test]
    fn append_with_and_write_share_the_budget() {
        let mut sink = LimitedVec::new(10, "test");
        sink.write_all(b"01234").unwrap();
        sink.append_with(1, |buf| {
            buf.extend_from_slice(b"567");
            Ok(())
        })
        .unwrap();
        assert!(sink.write_all(b"890").is_err());
    }

    #[test]
    fn maps_other_errors_to_operation() {
        let sink = LimitedVec::new(4, "test");
        let err = io::Error::new(io::ErrorKind::InvalidData, "bad data");
        assert!(matches!(
            sink.error(err, "test"),
            ComprsError::Operation { .. }
        ));
    }
}
