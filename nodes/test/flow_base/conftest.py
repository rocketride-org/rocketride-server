# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""Test setup for flow_base unit tests.

Adds `nodes/src/nodes` to `sys.path` so the flow_base package is
importable without loading the engine runtime (the normal
`nodes/__init__.py` requires `engLib` which is not available in a
pure-Python test env).
"""

from __future__ import annotations

import sys
import types
from pathlib import Path

_NODES_SRC = Path(__file__).resolve().parent.parent.parent / 'src'
if str(_NODES_SRC) not in sys.path:
    sys.path.insert(0, str(_NODES_SRC))


# `nodes/__init__.py` loads runtime deps via a `depends` helper that is
# only available inside the engine. Stub it so the package is importable
# in a plain pytest env.
def _install_depends_stub() -> None:
    if 'depends' in sys.modules:
        return
    stub = types.ModuleType('depends')
    stub.depends = lambda *_args, **_kwargs: None
    sys.modules['depends'] = stub


_install_depends_stub()


# `flow_if_else.IGlobal` and `.IInstance` pull in engine-only modules
# (`ai.common.config`, `rocketlib`). Stub the minimum surface these files
# touch at import time so the driver (which is pure-Python) can be tested
# without a full engine install.
def _install_engine_stubs() -> None:
    if 'ai' not in sys.modules:
        ai = types.ModuleType('ai')
        ai_common = types.ModuleType('ai.common')
        ai_common_config = types.ModuleType('ai.common.config')

        class _Config:  # minimal shape — tests override as needed
            @staticmethod
            def getNodeConfig(*_args, **_kwargs) -> dict:
                return {}

        ai_common_config.Config = _Config
        ai.common = ai_common
        ai_common.config = ai_common_config
        sys.modules['ai'] = ai
        sys.modules['ai.common'] = ai_common
        sys.modules['ai.common.config'] = ai_common_config

    if 'rocketlib' not in sys.modules:
        rocketlib = types.ModuleType('rocketlib')

        class _IInstanceBase:
            pass

        class _IGlobalBase:
            pass

        class _OpenMode:
            CONFIG = 'CONFIG'
            RUN = 'RUN'

        rocketlib.IInstanceBase = _IInstanceBase
        rocketlib.IGlobalBase = _IGlobalBase
        rocketlib.OPEN_MODE = _OpenMode
        sys.modules['rocketlib'] = rocketlib


_install_engine_stubs()
