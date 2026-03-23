# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.x     | :white_check_mark: |

> Once version 1.0 is released, this table will be updated to reflect the supported versions.

## Scope

As a compression library with a native Rust core, the following are considered security vulnerabilities:

- **Decompression bombs**: Maliciously crafted compressed data designed to expand to a massive size, causing denial of service through memory or disk exhaustion.
- **Buffer overflows**: Out-of-bounds reads or writes in the native Rust code or WASM module that could lead to crashes or arbitrary code execution.
- **Memory safety issues**: Use-after-free, double-free, or other memory corruption bugs in the native bindings or core library.
- **Integer overflows**: Arithmetic overflows that could lead to incorrect buffer sizes, unexpected behavior, or exploitable conditions.
- **Unsafe FFI boundary issues**: Vulnerabilities arising from data crossing the JavaScript/Rust boundary via napi-rs or WASM.

Issues related to compression ratio, performance, or API usability are **not** considered security vulnerabilities and should be reported as regular issues.

## Reporting a Vulnerability

**Please do not create public issues for security vulnerabilities.**

To report a vulnerability, use [GitHub Security Advisories](https://github.com/derodero24/comprs/security/advisories/new). This allows us to discuss and resolve the issue privately before any public disclosure.

When reporting, please include:

- A description of the vulnerability
- Steps to reproduce the issue
- Potential impact
- Suggested fix (if any)

## Response Timeline

- **Acknowledgment**: Within 48 hours of the report
- **Initial assessment**: Within 5 days
- **Fix for critical vulnerabilities**: Within 7 days of confirmation
- **Fix for non-critical vulnerabilities**: Included in the next scheduled release

## Disclosure Policy

We follow a coordinated disclosure process:

1. The vulnerability is reported privately via GitHub Security Advisories.
2. We confirm the issue and work on a fix.
3. A patched version is released.
4. The vulnerability is publicly disclosed after the fix is available.

We kindly ask reporters to allow us reasonable time to address the issue before any public disclosure.
