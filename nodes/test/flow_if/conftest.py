# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""Test setup for flow_if — see flow_base/conftest.py for rationale."""

from __future__ import annotations

import sys
import types
from pathlib import Path

_NODES_SRC = Path(__file__).resolve().parent.parent.parent / 'src'
if str(_NODES_SRC) not in sys.path:
    sys.path.insert(0, str(_NODES_SRC))


def _install_depends_stub() -> None:
    if 'depends' in sys.modules:
        return
    stub = types.ModuleType('depends')
    stub.depends = lambda *_args, **_kwargs: None
    sys.modules['depends'] = stub


_install_depends_stub()


# The engine runtime provides `rocketlib`; unit tests don't load it.
# Inject a minimal stub so importing flow_if.IGlobal / IInstance works
# without dragging the full engine in. Only the attributes touched at
# import time need to exist — methods are exercised through subclasses.
def _install_rocketlib_stub() -> None:
    if 'rocketlib' in sys.modules:
        return
    stub = types.ModuleType('rocketlib')

    class IGlobalBase:
        profile: dict = {}
        IEndpoint = None

    class IInstanceBase:
        IGlobal = None
        instance = None

        def preventDefault(self) -> None:
            raise RuntimeError('PreventDefault')

    class _OpenMode:
        CONFIG = 'config'
        RUN = 'run'

    stub.IGlobalBase = IGlobalBase
    stub.IInstanceBase = IInstanceBase
    stub.OPEN_MODE = _OpenMode
    sys.modules['rocketlib'] = stub


_install_rocketlib_stub()
