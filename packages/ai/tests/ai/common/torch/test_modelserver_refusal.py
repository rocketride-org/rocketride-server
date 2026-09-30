"""torch must stay out of a task process that has a model server.

Two rules: no node imports ``ai.common.torch`` (embedding goes through
``ai.common.models``, which proxies to the model server), and the wrapper
refuses before installing rather than after fetching the CUDA wheel, since the
guard is a ``sys.meta_path`` hook and never sees the install. The tests pin the
order, not just the exception.

The install functions are stubbed so nothing is ever fetched; ``rocketlib``
stays real because asking the guard imports the model zoo.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import pytest

WRAPPER = 'ai.common.torch'


def _nodes_root():
    """The nodes source tree, or None when running from a packaged layout."""
    for parent in Path(__file__).resolve().parents:
        candidate = parent / 'nodes' / 'src' / 'nodes'
        if candidate.is_dir():
            return candidate
    return None


def _wrapper_installs(calls):
    """Calls that would have fetched the CUDA wheel, ignoring ai.common's own."""
    return [c for c in calls if 'torch' in str(c[0])]


@pytest.fixture
def depends_calls(monkeypatch):
    """Record installs instead of performing them.

    Patches the real module rather than replacing it: the wrapper imports
    ``load_depends`` from it, and other modules on the import path need the
    rest of its surface.
    """
    calls = []
    import depends as depends_mod

    monkeypatch.setattr(depends_mod, 'depends', lambda *args, **kwargs: calls.append(args))
    monkeypatch.setattr(depends_mod, 'load_depends', lambda *args, **kwargs: calls.append(args))
    # Drop the wrapper so its module body runs again under this test's conditions.
    monkeypatch.delitem(sys.modules, WRAPPER, raising=False)
    return calls


def test_no_node_imports_the_torch_wrapper():
    """A node reaching ai.common.torch is unusable under --modelserver.

    Source-level: driving every beginGlobal would need the engine, and the rule
    should hold for nodes nobody has written yet.
    """
    nodes_root = _nodes_root()
    if nodes_root is None:
        pytest.skip('nodes source tree not present in this layout')

    pattern = re.compile(r'^\s*(?:import\s+ai\.common\.torch|from\s+ai\.common\.torch\s+import)', re.M)
    offenders = [
        str(path.relative_to(nodes_root))
        for path in nodes_root.rglob('*.py')
        if pattern.search(path.read_text(encoding='utf-8', errors='replace'))
    ]

    assert offenders == [], (
        'these nodes import the torch wrapper directly; use ai.common.models instead, '
        'which proxies to the model server when one is configured: ' + ', '.join(offenders)
    )


def test_refuses_before_installing_when_the_guard_is_active(monkeypatch, depends_calls):
    from ai.common.models import gpu_guard

    monkeypatch.setattr(sys, 'argv', ['engine', 'node.py', '--modelserver=localhost:5590'])
    # Copy meta_path so the hook goes away with the test; clear the once-only
    # flag so this test, not test order, controls installation.
    monkeypatch.setattr(sys, 'meta_path', list(sys.meta_path))
    monkeypatch.setattr(gpu_guard, '_installed', False)
    gpu_guard.install_gpu_guard()
    assert gpu_guard.is_installed()

    with pytest.raises(ImportError, match='blocked in model server mode'):
        __import__(WRAPPER)

    assert _wrapper_installs(depends_calls) == [], 'the CUDA wheel was fetched before the refusal'


def test_falls_through_when_the_guard_is_not_active(monkeypatch, depends_calls):
    """Without the hook the wrapper keeps its original path.

    Tolerates torch being absent: either way it must reach the install and must
    not raise the guard's error.
    """
    from ai.common.models import gpu_guard

    monkeypatch.setattr(sys, 'argv', ['engine', 'node.py'])
    assert not gpu_guard.is_installed()

    try:
        __import__(WRAPPER)
    except ImportError as exc:
        assert 'blocked in model server mode' not in str(exc)

    assert _wrapper_installs(depends_calls), 'the install was not reached'
