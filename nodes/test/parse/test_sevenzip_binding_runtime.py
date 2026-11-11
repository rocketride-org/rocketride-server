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
Probes for the libstdc++ hazard behind the parse node's 7-Zip-JBinding on Linux (#2676).

The prebuilt ``lib7-Zip-JBinding.so`` inside the ``sevenzipjbinding`` jar carries a statically
linked GCC libstdc++ and exports it: 3000+ ``std::`` symbols, 106 of them ``STB_GNU_UNIQUE``
under the names the system ``libstdc++.so.6`` defines, the locale facet ids among them. glibc
binds such a name process-wide to the first copy that resolves it, ``RTLD_LOCAL`` or not.
Loaded by Tika's JVM before the GNU runtime, the binding owns those ids and numbers them with
its own counter; the first GCC-built code that then formats a number through ``std::ostream``
(torch does, on import) reaches the wrong facet and dies at address 0x20.

The engine closes this at startup (``plat::lin::init``, #2720): one ``dlopen`` of
``libstdc++.so.6`` with ``RTLD_GLOBAL`` makes the system runtime the first definer, and every
copy that arrives later binds to it. These tests pin that:

1. an engine process has the system libstdc++ mapped from the start and in the global symbol
   scope, before any Python code runs;
2. the sequence that killed the task on staging survives in the engine: the jar's prebuilt
   binding loaded the way the JVM loads it (``RTLD_LOCAL``), then a GCC-built stream user;
3. the precondition: the jar's binding still exports a bundled libstdc++. When upstream stops
   doing that, this test says so, and the probes above can go.

The stream user ("trigger") needs nothing but the system ``libstdc++.so.6``: a
``std::ostringstream`` constructed and fed a ``long`` through the runtime's own exported
symbols, via ctypes; no compiler, no torch. Where torch is installed, the real importer runs
too.
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
    sys.platform != 'linux', reason='the GNU-unique hazard and the engine claim are Linux-only'
)

# Tests run on the engine's Python, so the engine directory is the interpreter's.
_ENGINE_DIR = Path(sys.executable).resolve().parent
_JAR_GLOB = 'sevenzipjbinding-all-platforms-*.jar'
_JAR_MEMBER = 'Linux-amd64/lib7-Zip-JBinding.so'

_STB_GNU_UNIQUE = 10
_SHN_UNDEF = 0
_SHT_DYNAMIC, _SHT_DYNSYM = 6, 11
_DT_NEEDED = 1
_STD_PREFIXES = ('_ZNSt', '_ZNKSt', '_ZSt', '_ZTVSt', '_ZTISt', '_ZTSSt', '_ZGVZNSt', '_ZGVNSt')


def _elf_exports_and_needed(path: Path) -> tuple[list[tuple[str, int]], list[str]]:
    """
    The defined dynamic symbols as ``(name, binding)`` and the ``DT_NEEDED`` entries of a
    little-endian ELF64 file.
    """
    data = path.read_bytes()
    assert data[:4] == b'\x7fELF' and data[4] == 2 and data[5] == 1, f'{path}: not a little-endian ELF64 file'
    shoff, shentsize, shnum = struct.unpack_from('<Q', data, 0x28)[0], *struct.unpack_from('<HH', data, 0x3A)
    sections = []
    for i in range(shnum):
        _name, sh_type, _flags, _addr, sh_offset, sh_size, sh_link, _info, _align, sh_entsize = struct.unpack_from(
            '<IIQQQQIIQQ', data, shoff + i * shentsize
        )
        sections.append((sh_type, sh_offset, sh_size, sh_link, sh_entsize))

    def strtab(index: int):
        _t, off, size, _l, _e = sections[index]
        table = data[off : off + size]
        return lambda pos: table[pos : table.index(b'\0', pos)].decode('ascii', 'replace')

    exports: list[tuple[str, int]] = []
    needed: list[str] = []
    for sh_type, off, size, link, entsize in sections:
        if sh_type == _SHT_DYNSYM:
            name_at = strtab(link)
            for pos in range(off, off + size, entsize or 24):
                st_name, st_info, _other, st_shndx = struct.unpack_from('<IBBH', data, pos)
                if st_shndx != _SHN_UNDEF and st_name:
                    exports.append((name_at(st_name), st_info >> 4))
        elif sh_type == _SHT_DYNAMIC:
            name_at = strtab(link)
            for pos in range(off, off + size, entsize or 16):
                d_tag, d_val = struct.unpack_from('<qQ', data, pos)
                if d_tag == _DT_NEEDED:
                    needed.append(name_at(d_val))
    return exports, needed


def _run(script: str, *args: str, tmp_path: Path, name: str) -> subprocess.CompletedProcess:
    """Run a probe script on the engine's Python; a crash shows as death by signal."""
    path = tmp_path / name
    path.write_text(script, encoding='utf-8')
    return subprocess.run(
        [sys.executable, str(path), *args],
        capture_output=True,
        text=True,
        timeout=600,
        cwd=str(_ENGINE_DIR),
        check=False,
    )


def _tail(result: subprocess.CompletedProcess) -> str:
    return f'exit {result.returncode}\n{result.stdout[-600:]}\n{result.stderr[-600:]}'


# ---------------------------------------------------------------------------
# 1. The claim itself
# ---------------------------------------------------------------------------

_SCOPE_PROBE = textwrap.dedent(
    '''
    """Is the system libstdc++ already in the process, and in the global symbol scope?"""
    import ctypes

    mapped = 'libstdc++.so.6' in open('/proc/self/maps').read()
    try:
        # dlsym(RTLD_DEFAULT): only a definition in the global scope answers, which is
        # what the engine's RTLD_GLOBAL dlopen puts there and a dependency loaded
        # RTLD_LOCAL does not.
        ctypes.CDLL(None)['_ZNSt8ios_base4InitC1Ev']
        in_global_scope = True
    except AttributeError:
        in_global_scope = False
    print('MAPPED', mapped, 'GLOBAL', in_global_scope, flush=True)
    '''
)


def test_engine_claims_the_system_libstdcxx_at_start(tmp_path):
    """Before any Python code runs, the engine has loaded libstdc++.so.6 with RTLD_GLOBAL (plat::lin::init)."""
    result = _run(_SCOPE_PROBE, tmp_path=tmp_path, name='probe_scope.py')
    assert result.returncode == 0, _tail(result)
    assert 'MAPPED True GLOBAL True' in result.stdout, (
        f'the engine did not claim the system libstdc++ at startup: {_tail(result)}'
    )


# ---------------------------------------------------------------------------
# 2. The crash sequence, in a subprocess
# ---------------------------------------------------------------------------

_TRIGGER_PROBE = textwrap.dedent(
    '''
    """Load a 7-Zip-JBinding the way the JVM does (RTLD_LOCAL), then run a GCC-built stream user."""
    import ctypes
    import os
    import sys

    lib, trigger = sys.argv[1], sys.argv[2]
    ctypes.CDLL(lib, os.RTLD_NOW | os.RTLD_LOCAL)
    print('BINDING_LOADED', flush=True)

    if trigger == 'torch':
        import torch  # noqa: F401  - prints operator schemas through std::ostream on import

        print('TRIGGER_OK torch', torch.__version__, flush=True)
    else:
        # The GNU runtime, as torch would bring it in; its static init builds the classic
        # locale. Then a std::ostringstream, constructed and fed through the runtime's own
        # exported symbols: std::ostream::_M_insert<long> -> use_facet<num_put<char>> ->
        # do_put, the frames at the top of the staging dumps. No compiler involved.
        libstdcxx = ctypes.CDLL('libstdc++.so.6', os.RTLD_NOW | os.RTLD_LOCAL)
        ctor = libstdcxx['_ZNSt7__cxx1119basic_ostringstreamIcSt11char_traitsIcESaIcEEC1Ev']
        insert_long = libstdcxx['_ZNSolsEl']
        dtor = libstdcxx['_ZNSt7__cxx1119basic_ostringstreamIcSt11char_traitsIcESaIcEED1Ev']
        for f in (ctor, dtor):
            f.argtypes = [ctypes.c_void_p]
            f.restype = None
        insert_long.argtypes = [ctypes.c_void_p, ctypes.c_long]
        insert_long.restype = ctypes.c_void_p
        stream = ctypes.create_string_buffer(4096)  # sizeof(std::ostringstream) is ~400 bytes
        addr = ctypes.addressof(stream)
        ctor(addr)
        insert_long(addr, 42)  # basic_ostringstream's first base is basic_ostream: this == addr
        dtor(addr)
        print('TRIGGER_OK stdcxx', flush=True)
    '''
)


def _survived(result: subprocess.CompletedProcess) -> bool:
    return result.returncode == 0 and 'TRIGGER_OK' in result.stdout


_TRIGGERS = [
    pytest.param('stdcxx', id='stdcxx'),
    pytest.param(
        'torch',
        id='torch',
        marks=pytest.mark.skipif(
            importlib.util.find_spec('torch') is None, reason='torch is not installed in the engine Python'
        ),
    ),
]


@pytest.fixture(scope='module')
def jar_prebuilt_binding(tmp_path_factory) -> Path:
    """The upstream prebuilt binding, extracted from the sevenzipjbinding-all-platforms jar as the JVM would."""
    jars = sorted((_ENGINE_DIR / 'java' / 'lib').glob(_JAR_GLOB))
    if not jars:
        pytest.skip(f'{_JAR_GLOB} not found under {_ENGINE_DIR / "java" / "lib"}')
    out = tmp_path_factory.mktemp('sevenzip-jar') / 'lib7-Zip-JBinding.so'
    with zipfile.ZipFile(jars[-1]) as jar:
        out.write_bytes(jar.read(_JAR_MEMBER))
    out.chmod(0o755)
    return out


@pytest.mark.parametrize('trigger', _TRIGGERS)
def test_jar_binding_then_stream_user_survives_in_the_engine(tmp_path, jar_prebuilt_binding, trigger):
    """The sequence that killed the task on staging, in an engine process: the claim went first."""
    result = _run(
        _TRIGGER_PROBE, str(jar_prebuilt_binding), trigger, tmp_path=tmp_path, name='probe_sevenzip_trigger.py'
    )
    assert _survived(result), _tail(result)


# ---------------------------------------------------------------------------
# 3. The precondition
# ---------------------------------------------------------------------------


def test_jar_prebuilt_binding_exports_a_bundled_libstdcxx(jar_prebuilt_binding):
    """What the claim protects against, measured on the jar's library."""
    exports, needed = _elf_exports_and_needed(jar_prebuilt_binding)
    std = [name for name, _b in exports if name.startswith(_STD_PREFIXES)]
    unique = [name for name, bind in exports if bind == _STB_GNU_UNIQUE]
    assert not any(lib.startswith('libstdc++') for lib in needed), 'upstream now links libstdc++ dynamically'
    assert len(std) > 1000 and unique, 'upstream stopped exporting its bundled libstdc++; these probes can go'
