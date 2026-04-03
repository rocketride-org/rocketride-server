"""Shared fixtures for nodes integration tests.

Installs lightweight stubs for ``rocketlib`` and ``ai.common.schema`` so that
resilience-module imports succeed without the C++ engine runtime.  The stubs
are installed at import time (before test collection) and cleaned up via a
session-scoped fixture after all tests complete.
"""

import sys
from pathlib import Path

import pytest

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

NODES_SRC = Path(__file__).resolve().parent.parent.parent / 'nodes' / 'src' / 'nodes'

# Module keys injected by the shim so we can clean them up later.
_SHIM_KEYS = [
    'rocketlib',
    'rocketlib.types',
    'ai',
    'ai.common',
    'ai.common.schema',
]

# ---------------------------------------------------------------------------
# Install stubs at import time so test module collection can import
# ``llm_base.resilience`` etc. without the real C++ runtime.
# ---------------------------------------------------------------------------

_saved_modules = {k: sys.modules[k] for k in _SHIM_KEYS if k in sys.modules}
_path_added = False

if str(NODES_SRC) not in sys.path:
    sys.path.insert(0, str(NODES_SRC))
    _path_added = True

if 'rocketlib' not in sys.modules:
    _mock_rocketlib = type(sys)('rocketlib')
    _mock_rocketlib.debug = lambda *a, **kw: None
    _mock_rocketlib.IInstanceBase = type('IInstanceBase', (), {})
    sys.modules['rocketlib'] = _mock_rocketlib

    _mock_rocketlib_types = type(sys)('rocketlib.types')
    _mock_rocketlib_types.IInvokeLLM = type('IInvokeLLM', (), {})
    sys.modules['rocketlib.types'] = _mock_rocketlib_types

if 'ai' not in sys.modules:
    _mock_ai = type(sys)('ai')
    sys.modules['ai'] = _mock_ai
    _mock_ai_common = type(sys)('ai.common')
    sys.modules['ai.common'] = _mock_ai_common
    _mock_ai_common_schema = type(sys)('ai.common.schema')
    _mock_ai_common_schema.Question = type('Question', (), {})
    _mock_ai_common_schema.Answer = type('Answer', (), {})
    sys.modules['ai.common.schema'] = _mock_ai_common_schema


# ---------------------------------------------------------------------------
# Session-scoped teardown to remove the shims after all tests run
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True, scope='session')
def _cleanup_node_stubs():
    """Remove shim modules after the test session to avoid polluting other tests."""
    yield
    for key in _SHIM_KEYS:
        if key in _saved_modules:
            sys.modules[key] = _saved_modules[key]
        else:
            sys.modules.pop(key, None)
    if _path_added:
        try:
            sys.path.remove(str(NODES_SRC))
        except ValueError:
            pass
