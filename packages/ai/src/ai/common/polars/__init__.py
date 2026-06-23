# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""
Polars wrapper that ensures polars-lts-cpu is the active install on x86_64.

The default `polars` PyPI wheel requires AVX2/FMA/BMI1/BMI2/etc. and crashes
(SEH 0xc000001d / SIGILL) on x86_64 hosts without those features. The
`polars-lts-cpu` wheel ships an AVX2-free binary under the same `polars`
import name. Same Python API; GPU acceleration in the engine flows through
PyTorch (ai.common.torch) and is independent of this choice.

The wrinkle: img2table and other libs declare `polars` as a hard dependency.
Pip/uv resolve them as separate distributions, both writing into the same
`polars/` namespace in site-packages. If the regular `polars` wheel ends up
authoritative for the compiled `_polars.pyd` / `_polars.abi3.so`, you crash;
if the .py files come from one version and the binary from another you get
ImportErrors like "cannot import name 'POLARS_STORAGE_CONFIG_KEYS'".

This module follows the same pattern as ai.common.opencv (which solves the
identical problem for cv2's four conflicting PyPI wheels):
  1. Install polars-lts-cpu via the requirements file.
  2. Uninstall any plain `polars` that came in as a transitive dep.
  3. Force-reinstall polars-lts-cpu so its files are unambiguously on disk.
  4. Reset any cached `polars` modules so the next import is clean.

ARM hosts (Linux aarch64, macOS arm64) don't need this — their default
`polars` wheel has no AVX requirement — so the cleanup is x86_64-only.

Usage:
    from ai.common.polars import pl
    df = pl.DataFrame(...)

Import this BEFORE any module that touches polars (img2table, deltalake, etc.)
so the right binary is in place when those modules load.
"""

import os
import platform
import sys

from depends import FileLock, _get_cache_dir, depends, pip

try:
    from engLib import debug as _debug
except Exception:  # pragma: no cover - engLib is only present in the engine runtime

    def _debug(*_args, **_kwargs):
        """No-op fallback when the engine logging helper is unavailable."""


# polars-lts-cpu only matters on x86_64; ARM wheels don't ship AVX2 code paths.
_NEEDS_LTS = platform.machine().lower() in ('x86_64', 'amd64')

requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
depends(requirements)

if _NEEDS_LTS:
    try:
        import importlib.metadata as _md

        # `polars` and `polars-lts-cpu` are distinct PyPI *distributions* that
        # install into the same `polars` *import* namespace. version() queries
        # the distribution name, so this detects a transitively-pulled plain
        # `polars` even though the import name is identical for both.
        _has_plain_polars = False
        try:
            _md.version('polars')
            _has_plain_polars = True
        except _md.PackageNotFoundError:
            # Plain `polars` not installed — only polars-lts-cpu is on disk,
            # which is exactly the desired state. No cleanup needed.
            pass

        if _has_plain_polars:
            # Plain `polars` was pulled in transitively (img2table etc.).
            # Drop it and force-reinstall lts-cpu so its binary wins on disk.
            #
            # Serialize this under the same install lock depends() uses: pip()
            # runs raw with no locking, so without this two worker processes
            # starting concurrently could interleave uninstall/reinstall and
            # corrupt site-packages mid-rewrite.
            with FileLock(os.path.join(_get_cache_dir(), 'install.lock')):
                pip('uninstall', '-y', 'polars')
                pip('install', '--force-reinstall', '--no-deps', 'polars-lts-cpu')

                # Drop any already-loaded polars modules so the next import
                # picks up the freshly-written files instead of cached state.
                for _mod in [m for m in list(sys.modules) if m == 'polars' or m.startswith('polars.')]:
                    sys.modules.pop(_mod, None)
    except Exception as _exc:
        # Best-effort cleanup. If it fails, the import below will surface the
        # underlying issue with a real traceback; log why we skipped cleanup.
        _debug(f'ai.common.polars: lts-cpu cleanup skipped: {_exc}')

import polars as pl  # noqa: E402

__all__ = ['pl']
