---
'@derodero24/comprs': patch
---

Link the C runtime statically into the Windows ARM64 binary
(`@derodero24/comprs-win32-arm64-msvc`), as the x64 one already did. Up to
2.0.2 it imported `VCRUNTIME140.dll` and the `api-ms-win-crt-*` DLLs, so
loading comprs failed on Windows on Arm machines without the Visual C++
Redistributable for ARM64. It now loads without it.
