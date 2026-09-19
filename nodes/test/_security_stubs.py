# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Shared engine stubs for the security node suites (input_prescreen, trust_boundary).

Both node packages pull the engine surface in at package-import time
(``__init__`` -> IGlobal/IInstance -> rocketlib, ai.common.*), so the stubs have to
be in place before the test modules are imported. Each suite installs them from its
own ``conftest.py``, which pytest loads before collecting that directory.

Import this package-relative (``from .._security_stubs import install_security_stubs``);
never put nodes/test on sys.path, or its node-named subdirectories shadow the real
node packages under src/nodes (see #1687).
"""

from __future__ import annotations

import pathlib
import sys
import types
from unittest.mock import MagicMock

# nodes/src/nodes — the import root for `input_prescreen` / `trust_boundary`.
_NODES_SRC = str(pathlib.Path(__file__).resolve().parent.parent / 'src' / 'nodes')


class InterceptionPointStub:
    """Stub for crewai.security.InterceptionPoint."""

    PRE_TOOL_CALL = 'pre_tool_call'
    EXECUTION_START = 'execution_start'


class HookAbortedStub(Exception):
    """Stub for crewai.security.HookAborted."""

    def __init__(self, reason='', source=''):
        self.reason = reason
        self.source = source
        super().__init__(reason)


def _on_stub(interception_point):  # noqa: ARG001 — mirrors the real decorator's signature
    """Stub for crewai.security.on — returns the decorated method unchanged."""

    def decorator(func):
        return func

    return decorator


def _install_rocketlib() -> None:
    """Stub the rocketlib base classes the security nodes subclass."""
    rocketlib = types.ModuleType('rocketlib')
    rocketlib.IGlobalBase = object
    rocketlib.IInstanceBase = object
    rocketlib.Entry = object
    rocketlib.OPEN_MODE = MagicMock()
    rocketlib.warning = lambda msg: None  # silent in tests
    rocketlib.debug = lambda msg: None
    sys.modules.setdefault('rocketlib', rocketlib)


def _install_ai_common() -> None:
    """Stub the ai.common.schema / ai.common.config surface the nodes import."""
    sys.modules.setdefault('ai', types.ModuleType('ai'))
    sys.modules.setdefault('ai.common', types.ModuleType('ai.common'))

    ai_schema = types.ModuleType('ai.common.schema')
    ai_schema.Question = MagicMock
    ai_schema.Answer = MagicMock
    sys.modules.setdefault('ai.common.schema', ai_schema)

    ai_config = types.ModuleType('ai.common.config')
    ai_config.Config = MagicMock()
    sys.modules.setdefault('ai.common.config', ai_config)


def _install_crewai() -> None:
    """Stub crewai.security, which trust_boundary imports behind a try/except."""
    sys.modules.setdefault('crewai', types.ModuleType('crewai'))

    crewai_security = types.ModuleType('crewai.security')
    crewai_security.on = _on_stub
    crewai_security.InterceptionPoint = InterceptionPointStub
    crewai_security.HookAborted = HookAbortedStub
    sys.modules.setdefault('crewai.security', crewai_security)


def install_security_stubs() -> None:
    """Install the engine stubs and make src/nodes importable. Idempotent."""
    _install_rocketlib()
    _install_ai_common()
    sys.modules.setdefault('depends', MagicMock())
    _install_crewai()

    if _NODES_SRC not in sys.path:
        sys.path.insert(0, _NODES_SRC)
