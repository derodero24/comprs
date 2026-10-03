//! Validation of numeric arguments.
//!
//! JavaScript passes every number as an f64. Converting one to a Rust
//! integer at the binding boundary wraps or truncates it (`NaN` and
//! `Infinity` become 0, `1.9` becomes 1, `2 ** 32 + 1` becomes 1), so the
//! bindings take numeric arguments as f64 and validate them here instead.
//! Both bindings thus accept the same numbers and report invalid ones with
//! the same messages.

use std::fmt::Display;

use crate::{ComprsError, MAX_DECOMPRESSED_SIZE};

/// The largest integer that a JavaScript number represents exactly,
/// `Number.MAX_SAFE_INTEGER`.
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

/// An integer argument: its name in error messages and the values it accepts.
pub struct IntArg<T> {
    /// What error messages call the argument.
    pub name: &'static str,
    /// The smallest accepted value.
    pub min: T,
    /// The largest accepted value.
    pub max: T,
}

impl<T> IntArg<T>
where
    T: Copy + PartialOrd + Display + TryFrom<i64>,
{
    /// Check that `value` is within the accepted range.
    pub fn check(&self, value: T) -> Result<T, ComprsError> {
        if value < self.min || value > self.max {
            return Err(self.error());
        }
        Ok(value)
    }

    /// Convert a JavaScript number to an accepted value.
    ///
    /// Rejects NaN, ±Infinity, fractions and values outside the accepted
    /// range. `-0` is accepted as 0.
    pub fn check_f64(&self, value: f64) -> Result<T, ComprsError> {
        if !(value.is_finite() && value.fract() == 0.0 && value.abs() < 2f64.powi(63)) {
            return Err(self.error());
        }
        // An integer below 2^63 in magnitude converts to i64 exactly.
        let value = T::try_from(value as i64).map_err(|_| self.error())?;
        self.check(value)
    }

    /// [`check_f64`](Self::check_f64) for an optional argument: `None`, which
    /// stands for `undefined` or `null`, stays `None`.
    pub fn check_optional_f64(&self, value: Option<f64>) -> Result<Option<T>, ComprsError> {
        value.map(|value| self.check_f64(value)).transpose()
    }

    fn error(&self) -> ComprsError {
        ComprsError::InvalidArg(format!(
            "{} must be an integer between {} and {}",
            self.name, self.min, self.max
        ))
    }
}

/// Validate a size in bytes passed as a JavaScript number: an integer from 0
/// to `Number.MAX_SAFE_INTEGER`.
///
/// On 32-bit targets such as wasm32, sizes above `usize::MAX` saturate to
/// it: no buffer can be larger there anyway.
fn validate_size(value: f64, name: &'static str) -> Result<usize, ComprsError> {
    let size = IntArg {
        name,
        min: 0,
        max: MAX_SAFE_INTEGER,
    }
    .check_f64(value)?;
    Ok(usize::try_from(size).unwrap_or(usize::MAX))
}

/// Validate a capacity parameter, the output limit of the `*WithCapacity`
/// functions: an integer from 0 to `Number.MAX_SAFE_INTEGER`.
///
/// On 32-bit targets such as wasm32, capacities above `usize::MAX` saturate
/// to it: no buffer can be larger there anyway.
pub fn validate_capacity(capacity: f64) -> Result<usize, ComprsError> {
    validate_size(capacity, "capacity")
}

/// Validate the output limit of a streaming decompression context, which
/// defaults to [`MAX_DECOMPRESSED_SIZE`]. It accepts the same values as
/// [`validate_capacity`].
///
/// A limit of 0 accepts only streams that decompress to no output.
pub fn validate_max_output_size(max_output_size: Option<f64>) -> Result<usize, ComprsError> {
    max_output_size.map_or(Ok(MAX_DECOMPRESSED_SIZE), |size| {
        validate_size(size, "maxOutputSize")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const LEVEL: IntArg<i32> = IntArg {
        name: "test level",
        min: -5,
        max: 9,
    };

    const U32: IntArg<u32> = IntArg {
        name: "test value",
        min: 0,
        max: u32::MAX,
    };

    /// Numbers that are not integers, or not finite.
    const NOT_INTEGERS: [f64; 6] = [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, 0.5, 1.9, -1.5];

    fn message(err: ComprsError) -> String {
        assert!(matches!(err, ComprsError::InvalidArg(_)));
        err.to_string()
    }

    #[test]
    fn check_f64_accepts_integers_in_range() {
        for value in [-5, -1, 0, 3, 9] {
            assert_eq!(LEVEL.check_f64(f64::from(value)).unwrap(), value);
        }
        assert_eq!(LEVEL.check_f64(-0.0).unwrap(), 0);
        assert_eq!(U32.check_f64(4_294_967_295.0).unwrap(), u32::MAX);
    }

    #[test]
    fn check_f64_rejects_other_numbers() {
        let out_of_range = [-6.0, 10.0, 4_294_967_297.0, 2f64.powi(63), -2f64.powi(64)];
        for value in NOT_INTEGERS.into_iter().chain(out_of_range) {
            assert_eq!(
                message(LEVEL.check_f64(value).unwrap_err()),
                "test level must be an integer between -5 and 9",
                "{value}"
            );
        }
        for value in [-1.0, 4_294_967_296.0, 2f64.powi(53), 1e300] {
            assert_eq!(
                message(U32.check_f64(value).unwrap_err()),
                "test value must be an integer between 0 and 4294967295",
                "{value}"
            );
        }
    }

    #[test]
    fn check_optional_f64_keeps_none() {
        assert_eq!(LEVEL.check_optional_f64(None).unwrap(), None);
        assert_eq!(LEVEL.check_optional_f64(Some(9.0)).unwrap(), Some(9));
        assert!(LEVEL.check_optional_f64(Some(f64::NAN)).is_err());
    }

    #[test]
    fn check_validates_integers() {
        assert_eq!(LEVEL.check(-5).unwrap(), -5);
        assert_eq!(
            message(LEVEL.check(10).unwrap_err()),
            "test level must be an integer between -5 and 9"
        );
    }

    #[test]
    fn validate_size_accepts_safe_integers() {
        assert_eq!(validate_size(0.0, "size").unwrap(), 0);
        assert_eq!(validate_size(-0.0, "size").unwrap(), 0);
        assert_eq!(validate_size(1024.0, "size").unwrap(), 1024);
        let largest = validate_size(MAX_SAFE_INTEGER as f64, "size").unwrap();
        assert_eq!(
            largest,
            usize::try_from(MAX_SAFE_INTEGER).unwrap_or(usize::MAX)
        );
    }

    #[test]
    fn validate_size_rejects_other_numbers() {
        // 2^64 is where `usize::MAX as f64` rounds to on 64-bit targets.
        let too_large = [2f64.powi(53), 2f64.powi(64), 1e300];
        for value in NOT_INTEGERS.into_iter().chain([-1.0]).chain(too_large) {
            assert_eq!(
                message(validate_size(value, "size").unwrap_err()),
                "size must be an integer between 0 and 9007199254740991",
                "{value}"
            );
        }
    }

    #[test]
    fn validate_capacity_names_the_argument() {
        assert_eq!(validate_capacity(4096.0).unwrap(), 4096);
        for value in [1.5, 2f64.powi(64)] {
            assert_eq!(
                message(validate_capacity(value).unwrap_err()),
                "capacity must be an integer between 0 and 9007199254740991",
                "{value}"
            );
        }
    }

    #[test]
    fn validate_max_output_size_defaults_and_names_the_argument() {
        assert_eq!(
            validate_max_output_size(None).unwrap(),
            MAX_DECOMPRESSED_SIZE
        );
        assert_eq!(validate_max_output_size(Some(0.0)).unwrap(), 0);
        assert_eq!(validate_max_output_size(Some(100.0)).unwrap(), 100);
        for value in [0.5, 1.7, -1.0, f64::NAN, 2f64.powi(64)] {
            assert_eq!(
                message(validate_max_output_size(Some(value)).unwrap_err()),
                "maxOutputSize must be an integer between 0 and 9007199254740991",
                "{value}"
            );
        }
    }
}
