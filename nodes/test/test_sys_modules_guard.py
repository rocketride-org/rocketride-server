# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Tests for the sys.modules isolation guard itself (see #1640).

The guard has to name the module that actually leaked, undo the leak so it does
not cascade, and not blame an innocent module that restores correctly. These
exercise the collection-time helper directly.
"""

import importlib.util
import json
import sys
import types

import pytest

import _sys_modules_guard as guard


class Module:
    """Stand-in for pytest's Module collector; only its class name matters to the guard."""

    def __init__(self, nodeid):
        """Record the collector nodeid."""
        self.nodeid = nodeid


@pytest.fixture(autouse=True)
def _isolate_guard_state():
    """Run each test on clean guard state, then restore what real collection recorded.

    The guard's state is module-global and already holds any leaks found while
    collecting the real suite; snapshot and restore it so these tests never mask
    a genuine leak.
    """
    saved_baseline = dict(guard._core_baseline)
    saved_leaks = list(guard._core_leaks)
    guard._core_baseline.clear()
    guard._core_leaks.clear()
    yield
    guard._core_baseline.clear()
    guard._core_baseline.update(saved_baseline)
    guard._core_leaks.clear()
    guard._core_leaks.extend(saved_leaks)


def test_guard_flags_and_undoes_a_leaked_stub():
    """A module that stubs a core module at import and never restores is flagged and undone."""
    saved = sys.modules.get('rocketlib')
    nodeid = 'nodes/test/fake_leaker.py'
    guard.pytest_collectstart(Module(nodeid))
    sys.modules['rocketlib'] = types.ModuleType('rocketlib')  # leak at import time
    try:
        assert guard.check_after_import(nodeid) == ['rocketlib']
        assert guard._core_leaks == [(nodeid, ['rocketlib'])]
        assert sys.modules.get('rocketlib') is saved  # leak undone
    finally:
        if saved is None:
            sys.modules.pop('rocketlib', None)
        else:
            sys.modules['rocketlib'] = saved


def test_guard_ignores_a_module_that_restores():
    """A module that leaves sys.modules unchanged is not flagged."""
    nodeid = 'nodes/test/clean.py'
    guard.pytest_collectstart(Module(nodeid))
    assert guard.check_after_import(nodeid) == []
    assert guard._core_leaks == []


def test_guard_blames_the_leaker_not_an_earlier_clean_module():
    """A later module's leak is attributed to it, never to an earlier clean module."""
    guard.pytest_collectstart(Module('nodes/test/clean.py'))
    assert guard.check_after_import('nodes/test/clean.py') == []

    saved = sys.modules.get('rocketlib')
    guard.pytest_collectstart(Module('nodes/test/leaker.py'))
    sys.modules['rocketlib'] = types.ModuleType('rocketlib')
    try:
        guard.check_after_import('nodes/test/leaker.py')
        assert [n for n, _ in guard._core_leaks] == ['nodes/test/leaker.py']
    finally:
        if saved is None:
            sys.modules.pop('rocketlib', None)
        else:
            sys.modules['rocketlib'] = saved


def test_is_stub_module_detects_stub_built_via_module_from_spec():
    """A stub with a __spec__ but no __file__ is still a stub (guard heuristic)."""
    spec = importlib.util.spec_from_loader('fake_core', loader=None)
    mod = importlib.util.module_from_spec(spec)  # carries __spec__, no __file__
    assert guard._is_stub_module(mod) is True
    # a real module loaded from disk (has __file__) is not a stub
    assert guard._is_stub_module(json) is False
    assert guard._is_stub_module(None) is False
