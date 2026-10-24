//! The declarations of the part of libbrotli's C API (brotli/c/include)
//! that this crate calls, written by hand from its headers.

use std::ffi::{c_char, c_int, c_void};

/// `BROTLI_BOOL`: `BROTLI_TRUE` (1) or `BROTLI_FALSE` (0).
pub(crate) type BrotliBool = c_int;
pub(crate) const BROTLI_TRUE: BrotliBool = 1;

/// `brotli_alloc_func`.
pub(crate) type AllocFunc = unsafe extern "C" fn(opaque: *mut c_void, size: usize) -> *mut c_void;
/// `brotli_free_func`.
pub(crate) type FreeFunc = unsafe extern "C" fn(opaque: *mut c_void, address: *mut c_void);

/// `BrotliSharedDictionaryType`: `BROTLI_SHARED_DICTIONARY_RAW`, an LZ77
/// prefix dictionary.
pub(crate) const BROTLI_SHARED_DICTIONARY_RAW: c_int = 0;

/// `BrotliEncoderOperation`.
pub(crate) const BROTLI_OPERATION_PROCESS: c_int = 0;
pub(crate) const BROTLI_OPERATION_FLUSH: c_int = 1;
pub(crate) const BROTLI_OPERATION_FINISH: c_int = 2;

/// `BrotliEncoderParameter`.
pub(crate) const BROTLI_PARAM_MODE: c_int = 0;
pub(crate) const BROTLI_PARAM_QUALITY: c_int = 1;
pub(crate) const BROTLI_PARAM_LGWIN: c_int = 2;
pub(crate) const BROTLI_PARAM_SIZE_HINT: c_int = 5;

/// `BrotliDecoderParameter`.
pub(crate) const BROTLI_DECODER_PARAM_LARGE_WINDOW: c_int = 1;

/// `BrotliDecoderResult`.
pub(crate) const BROTLI_DECODER_RESULT_ERROR: c_int = 0;
pub(crate) const BROTLI_DECODER_RESULT_SUCCESS: c_int = 1;
pub(crate) const BROTLI_DECODER_RESULT_NEEDS_MORE_INPUT: c_int = 2;
pub(crate) const BROTLI_DECODER_RESULT_NEEDS_MORE_OUTPUT: c_int = 3;

/// `BrotliEncoderState`, opaque.
#[repr(C)]
pub(crate) struct BrotliEncoderState {
    _private: [u8; 0],
}

/// `BrotliDecoderState`, opaque.
#[repr(C)]
pub(crate) struct BrotliDecoderState {
    _private: [u8; 0],
}

/// `BrotliEncoderPreparedDictionary`, opaque.
#[repr(C)]
pub(crate) struct BrotliEncoderPreparedDictionary {
    _private: [u8; 0],
}

unsafe extern "C" {
    pub(crate) fn BrotliEncoderCreateInstance(
        alloc_func: Option<AllocFunc>,
        free_func: Option<FreeFunc>,
        opaque: *mut c_void,
    ) -> *mut BrotliEncoderState;
    pub(crate) fn BrotliEncoderDestroyInstance(state: *mut BrotliEncoderState);
    pub(crate) fn BrotliEncoderSetParameter(
        state: *mut BrotliEncoderState,
        param: c_int,
        value: u32,
    ) -> BrotliBool;
    pub(crate) fn BrotliEncoderCompressStream(
        state: *mut BrotliEncoderState,
        op: c_int,
        available_in: *mut usize,
        next_in: *mut *const u8,
        available_out: *mut usize,
        next_out: *mut *mut u8,
        total_out: *mut usize,
    ) -> BrotliBool;
    pub(crate) fn BrotliEncoderIsFinished(state: *mut BrotliEncoderState) -> BrotliBool;
    pub(crate) fn BrotliEncoderHasMoreOutput(state: *mut BrotliEncoderState) -> BrotliBool;
    pub(crate) fn BrotliEncoderMaxCompressedSize(input_size: usize) -> usize;
    pub(crate) fn BrotliEncoderPrepareDictionary(
        dictionary_type: c_int,
        data_size: usize,
        data: *const u8,
        quality: c_int,
        alloc_func: Option<AllocFunc>,
        free_func: Option<FreeFunc>,
        opaque: *mut c_void,
    ) -> *mut BrotliEncoderPreparedDictionary;
    pub(crate) fn BrotliEncoderDestroyPreparedDictionary(
        dictionary: *mut BrotliEncoderPreparedDictionary,
    );
    pub(crate) fn BrotliEncoderAttachPreparedDictionary(
        state: *mut BrotliEncoderState,
        dictionary: *const BrotliEncoderPreparedDictionary,
    ) -> BrotliBool;
    pub(crate) fn BrotliEncoderVersion() -> u32;

    pub(crate) fn BrotliDecoderCreateInstance(
        alloc_func: Option<AllocFunc>,
        free_func: Option<FreeFunc>,
        opaque: *mut c_void,
    ) -> *mut BrotliDecoderState;
    pub(crate) fn BrotliDecoderDestroyInstance(state: *mut BrotliDecoderState);
    pub(crate) fn BrotliDecoderSetParameter(
        state: *mut BrotliDecoderState,
        param: c_int,
        value: u32,
    ) -> BrotliBool;
    pub(crate) fn BrotliDecoderAttachDictionary(
        state: *mut BrotliDecoderState,
        dictionary_type: c_int,
        data_size: usize,
        data: *const u8,
    ) -> BrotliBool;
    pub(crate) fn BrotliDecoderDecompressStream(
        state: *mut BrotliDecoderState,
        available_in: *mut usize,
        next_in: *mut *const u8,
        available_out: *mut usize,
        next_out: *mut *mut u8,
        total_out: *mut usize,
    ) -> c_int;
    pub(crate) fn BrotliDecoderIsFinished(state: *const BrotliDecoderState) -> BrotliBool;
    pub(crate) fn BrotliDecoderGetErrorCode(state: *const BrotliDecoderState) -> c_int;
    pub(crate) fn BrotliDecoderErrorString(code: c_int) -> *const c_char;
}
