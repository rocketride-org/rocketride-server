# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Load the Wave node's modules from source for the tests in this directory.

The package is registered but its ``__init__`` is not executed: it imports the
engine glue (IGlobal, IInstance), and these tests need none of it. The modules
import ``rocketlib`` and ``ai.common``, so the fixture needs the engine's Python
(``./builder nodes:test``) and skips elsewhere.
"""

import importlib.util
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

_NODE_DIR = Path(__file__).resolve().parents[2] / 'src' / 'nodes' / 'agent_rocketride'
_PKG = 'agent_rocketride_under_test'
# Dependency order, so each relative import finds its target already loaded.
_MODULES = ('formatters', 'run_state', 'executor', 'planner', 'rocketride_agent')


def _load() -> SimpleNamespace:
    if f'{_PKG}.rocketride_agent' not in sys.modules:
        spec = importlib.util.spec_from_file_location(
            _PKG, _NODE_DIR / '__init__.py', submodule_search_locations=[str(_NODE_DIR)]
        )
        sys.modules[_PKG] = importlib.util.module_from_spec(spec)
        for name in _MODULES:
            path = _NODE_DIR / f'{name}.py'
            if not path.exists():
                continue
            sub = importlib.util.spec_from_file_location(f'{_PKG}.{name}', path)
            module = importlib.util.module_from_spec(sub)
            sys.modules[sub.name] = module
            sub.loader.exec_module(module)
    return SimpleNamespace(**{n: sys.modules[f'{_PKG}.{n}'] for n in _MODULES if f'{_PKG}.{n}' in sys.modules})


@pytest.fixture(scope='session')
def wave() -> SimpleNamespace:
    """The Wave node's modules, loaded from source: ``wave.planner``, ``wave.executor``, ``wave.rocketride_agent``."""
    pytest.importorskip('rocketlib', reason='needs the engine Python: ./builder nodes:test')
    return _load()
