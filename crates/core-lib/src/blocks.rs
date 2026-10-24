//! Input that a stream context passes to its encoder in blocks of a fixed
//! size, whatever the chunks that it arrives in.
//!
//! Some encoders compress the input of each call on its own, or lose state
//! between calls, so that their output depends on how the calls split the
//! input, and small calls compress much worse: zlib-rs at levels 5 and 6
//! (#724), and brotli at qualities 0 and 1 (#731). Fed in blocks, they give
//! the same output however the stream's input is split into chunks.

use std::io;

/// The input of a stream that does not complete a block yet.
pub(crate) struct Blocks {
    /// The size of a block, in bytes.
    size: usize,
    /// The input after the last block, less than [`Self::size`] bytes.
    held: Vec<u8>,
}

impl Blocks {
    /// Blocks of `size` bytes, which is not 0.
    pub(crate) const fn new(size: usize) -> Self {
        Self {
            size,
            held: Vec::new(),
        }
    }

    /// Pass each block that `chunk` completes to `write`, one block per
    /// call, and hold the rest of `chunk`.
    pub(crate) fn write(
        &mut self,
        mut chunk: &[u8],
        mut write: impl FnMut(&[u8]) -> io::Result<()>,
    ) -> io::Result<()> {
        if !self.held.is_empty() {
            let wanted = self.size - self.held.len();
            let (start, rest) = chunk.split_at(wanted.min(chunk.len()));
            self.held.extend_from_slice(start);
            chunk = rest;
            if self.held.len() < self.size {
                return Ok(());
            }
            write(&self.held)?;
            self.held.clear();
        }

        let (blocks, rest) = chunk.split_at(chunk.len() - chunk.len() % self.size);
        for block in blocks.chunks(self.size) {
            write(block)?;
        }
        if !rest.is_empty() {
            // The held input never grows past a block.
            self.held.reserve_exact(self.size);
            self.held.extend_from_slice(rest);
        }
        Ok(())
    }

    /// Pass the input held, if any, to `write`, to flush the stream, and
    /// keep the memory that held it for the next block.
    pub(crate) fn drain(&mut self, write: impl FnOnce(&[u8]) -> io::Result<()>) -> io::Result<()> {
        if !self.held.is_empty() {
            write(&self.held)?;
            self.held.clear();
        }
        Ok(())
    }

    /// The input held, to end the stream with, and its memory with it.
    pub(crate) fn take(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.held)
    }

    /// The memory that holds the input, in bytes.
    pub(crate) fn capacity(&self) -> usize {
        self.held.capacity()
    }
}

#[cfg(test)]
mod tests {
    use super::Blocks;

    /// The calls that `write` gets for `chunks`, by their lengths, and the
    /// input left held.
    fn calls(size: usize, chunks: &[usize]) -> (Vec<usize>, usize) {
        let mut blocks = Blocks::new(size);
        let mut calls = Vec::new();
        for &len in chunks {
            blocks
                .write(&vec![7; len], |block| {
                    calls.push(block.len());
                    Ok(())
                })
                .unwrap();
        }
        (calls, blocks.held.len())
    }

    #[test]
    fn passes_whole_blocks_whatever_the_chunks() {
        assert_eq!(calls(4, &[1, 1, 1]), (vec![], 3));
        assert_eq!(calls(4, &[1, 1, 1, 1]), (vec![4], 0));
        assert_eq!(calls(4, &[3, 6]), (vec![4, 4], 1));
        assert_eq!(calls(4, &[9]), (vec![4, 4], 1));
        assert_eq!(calls(4, &[0, 8, 0]), (vec![4, 4], 0));
    }

    #[test]
    fn drain_passes_what_is_held_once() {
        let mut blocks = Blocks::new(4);
        blocks.write(b"abc", |_| unreachable!()).unwrap();
        let capacity = blocks.capacity();
        assert!(capacity >= 4);
        let mut drained = Vec::new();
        blocks
            .drain(|held| {
                drained.extend_from_slice(held);
                Ok(())
            })
            .unwrap();
        assert_eq!(drained, b"abc");
        // Nothing is held, so nothing is passed, and the memory stays.
        blocks.drain(|_| unreachable!()).unwrap();
        assert_eq!(blocks.capacity(), capacity);
        blocks.write(b"d", |_| unreachable!()).unwrap();
        assert_eq!(blocks.take(), b"d");
        assert_eq!(blocks.capacity(), 0);
    }

    #[test]
    fn keeps_what_is_held_when_write_fails() {
        let mut blocks = Blocks::new(4);
        blocks.write(b"ab", |_| unreachable!()).unwrap();
        let error = blocks
            .write(b"cd", |_| Err(std::io::Error::other("injected")))
            .unwrap_err();
        assert_eq!(error.to_string(), "injected");
        assert_eq!(blocks.held, b"abcd");
    }
}
