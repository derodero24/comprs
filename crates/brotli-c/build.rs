//! Build the vendored libbrotli (brotli/, see scripts/vendor-brotli.mjs)
//! into a static library: its common, decoder and encoder sources.

use std::path::Path;

fn main() {
    let root = Path::new("brotli/c");
    println!("cargo:rerun-if-changed=brotli");

    let mut build = cc::Build::new();
    build.include(root.join("include")).warnings(false);
    // MSVC warns that the CRT functions that libbrotli calls, such as
    // memcpy, are unsafe; libbrotli's own CMake build turns that off too.
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        build.define("_CRT_SECURE_NO_WARNINGS", None);
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
