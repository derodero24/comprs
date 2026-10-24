//! Set the `all_formats` cfg when every format feature is on, as it is by
//! default: the format detection of `detect`, which knows every format, and
//! the tests that mix formats exist only then.

fn main() {
    println!("cargo::rustc-check-cfg=cfg(all_formats)");
    let all = ["ZSTD", "GZIP", "BROTLI", "LZ4"]
        .iter()
        .all(|feature| std::env::var_os(format!("CARGO_FEATURE_{feature}")).is_some());
    if all {
        println!("cargo::rustc-cfg=all_formats");
    }
}
