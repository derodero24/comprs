//! Build the vendored libbrotli (brotli/, see scripts/vendor-brotli.mjs)
//! into a static library: its common, decoder and encoder sources.

use std::path::Path;

fn main() {
    let root = Path::new("brotli/c");
    println!("cargo:rerun-if-changed=brotli");

    let mut build = cc::Build::new();
    build.include(root.join("include")).warnings(false);
    // Without it, the encoder calls exit() when an allocation fails
    // (brotli/c/enc/memory.h), which would end the process that loads
    // comprs; with it, the call fails and the encoder frees what it holds.
    build.define("BROTLI_ENCODER_CLEANUP_ON_OOM", None);
    // MSVC warns that the CRT functions that libbrotli calls, such as
    // memcpy, are unsafe; libbrotli's own CMake build turns that off too.
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        build.define("_CRT_SECURE_NO_WARNINGS", None);
    } else {
        // libbrotli is written in C99. GCC before 5, such as the GCC 4.8 of
        // the cross toolchain that builds the glibc 2.17 Linux binaries,
        // compiles C89 by default.
        build.flag("-std=gnu99");
    }
    // wasm32-unknown-unknown has no C library: wasm-shim has the headers of
    // the part that libbrotli uses, and Rust defines the functions.
    if std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() == Ok("wasm32")
        && std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("unknown")
    {
        println!("cargo:rerun-if-changed=wasm-shim");
        build.include("wasm-shim");
    }
    for dir in ["common", "dec", "enc"] {
        let mut sources: Vec<_> = std::fs::read_dir(root.join(dir))
            .unwrap_or_else(|err| panic!("cannot read brotli/c/{dir}: {err}"))
            .map(|entry| entry.expect("cannot read a brotli source").path())
            .filter(|path| path.extension().is_some_and(|ext| ext == "c"))
            .collect();
        // A stable order keeps the build reproducible.
        sources.sort();
        build.files(sources);
    }
    build.compile("brotli");
}
