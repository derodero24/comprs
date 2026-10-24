//! The memory that the `*_into` functions decode into, such as
//! [`crate::lz4::decompress_into`], and what they return.

use std::error::Error;

/// Output that a decoder appends to: a `Vec`, which grows, or memory of a
/// fixed size that the caller allocated, such as memory that a JavaScript
/// engine allocates.
pub trait Output {
    /// The bytes appended so far.
    fn filled(&self) -> &[u8];

    /// Make room for `additional` more bytes, or fail if there is none.
    fn try_reserve(&mut self, additional: usize) -> Result<(), Box<dyn Error + Send + Sync>>;

    /// Append `bytes`, for which [`Output::try_reserve`] made room: an
    /// implementation may panic otherwise.
    fn extend_from_slice(&mut self, bytes: &[u8]);
}

impl Output for Vec<u8> {
    fn filled(&self) -> &[u8] {
        self
    }

    fn try_reserve(&mut self, additional: usize) -> Result<(), Box<dyn Error + Send + Sync>> {
        Vec::try_reserve(self, additional).map_err(Into::into)
    }

    fn extend_from_slice(&mut self, bytes: &[u8]) {
        Vec::extend_from_slice(self, bytes);
    }
}

/// The output of the `*_into` functions, such as [`crate::lz4::decompress_into`].
#[derive(Debug)]
pub enum Decoded<B> {
    /// The output of frames that declare their content sizes, in the memory
    /// that `allocate` returned for their total.
    Allocated(B),
    /// The output of other input, which the decoder grew, with its spare
    /// capacity released as the functions that return a `Vec` release it.
    Grown(Vec<u8>),
}
