# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Engine stand-ins shared by the tool_masky unit tests.

The node imports ``rocketlib`` and ``ai.common.*``, which only exist inside the
engine. ``scoped_stubs`` installs light stand-ins for them, points a ``tool_masky``
package at the node source, and on exit restores every ``sys.modules`` entry it
touched (including ``tool_masky.*`` imported by another test file), so file order
does not matter. Use it only around the node import; the stubs do not outlive it.

Taken from the real source rather than copied, so the tests cannot drift from the
engine:

* ``ai.common.utils.parse_bool`` (``config_utils.py``) and the ``tool_args``
  helpers (``normalize_tool_input``, ``require_*``, ``optional_*``).
* ``ai.common.tools.ToolsBase``, only with ``real_tools_base=True``; by default it is
  a plain base class. The ``rocketlib.filters`` stub (``APERR``, ``Ec``) exists so the
  real ``ToolsBase`` imports.
"""

from __future__ import annotations

import importlib.util
import json
import sys
import types
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[3]
_COMMON = _REPO_ROOT / 'packages' / 'ai' / 'src' / 'ai' / 'common'
NODE_DIR = _REPO_ROOT / 'nodes' / 'src' / 'nodes' / 'tool_masky'

STUB_MODULE_NAMES = (
    'rocketlib',
    'rocketlib.filters',
    'ai',
    'ai.common',
    'ai.common.utils',
    'ai.common.config',
    'ai.common.tools',
    'ai.common.avi',
    'ai.common.avi.descriptor',
    'depends',
    'requests',
    'tool_masky',
)

BEGIN, WRITE, END = 'BEGIN', 'WRITE', 'END'

# Recorders the lanes tests read; clear them in a fixture.
WARNINGS: list = []
FORWARDS: list = []

_TOOL_ARGS_NAMES = (
    'normalize_tool_input',
    'require_str',
    'require_int',
    'require_bool',
    'optional_bool',
    'optional_str',
    'optional_int',
)


class PreventDefault(Exception):
    """Raised by the stub ``IInstanceBase.preventDefault`` (the engine's version stops the chain)."""


class APERR(Exception):
    """Stand-in for ``rocketlib.filters.APERR``: ``APERR(ec, message)``."""

    def __init__(self, ec, message=''):
        super().__init__(message)
        self.ec = ec
        self.message = message


class Ec:
    PreventDefault = 'PreventDefault'


def _load_source(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# config_utils has no engine imports, so it loads standalone.
parse_bool = _load_source('_tool_masky_test_config_utils', _COMMON / 'utils' / 'config_utils.py').parse_bool


def check_credential_resolved(logicalType, field, value, connConfig=None):
    """Stand-in for ai.common.config.check_credential_resolved: rejects unfilled placeholders."""
    if isinstance(value, str) and ('${' in value or '<REDACTED>' in value):
        raise ValueError(f'{logicalType}.{field} is an unfilled placeholder')


class Config:
    @staticmethod
    def getNodeConfig(*_a, **_k):
        return {}


def make_requests() -> types.ModuleType:
    req = types.ModuleType('requests')
    req.RequestException = type('RequestException', (Exception,), {})
    req.Timeout = type('Timeout', (req.RequestException,), {})
    req.request = lambda *a, **k: None
    req.get = lambda *a, **k: None
    return req


def make_depends() -> types.ModuleType:
    dep = types.ModuleType('depends')
    dep.calls = []
    dep.load_depends = lambda path=None, *a, **k: dep.calls.append(path)
    return dep


def _forwarder(kind):
    def forward(instance, descriptor, mime, data, **kwargs):
        FORWARDS.append((kind, instance, descriptor, mime, data, kwargs))
        write = getattr(instance, f'write{kind}')
        write(BEGIN, mime, json.dumps({'size': len(data)}).encode())
        write(WRITE, mime, data)
        write(END, mime, b'')

    return forward


def _make_rocketlib() -> types.ModuleType:
    rl = types.ModuleType('rocketlib')

    class IInstanceBase:
        def preventDefault(self):
            raise PreventDefault()

    rl.IInstanceBase = IInstanceBase
    rl.IGlobalBase = type('IGlobalBase', (), {})
    rl.OPEN_MODE = type('OPEN_MODE', (), {'CONFIG': 'config', 'SOURCE': 'source'})
    rl.AVI_ACTION = type('AVI_ACTION', (), {'BEGIN': BEGIN, 'WRITE': WRITE, 'END': END})
    rl.debug = rl.error = lambda *a, **k: None
    rl.warning = lambda msg, *a, **k: WARNINGS.append(msg)

    filters = types.ModuleType('rocketlib.filters')
    filters.APERR = APERR
    filters.Ec = Ec
    rl.filters = filters
    sys.modules['rocketlib.filters'] = filters
    return rl


def install_stubs(*, real_tools_base: bool = False, stub_network: bool = True) -> types.SimpleNamespace:
    """Install the stand-ins into ``sys.modules`` and return handles the tests need."""
    sys.modules['rocketlib'] = _make_rocketlib()

    for name in ('ai', 'ai.common', 'ai.common.utils', 'ai.common.config', 'ai.common.tools', 'ai.common.avi'):
        sys.modules[name] = types.ModuleType(name)
    for name in ('ai', 'ai.common', 'ai.common.avi'):
        sys.modules[name].__path__ = []

    # tool_args binds ``from rocketlib import warning`` at load, so it loads after rocketlib is installed.
    utils = sys.modules['ai.common.utils']
    utils.parse_bool = parse_bool
    tool_args = _load_source('_tool_masky_test_tool_args', _COMMON / 'utils' / 'tool_args.py')
    for name in _TOOL_ARGS_NAMES:
        setattr(utils, name, getattr(tool_args, name))

    if real_tools_base:
        tools_base = _load_source('_tool_masky_test_tools', _COMMON / 'tools.py').ToolsBase
    else:
        tools_base = type('ToolsBase', (), {})
    sys.modules['ai.common.tools'].ToolsBase = tools_base

    cfg = sys.modules['ai.common.config']
    cfg.Config = Config
    cfg.check_credential_resolved = check_credential_resolved

    desc = types.ModuleType('ai.common.avi.descriptor')
    desc.forward_enriched_audio = _forwarder('Audio')
    desc.forward_enriched_video = _forwarder('Video')
    desc.forward_enriched_image = _forwarder('Image')
    sys.modules['ai.common.avi.descriptor'] = desc

    if stub_network:
        sys.modules['depends'] = make_depends()
        sys.modules['requests'] = make_requests()

    pkg = types.ModuleType('tool_masky')
    pkg.__path__ = [str(NODE_DIR)]
    sys.modules['tool_masky'] = pkg
    return types.SimpleNamespace(descriptor=desc, tools_base=tools_base)


def _node_modules() -> list[str]:
    return [k for k in sys.modules if k.startswith('tool_masky.')]


@contextmanager
def scoped_stubs(*, real_tools_base: bool = False, stub_network: bool = True) -> Iterator[types.SimpleNamespace]:
    """Install the stubs for the duration of the block, then restore ``sys.modules`` exactly.

    ``real_tools_base=True`` binds ``ai.common.tools.ToolsBase`` to the engine's real class.
    ``stub_network=False`` leaves ``requests`` and ``depends`` untouched (the live tests use
    the real library; import it before entering). Yields a namespace with ``descriptor``
    (the ``ai.common.avi.descriptor`` stub, for tests that re-install it per test) and ``tools_base``.
    """
    saved = {name: sys.modules.get(name) for name in (*STUB_MODULE_NAMES, *_node_modules())}
    for name in _node_modules():
        del sys.modules[name]
    try:
        yield install_stubs(real_tools_base=real_tools_base, stub_network=stub_network)
    finally:
        for name in _node_modules():
            del sys.modules[name]
        for name in {*STUB_MODULE_NAMES, *saved}:
            module = saved.get(name)
            if module is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module
