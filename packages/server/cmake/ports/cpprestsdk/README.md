This is a vcpkg overlay port for `cpprestsdk`.

It is a copy of the upstream vcpkg port (vcpkg `2026.04.27`, cpprestsdk `2.10.19`,
commit `411a109`) with one extra patch, `fix-libcxx16-char-traits.patch`, layered
on top of the stock patch set.

Why it exists: `cpprestsdk` was archived by Microsoft in 2022 and its
`Value2StringFormatter<uint8_t>` (`Release/include/cpprest/streams.h`) uses
`std::basic_string<uint8_t>`, which needs `std::char_traits<unsigned char>`.
libc++ 16 removed that non-standard specialization, so the engine fails to link
against any modern libc++ (Fedora 40+, Ubuntu 24.04, clang/libc++ 16-22). See
issue RR-1438.

The patch reintroduces a minimal, standard-conforming `std::char_traits<unsigned char>`
in `astreambuf.h`, guarded by `_LIBCPP_VERSION >= 160000` so it is a no-op on
libstdc++ and on libc++ < 16 (which still ship the extension) and does not cause
a redefinition there.

When bumping the pinned vcpkg version, re-sync `portfile.cmake`, `vcpkg.json`, and
the stock `.patch` files from upstream and re-verify this patch still applies.
Longer term this port can be dropped once the engine migrates off `cpprestsdk`
(see RR-1468).
