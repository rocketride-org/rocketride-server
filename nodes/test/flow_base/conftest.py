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
