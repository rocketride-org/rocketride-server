# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Load the Wave node's modules from source, without the engine glue.

The package is registered but its ``__init__`` is not executed: it imports the
engine glue (IGlobal, IInstance), and the tests need none of it. The modules
import ``rocketlib`` and ``ai.common``, so this needs the engine's Python.
The ``wave`` fixture in conftest.py, the eager prompt scenarios and the bench
all load the modules through this one function, so they share one copy.
"""

import importlib.util
import sys
from pathlib import Path
from types import SimpleNamespace

_NODE_DIR = Path(__file__).resolve().parents[2] / 'src' / 'nodes' / 'agent_rocketride'
_PKG = 'agent_rocketride_under_test'
# Dependency order, so each relative import finds its target already loaded.
_MODULES = ('formatters', 'run_state', 'executor', 'planner', 'rocketride_agent')


def load_wave_modules() -> SimpleNamespace:
    """Return the node's modules: ``.planner``, ``.executor``, ``.rocketride_agent`` and the rest."""
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
