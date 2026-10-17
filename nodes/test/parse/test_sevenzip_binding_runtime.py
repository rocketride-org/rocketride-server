# =============================================================================
# RocketRide Engine
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""
Guards for the parse node's 7-Zip-JBinding native library on Linux.

The prebuilt ``lib7-Zip-JBinding.so`` inside the ``sevenzipjbinding`` jar carries a
statically linked GCC libstdc++ and exports it, 2800+ ``std::`` symbols. 106 of them are
``STB_GNU_UNIQUE`` under the same names the system ``libstdc++.so.6`` defines, all 40 locale
facet ids among them (``std::num_put<char>::id``, ``std::numpunct<char>::id``, ...); glibc
binds such names process-wide to the first copy it sees, ``RTLD_LOCAL`` or not. Loaded by Tika's JVM before torch, the binding
numbers the system runtime's locale facet table with its own counter, and the first
GCC-built code that formats a number through ``std::ostream`` (torch printing operator
schemas on ``import torch``) calls the wrong facet and dies at address 0x20. The engine
therefore builds the binding itself (vcpkg port ``sevenzipjbinding``, engine toolchain,
libc++) and ships it as ``nodes/parse/lib7-Zip-JBinding.so``; ``TikaApi`` loads only that
file on Linux.

Three guards:

1. ELF properties of the shipped library: it depends on libc++, not libstdc++, and exports
   no ``std::`` and no GNU-unique symbol, only its JNI entry points.
2. The crash itself, in a subprocess: load the shipped library the way the JVM does
   (``RTLD_LOCAL``), then ``import torch``. Must survive.
3. The control: the jar's own prebuilt binding under the same sequence still crashes, and
   survives once the system libstdc++ is loaded globally first (what ``ai/node.py`` does).
   If the control stops crashing, the hazard is gone upstream and the port can go.

2 and 3 need torch in the engine's Python and are skipped without it; 1 always runs.
"""

from __future__ import annotations

import importlib.util
import struct
import subprocess
import sys
import textwrap
import zipfile
from pathlib import Path

import pytest

pytestmark = pytest.mark.skipif(
    sys.platform != 'linux', reason='the shipped binding and the GNU-unique hazard are Linux-only'
)

# Tests run on the engine's Python, so the engine directory is the interpreter's.
_ENGINE_DIR = Path(sys.executable).resolve().parent
_SHIPPED = _ENGINE_DIR / 'nodes' / 'parse' / 'lib7-Zip-JBinding.so'
_JAR_GLOB = 'sevenzipjbinding-all-platforms-*.jar'
_JAR_MEMBER = 'Linux-amd64/lib7-Zip-JBinding.so'

_STB_GNU_UNIQUE = 10
_SHN_UNDEF = 0
_SHT_STRTAB, _SHT_DYNAMIC, _SHT_DYNSYM = 3, 6, 11
_DT_NEEDED, _DT_RPATH, _DT_RUNPATH = 1, 15, 29
_STD_PREFIXES = ('_ZNSt', '_ZNKSt', '_ZSt', '_ZTVSt', '_ZTISt', '_ZTSSt', '_ZGVZNSt', '_ZGVNSt')


def _elf_dynamic_info(path: Path) -> tuple[list[tuple[str, int, int]], list[str], list[str]]:
    """
    Read the dynamic symbols, the NEEDED entries and the RUNPATH of a little-endian ELF64 file.

    Returns:
        ``(symbols, needed, runpath)``: ``symbols`` is a list of ``(name, binding, section index)``
        for every ``.dynsym`` entry, ``needed`` the ``DT_NEEDED`` library names, ``runpath`` the
        ``DT_RUNPATH`` (or ``DT_RPATH``) entries.
    """
    data = path.read_bytes()
    assert data[:4] == b'\x7fELF' and data[4] == 2 and data[5] == 1, f'{path}: not a little-endian ELF64 file'
    shoff, shentsize, shnum = struct.unpack_from('<Q', data, 0x28)[0], *struct.unpack_from('<HH', data, 0x3A)
    sections = []
    for i in range(shnum):
        off = shoff + i * shentsize
        sh_name, sh_type, _flags, _addr, sh_offset, sh_size, sh_link, _info, _align, sh_entsize = struct.unpack_from(
            '<IIQQQQIIQQ', data, off
        )
        sections.append((sh_type, sh_offset, sh_size, sh_link, sh_entsize))

    def strtab(index: int):
        _t, off, size, _l, _e = sections[index]
        table = data[off : off + size]
        return lambda pos: table[pos : table.index(b'\0', pos)].decode('ascii', 'replace')

    symbols: list[tuple[str, int, int]] = []
    needed: list[str] = []
    runpath: list[str] = []
    for sh_type, off, size, link, entsize in sections:
        if sh_type == _SHT_DYNSYM:
            name_at = strtab(link)
            for pos in range(off, off + size, entsize or 24):
                st_name, st_info, _other, st_shndx = struct.unpack_from('<IBBH', data, pos)
                symbols.append((name_at(st_name), st_info >> 4, st_shndx))
        elif sh_type == _SHT_DYNAMIC:
            name_at = strtab(link)
            for pos in range(off, off + size, entsize or 16):
                d_tag, d_val = struct.unpack_from('<qQ', data, pos)
                if d_tag == _DT_NEEDED:
                    needed.append(name_at(d_val))
                elif d_tag in (_DT_RPATH, _DT_RUNPATH):
                    runpath.extend(name_at(d_val).split(':'))
    return symbols, needed, runpath


def _exports(symbols) -> list[tuple[str, int]]:
    """Defined, named dynamic symbols as ``(name, binding)``."""
    return [(name, bind) for name, bind, shndx in symbols if name and shndx != _SHN_UNDEF]


def test_shipped_binding_is_present():
    """The parse node ships its own 7-Zip-JBinding on Linux; without it RAR5 is silently off."""
    assert _SHIPPED.is_file(), (
        f'{_SHIPPED} is missing: the vcpkg port sevenzipjbinding did not build or nodes/scripts/tasks.js '
        f'did not package it (services.json "libs"). TikaApi disables RAR5 instead of loading the jar'
    )


def test_shipped_binding_links_libcxx_not_libstdcxx():
    """The shipped binding uses the engine's C++ runtime and carries none of its own."""
    _symbols, needed, _runpath = _elf_dynamic_info(_SHIPPED)
    assert 'libc++.so.1' in needed, f'NEEDED {needed}: expected the engine libc++'
    assert not any(lib.startswith('libstdc++') for lib in needed), (
        f'NEEDED {needed}: libstdc++ would collide with torch'
    )


def test_shipped_binding_runpath_reaches_the_engine_runtime():
    """
    The RUNPATH must find libc++ beside the engine, like every node library's does.

    ``Dockerfile.engine-base`` runs ``ldd`` over every shipped ``.so`` in a clean image and fails
    the build on an unresolved dependency; vcpkg's rpath fixup once rewrote this one to
    ``$ORIGIN:$ORIGIN/..``, one level short.
    """
    _symbols, _needed, runpath = _elf_dynamic_info(_SHIPPED)
    assert '$ORIGIN/../..' in runpath, f'RUNPATH {runpath}: the engine runtime is two levels up (rocketride-node.cmake)'


def test_shipped_binding_exports_only_jni_entry_points():
    """No ``std::`` and no GNU-unique export: nothing a second C++ runtime could bind to."""
    symbols, _needed, _runpath = _elf_dynamic_info(_SHIPPED)
    exports = _exports(symbols)
    std = sorted(name for name, _b in exports if name.startswith(_STD_PREFIXES))
    unique = sorted(name for name, bind in exports if bind == _STB_GNU_UNIQUE)
    jni = [name for name, _b in exports if name.startswith('Java_')]
    assert std == [], f'{len(std)} std:: symbols exported, e.g. {std[:5]}: a bundled C++ runtime leaks out again'
    assert unique == [], f'{len(unique)} GNU-unique symbols exported, e.g. {unique[:5]}: these bind process-wide'
    assert jni, 'no Java_* entry point exported: not a JNI library'


# ---------------------------------------------------------------------------
# The crash itself, in a subprocess
# ---------------------------------------------------------------------------

_PROBE = textwrap.dedent(
    '''
    """Load a 7-Zip-JBinding the way the JVM does (RTLD_LOCAL), then import torch."""
    import ctypes
    import os
    import sys

    mode, lib = sys.argv[1], sys.argv[2]
    if mode == 'guard':
        # What ai/node.py does on Linux before any JNI library can load.
        ctypes.CDLL('libstdc++.so.6', os.RTLD_NOW | os.RTLD_GLOBAL)
    ctypes.CDLL(lib, os.RTLD_NOW | os.RTLD_LOCAL)
    print('BINDING_LOADED', flush=True)
    import torch  # noqa: F401  - prints operator schemas through std::ostream on import

    print('TORCH_IMPORT_OK', torch.__version__, flush=True)
    '''
)


def _probe(tmp_path: Path, mode: str, lib: Path) -> subprocess.CompletedProcess:
    """Run the probe on the engine's Python; a crash shows as a non-zero exit without the OK line."""
    script = tmp_path / 'probe_sevenzip_torch.py'
    script.write_text(_PROBE, encoding='utf-8')
    return subprocess.run(
        [sys.executable, str(script), mode, str(lib)],
        capture_output=True,
        text=True,
        timeout=600,
        cwd=str(_ENGINE_DIR),
        check=False,
    )


def _survived(result: subprocess.CompletedProcess) -> bool:
    return result.returncode == 0 and 'TORCH_IMPORT_OK' in result.stdout


# What the engine's crash handler prints before it aborts the process on SIGSEGV.
_CRASH_MESSAGE = 'Received terminal system signal'


def _crashed_in_native_code(result: subprocess.CompletedProcess) -> bool:
    """
    The probe loaded the library, then died in native code during ``import torch``.

    Distinguishes the reported crash from a library that failed to load or an ordinary
    Python exception: the load marker is there, no traceback was printed, and the process
    ended by a signal (``-N``, or ``128+N`` when a shell relayed it) after the engine's
    crash handler reported.
    """
    out = result.stdout + result.stderr
    died_by_signal = result.returncode < 0 or result.returncode >= 128
    return (
        'BINDING_LOADED' in result.stdout
        and 'TORCH_IMPORT_OK' not in result.stdout
        and 'Traceback (most recent call last)' not in out
        and died_by_signal
        and _CRASH_MESSAGE in out
    )


_needs_torch = pytest.mark.skipif(
    importlib.util.find_spec('torch') is None,
    reason='torch is not installed in the engine Python; the crash needs a libstdc++ stream user',
)


@pytest.fixture(scope='module')
def jar_prebuilt_binding(tmp_path_factory) -> Path:
    """The upstream prebuilt binding, extracted from the sevenzipjbinding-all-platforms jar."""
    jars = sorted((_ENGINE_DIR / 'java' / 'lib').glob(_JAR_GLOB))
    if not jars:
        pytest.skip(f'{_JAR_GLOB} not found under {_ENGINE_DIR / "java" / "lib"}')
    out = tmp_path_factory.mktemp('sevenzip-jar') / 'lib7-Zip-JBinding.so'
    with zipfile.ZipFile(jars[-1]) as jar:
        out.write_bytes(jar.read(_JAR_MEMBER))
    out.chmod(0o755)
    return out


@_needs_torch
def test_shipped_binding_then_torch_import_survives(tmp_path):
    """The sequence that killed the task on staging, with the shipped library."""
    result = _probe(tmp_path, 'local', _SHIPPED)
    assert _survived(result), f'exit {result.returncode}\n{result.stdout[-800:]}\n{result.stderr[-800:]}'


@_needs_torch
def test_control_jar_binding_then_torch_import_crashes(tmp_path, jar_prebuilt_binding):
    """
    Control: the jar's prebuilt binding still kills the process in that sequence.

    Requires the crash itself: the library loaded, no Python exception, the process died by
    a signal after the engine's crash handler reported. A library that fails to load or an
    import error would not prove anything and fails this test. If the control starts failing
    because the probe survives, upstream fixed its build and the port and guard can be revisited.
    """
    result = _probe(tmp_path, 'local', jar_prebuilt_binding)
    assert _crashed_in_native_code(result), (
        "expected the jar's prebuilt binding to kill the probe in native code during 'import torch' "
        f'(engine crash handler, death by signal); got exit {result.returncode}\n'
        f'{result.stdout[-600:]}\n{result.stderr[-600:]}'
    )


@_needs_torch
def test_control_jar_binding_survives_with_libstdcxx_preloaded(tmp_path, jar_prebuilt_binding):
    """The ai/node.py guard alone: system libstdc++ global first, then the jar's binding, then torch."""
    result = _probe(tmp_path, 'guard', jar_prebuilt_binding)
    assert _survived(result), f'exit {result.returncode}\n{result.stdout[-800:]}\n{result.stderr[-800:]}'


def test_jar_prebuilt_binding_exports_a_bundled_libstdcxx(jar_prebuilt_binding):
    """What the ELF guard above protects against, measured on the jar's library."""
    symbols, needed, _runpath = _elf_dynamic_info(jar_prebuilt_binding)
    exports = _exports(symbols)
    std = [name for name, _b in exports if name.startswith(_STD_PREFIXES)]
    unique = [name for name, bind in exports if bind == _STB_GNU_UNIQUE]
    assert not any(lib.startswith('libstdc++') for lib in needed), 'upstream now links libstdc++ dynamically'
    assert len(std) > 1000 and unique, 'upstream stopped exporting its bundled libstdc++; revisit the port'
