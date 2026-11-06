# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Tests for the sys.modules isolation guard itself (see #1640).

The guard has to name the module that actually leaked, undo the leak so it does
not cascade, and not blame an innocent module that restores correctly. These
exercise the collection-time helper and the per-test teardown hook directly.
"""

import importlib.util
import json
import sys
import types
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from . import _sys_modules_guard as guard


class Module:
    """Stand-in for pytest's Module collector; only its class name matters to the guard."""

    def __init__(self, nodeid):
        """Record the collector nodeid."""
        self.nodeid = nodeid


class Item:
    """Stand-in for a pytest test item; the teardown hook reads only its nodeid."""

    def __init__(self, nodeid):
        """Record the item nodeid.

        Args:
            nodeid (str): the test's node id.
        """
        self.nodeid = nodeid


@pytest.fixture
def pinned_numpy():
    """The numpy the guard pinned; whatever a test does, sys.modules ends with it."""
    pytest.importorskip('numpy')
    assert 'numpy' in guard._pinned, 'numpy is installed but the guard did not pin it'
    real = guard._pinned['numpy']
    yield real
    sys.modules['numpy'] = real


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


def test_test_root_is_not_on_sys_path():
    """nodes/test must stay off sys.path (see #1687).

    Its subdirectories are named after node packages (text_output/, response/,
    telegram/, tool_git/, ...). With nodes/test on sys.path ahead of src/nodes,
    `import text_output` resolves to the *test* package, whose __path__ holds no
    node module — so every `from text_output.instance import ...` dies with
    ModuleNotFoundError. Import test-root helpers package-relative instead.
    """
    test_root = str(Path(__file__).resolve().parent)
    assert test_root not in sys.path, (
        f'{test_root} is on sys.path; it shadows node packages of the same name. '
        'Import test-root modules as `from .<mod> import ...` instead of inserting the dir.'
    )


def test_node_packages_resolve_under_src_nodes():
    """A node package imported by name resolves to src/nodes, not the same-named test dir."""
    nodes_src = Path(__file__).resolve().parent.parent / 'src' / 'nodes'
    while str(nodes_src) in sys.path:
        sys.path.remove(str(nodes_src))
    sys.path.insert(0, str(nodes_src))

    saved = sys.modules.pop('text_output', None)
    try:
        import text_output

        assert Path(text_output.__path__[0]).resolve() == (nodes_src / 'text_output').resolve()
    finally:
        sys.modules.pop('text_output', None)
        if saved is not None:
            sys.modules['text_output'] = saved


def test_is_stub_module_detects_stub_built_via_module_from_spec():
    """A stub with a __spec__ but no __file__ is still a stub (guard heuristic)."""
    spec = importlib.util.spec_from_loader('fake_core', loader=None)
    mod = importlib.util.module_from_spec(spec)  # carries __spec__, no __file__
    assert guard._is_stub_module(mod) is True
    # a real module loaded from disk (has __file__) is not a stub
    assert guard._is_stub_module(json) is False
    assert guard._is_stub_module(None) is False


def test_numpy_is_pinned_to_the_real_module(pinned_numpy):
    """The guard imports the real numpy once, and that is the numpy tests see.

    Args:
        pinned_numpy (module): the numpy the guard pinned.
    """
    assert not guard._is_stub_module(pinned_numpy)
    assert sys.modules['numpy'] is pinned_numpy


def test_setdefault_cannot_replace_the_pinned_numpy(pinned_numpy):
    """A setdefault call finds the pinned numpy already present, so nothing changes.

    Args:
        pinned_numpy (module): the numpy the guard pinned.
    """
    sys.modules.setdefault('numpy', MagicMock())
    assert sys.modules['numpy'] is pinned_numpy
    assert guard.check_pinned() == []


def test_collection_flags_and_undoes_a_numpy_stub(pinned_numpy):
    """A module that replaces numpy at import time is flagged, and numpy is put back.

    Args:
        pinned_numpy (module): the numpy the guard pinned.
    """
    nodeid = 'nodes/test/fake_numpy_leaker.py'
    guard.pytest_collectstart(Module(nodeid))
    sys.modules['numpy'] = MagicMock()
    assert guard.check_after_import(nodeid) == ['numpy']
    assert guard._core_leaks == [(nodeid, ['numpy'])]
    assert sys.modules['numpy'] is pinned_numpy


@pytest.mark.parametrize(
    'change',
    [
        pytest.param(lambda: sys.modules.__setitem__('numpy', MagicMock()), id='replaced-by-a-stub'),
        pytest.param(lambda: sys.modules.pop('numpy'), id='removed'),
    ],
)
def test_a_test_that_changes_numpy_fails_in_teardown(pinned_numpy, change):
    """A test that leaves numpy replaced or removed fails in teardown; the next test gets the real numpy.

    Args:
        pinned_numpy (module): the numpy the guard pinned.
        change (Callable[[], object]): replaces numpy with a stub or removes it.
    """
    teardown = guard.pytest_runtest_teardown(Item('nodes/test/test_leaker.py::test_it'), None)
    next(teardown)
    change()
    with pytest.raises(pytest.fail.Exception, match=r"test_leaker\.py::test_it replaced or removed \['numpy'\]"):
        teardown.send(None)
    assert sys.modules['numpy'] is pinned_numpy


def test_a_test_that_keeps_numpy_passes_teardown(pinned_numpy):
    """A test that ends with the pinned numpy passes teardown untouched.

    Args:
        pinned_numpy (module): the numpy the guard pinned.
    """
    teardown = guard.pytest_runtest_teardown(Item('nodes/test/test_clean.py::test_it'), None)
    next(teardown)
    with pytest.raises(StopIteration):
        teardown.send(None)
    assert sys.modules['numpy'] is pinned_numpy


def test_a_failing_teardown_keeps_its_error_and_numpy_is_put_back(pinned_numpy):
    """When a fixture's teardown fails, that error stands, and numpy is still put back.

    Args:
        pinned_numpy (module): the numpy the guard pinned.
    """
    teardown = guard.pytest_runtest_teardown(Item('nodes/test/test_leaker.py::test_it'), None)
    next(teardown)
    sys.modules['numpy'] = MagicMock()
    with pytest.raises(RuntimeError, match='fixture teardown failed'):
        teardown.throw(RuntimeError('fixture teardown failed'))
    assert sys.modules['numpy'] is pinned_numpy
