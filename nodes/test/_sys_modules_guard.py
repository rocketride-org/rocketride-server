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

Pinned modules (``_PINNED_MODULES``) are imported once, when this module loads,
and must stay the same object for the whole session: numpy's C core initialises
once per process, so a numpy dropped from sys.modules cannot be imported again,
and a stub left in its place reaches every later importer. A stub ``depends``
left in its place turns every later ``depends()`` / ``load_depends()`` call into
a no-op, so a package installed on first use (torch, through
``ai.common.torch``) is never installed and its import fails. A stub ``engLib``
(the engine's C++ binding) reaches every module that first imports it later,
such as ``ai.common.ssl`` and ``ai.node``. They are checked at
collection time with the core modules and again after every test, once its
fixtures are torn down; a test that replaced or dropped one fails in teardown,
and the module is put back.
"""

from __future__ import annotations

import importlib
import importlib.machinery
import sys
from typing import Any, Dict, List, Tuple

import pytest

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
    a __file__ or a non-empty __path__, or is compiled into the interpreter (engLib
    inside the engine) and was loaded by BuiltinImporter. Hand-built stubs —
    types.ModuleType (even ones marked with __path__ = [] or built via
    module_from_spec), or MagicMock — have none of these.

    Args:
        mod (object): the sys.modules entry to classify.

    Returns:
        bool: True for a stub; False for a real module or None.
    """
    if mod is None:
        return False
    if type(mod).__name__ in ('MagicMock', 'Mock', 'NonCallableMagicMock'):
        return True
    if getattr(mod, '__file__', None) is not None:
        return False
    if getattr(getattr(mod, '__spec__', None), 'loader', None) is importlib.machinery.BuiltinImporter:
        return False
    return not getattr(mod, '__path__', None)


# Imported here, once, so every test module and every test sees the same object.
_PINNED_MODULES = ('numpy', 'depends', 'engLib')


def _import_pinned() -> Dict[str, Any]:
    """Import the pinned modules.

    Returns:
        Dict[str, Any]: module name -> module object, for each pinned module that
        is installed and is a real module (not a stub already in sys.modules).
    """
    pinned: Dict[str, Any] = {}
    for name in _PINNED_MODULES:
        try:
            mod = importlib.import_module(name)
        except ImportError:
            continue
        if not _is_stub_module(mod):
            pinned[name] = mod
    return pinned


# module name -> the object every test must leave in sys.modules
_pinned: Dict[str, Any] = _import_pinned()


def check_pinned() -> List[str]:
    """Put back each pinned module that sys.modules no longer holds.

    Returns:
        List[str]: names of the pinned modules that had been replaced or removed
        (empty if none).
    """
    changed = [name for name, mod in _pinned.items() if sys.modules.get(name) is not mod]
    for name in changed:
        sys.modules[name] = _pinned[name]
    return changed


def check_after_import(nodeid: str) -> List[str]:
    """Compare guarded modules against the snapshot; record + undo any leak.

    A core module counts as leaked when it is now a stub; a pinned module, when it
    is no longer the pinned object (a stub or removed).

    Args:
        nodeid (str): node id of the test module that was just imported.

    Returns:
        List[str]: the leaked module names (empty if clean). Pure helper so the
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
    if leaked:
        # Undo the leak so one offender does not cascade into every later module.
        for name in _GUARDED_CORE_MODULES:
            if base[name] is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = base[name]
    leaked += check_pinned()
    if leaked:
        _core_leaks.append((nodeid, leaked))
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


@pytest.hookimpl(wrapper=True)
def pytest_runtest_teardown(item, nextitem):  # noqa: ARG001
    """After a test and its fixtures are torn down, fail it if it replaced or dropped a pinned module.

    The module is put back first, so the next test starts with the real one.

    Args:
        item (pytest.Item): the test that just ran.
        nextitem (pytest.Item | None): the test that runs next (unused).

    Returns:
        object: what the inner teardown hooks returned.
    """
    try:
        result = yield
    except BaseException:
        check_pinned()  # the teardown error already fails this test
        raise
    changed = check_pinned()
    if changed:
        pytest.fail(
            f'sys.modules leak: {item.nodeid} replaced or removed {changed}; the real module was put back. '
            'Install a stand-in with monkeypatch.setitem(sys.modules, ...) or save/restore it around the import.',
            pytrace=False,
        )
    return result


def pytest_terminal_summary(terminalreporter):
    """Report modules leaked at import time (see #1640).

    Args:
        terminalreporter (TerminalReporter): pytest's terminal reporter.
    """
    for nodeid, leaked in _core_leaks:
        terminalreporter.write_line(
            f'sys.modules leak: {nodeid} left core modules {leaked} stubbed or removed. '
            'Snapshot and restore sys.modules around the node import (save/restore pattern).',
            red=True,
        )


def pytest_sessionfinish(session, exitstatus):  # noqa: ARG001
    """Fail the run when any test module leaked a core-module stub."""
    if _core_leaks:
        session.exitstatus = 1
