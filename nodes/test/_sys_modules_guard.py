# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Regression guard for sys.modules isolation in node tests (see #1640).

Node tests stub rocketlib/ai/pydantic/etc so a node imports without the engine.
Those stubs are installed at IMPORT time, and pytest imports every test module
during collection — before any test runs. So the check runs at collection time
(right after each module is imported): snapshot the guarded modules in
``pytest_collectstart`` (just before the import) and compare in
``pytest_collectreport`` (just after). A teardown-time check would blame whichever
module happens to finish while a later module's leak is already in sys.modules.

Each detected leak is undone so one offender does not cascade into N false
failures. Leaks are recorded and the run is failed at session finish — raising
inside a collection hook gives pytest INTERNALERROR and kills the run.
"""

from __future__ import annotations

import sys
from typing import Any, Dict, List, Tuple

_GUARDED_CORE_MODULES = (
    'rocketlib',
    'ai',
    'ai.common',
    'ai.common.config',
    'ai.common.utils',
    'ai.common.schema',
    'ai.common.store',
    'pydantic',
    'requests',
    'requests.exceptions',
    'tenacity',
)

# nodeid -> {module name: object present before the module was imported}
_core_baseline: Dict[str, Dict[str, Any]] = {}
# (nodeid, [leaked module names]) recorded during collection
_core_leaks: List[Tuple[str, List[str]]] = []


def _is_stub_module(mod) -> bool:
    """True when mod is a hand-built stub/MagicMock, not the real imported module.

    A real module (or non-empty namespace package) is loaded from disk and carries
    a __file__ or a non-empty __path__. Hand-built stubs — types.ModuleType (even
    ones marked with __path__ = [] or built via module_from_spec), or MagicMock —
    carry neither.
    """
    if mod is None:
        return False
    if type(mod).__name__ in ('MagicMock', 'Mock', 'NonCallableMagicMock'):
        return True
    if getattr(mod, '__file__', None) is not None:
        return False
    return not getattr(mod, '__path__', None)


def check_after_import(nodeid: str) -> List[str]:
    """Compare guarded modules against the snapshot; record + undo any leaked stub.

    Returns the list of leaked module names (empty if clean). Pure helper so the
    guard is unit-testable without a full pytest sub-session.
    """
    base = _core_baseline.pop(nodeid, None)
    if base is None:
        return []
    leaked = [
        name
        for name in _GUARDED_CORE_MODULES
        if sys.modules.get(name) is not base[name] and _is_stub_module(sys.modules.get(name))
    ]
    if not leaked:
        return []
    _core_leaks.append((nodeid, leaked))
    # Undo the leak so one offender does not cascade into every later module.
    for name in _GUARDED_CORE_MODULES:
        if base[name] is None:
            sys.modules.pop(name, None)
        else:
            sys.modules[name] = base[name]
    return leaked


# ---------------------------------------------------------------------------
# pytest hooks (registered by importing them into conftest.py)
# ---------------------------------------------------------------------------


def pytest_collectstart(collector):
    """Snapshot the guarded modules just before a test module is imported."""
    if type(collector).__name__ == 'Module':
        _core_baseline[collector.nodeid] = {name: sys.modules.get(name) for name in _GUARDED_CORE_MODULES}


def pytest_collectreport(report):
    """Right after a test module is imported, record and undo any stub it left behind."""
    check_after_import(report.nodeid)


def pytest_terminal_summary(terminalreporter):
    """Report leaked core-module stubs (see #1640)."""
    for nodeid, leaked in _core_leaks:
        terminalreporter.write_line(
            f'sys.modules leak: {nodeid} left stub core modules {leaked}. '
            'Snapshot and restore sys.modules around the node import (save/restore pattern).',
            red=True,
        )


def pytest_sessionfinish(session, exitstatus):  # noqa: ARG001
    """Fail the run when any test module leaked a core-module stub."""
    if _core_leaks:
        session.exitstatus = 1
