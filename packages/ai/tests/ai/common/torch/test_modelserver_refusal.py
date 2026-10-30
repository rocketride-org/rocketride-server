"""torch must stay out of a task process that has a model server.

Two rules: no node imports torch (embedding goes through ``ai.common.models``,
which proxies to the model server), and the wrapper refuses before installing
rather than after fetching the CUDA wheel, since the guard is a
``sys.meta_path`` hook and never sees the install. The tests pin the order, not
just the exception.

The install functions are stubbed so nothing is ever fetched; ``rocketlib``
stays real because asking the guard imports the model zoo.
"""

from __future__ import annotations

import ast
import sys
from pathlib import Path

import pytest

WRAPPER = 'ai.common.torch'
_WRAPPER_PARENT, _WRAPPER_LEAF = WRAPPER.rsplit('.', 1)


def _nodes_root():
    """The nodes source tree, or None when running from a packaged layout."""
    for parent in Path(__file__).resolve().parents:
        candidate = parent / 'nodes' / 'src' / 'nodes'
        if candidate.is_dir():
            return candidate
    return None


def _is_torch(name: str) -> bool:
    return name in (WRAPPER, 'torch') or name.startswith((WRAPPER + '.', 'torch.'))


def _imports_torch(source: str) -> bool:
    """True when this source imports torch, through the wrapper or directly.

    AST rather than a regex: ``from ai.common import torch`` is the same
    wrapper under another spelling, and import-like text in a docstring is not
    an import.
    """
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return False
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            if any(_is_torch(alias.name) for alias in node.names):
                return True
        elif isinstance(node, ast.ImportFrom) and node.level == 0:
            module = node.module or ''
            if _is_torch(module):
                return True
            if module == _WRAPPER_PARENT and any(alias.name == _WRAPPER_LEAF for alias in node.names):
                return True
    return False


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


def test_no_node_imports_torch():
    """A node that imports torch is unusable under --modelserver.

    Source-level: driving every beginGlobal would need the engine, and the rule
    should hold for nodes nobody has written yet.
    """
    nodes_root = _nodes_root()
    if nodes_root is None:
        pytest.skip('nodes source tree not present in this layout')

    offenders = [
        str(path.relative_to(nodes_root))
        for path in nodes_root.rglob('*.py')
        if _imports_torch(path.read_text(encoding='utf-8', errors='replace'))
    ]

    assert offenders == [], (
        'these nodes import torch directly; use ai.common.models instead, which proxies to the '
        'model server when one is configured: ' + ', '.join(offenders)
    )


@pytest.mark.parametrize(
    'source',
    [
        'import ai.common.torch',
        'import ai.common.torch  # noqa: F401',
        'import ai.common.torch as wrapper',
        'from ai.common.torch import torch',
        'from ai.common import torch',
        'import torch',
        'from torch import nn',
    ],
)
def test_the_scan_catches_every_spelling(source):
    """The invariant is only worth as much as the detector behind it."""
    assert _imports_torch(source)


@pytest.mark.parametrize(
    'source',
    [
        'from ai.common.models.vision import CLIPModel, ViTModel',
        '"""import ai.common.torch here is prose, not an import."""',
        "name = 'import torch'",
        'from ai.common.image.image import Image',
    ],
)
def test_the_scan_ignores_text_that_is_not_an_import(source):
    assert not _imports_torch(source)


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


def test_shared_host_alone_installs_no_guard(monkeypatch):
    """--shared-host is about the host, not the hosted rules: torch stays allowed."""
    from ai.common.models import gpu_guard

    monkeypatch.setattr(sys, 'argv', ['engine', 'node.py', '--shared-host'])
    monkeypatch.setattr(sys, 'meta_path', list(sys.meta_path))
    monkeypatch.setattr(gpu_guard, '_installed', False)
    monkeypatch.setattr(gpu_guard, '_reason', None)
    monkeypatch.setattr(gpu_guard, 'get_model_server_address', lambda: None)

    gpu_guard.install_gpu_guard()

    assert not gpu_guard.is_installed()


def _install_hosted_guard(monkeypatch, gpu_guard):
    """A hosted engine's task with no model server, as on staging."""
    monkeypatch.setattr(sys, 'argv', ['engine', 'node.py', '--hosted'])
    monkeypatch.setattr(sys, 'meta_path', list(sys.meta_path))
    monkeypatch.setattr(gpu_guard, '_installed', False)
    monkeypatch.setattr(gpu_guard, '_reason', None)
    gpu_guard.install_gpu_guard()
    assert gpu_guard.is_installed()


def test_hosted_engine_refuses_torch_without_a_model_server(monkeypatch, depends_calls):
    """A hosted engine never installs torch, model server or not (#2681)."""
    from ai.common.models import gpu_guard

    _install_hosted_guard(monkeypatch, gpu_guard)

    with pytest.raises(ImportError, match='not available on RocketRide Cloud'):
        __import__(WRAPPER)
    # sys.modules is consulted before sys.meta_path: drop a torch an earlier test loaded
    for name in [m for m in sys.modules if m == 'torch' or m.startswith('torch.')]:
        monkeypatch.delitem(sys.modules, name)
    with pytest.raises(ImportError, match='not available on RocketRide Cloud'):
        __import__('torch')

    assert _wrapper_installs(depends_calls) == [], 'the CUDA wheel was fetched before the refusal'


def test_hosted_engine_model_loader_installs_nothing(monkeypatch, depends_calls):
    """A local model loader on a hosted engine stops before its own requirements.

    sentence-transformers pulls torch in as a dependency, so refusing at the
    import alone would still leave torch on disk.
    """
    from ai.common.models import gpu_guard
    from ai.common.models.transformers.sentence_transformers import SentenceTransformerLoader

    _install_hosted_guard(monkeypatch, gpu_guard)
    monkeypatch.setattr(SentenceTransformerLoader, '_dependencies_loaded', False)

    with pytest.raises(ImportError, match='not available on RocketRide Cloud'):
        SentenceTransformerLoader._ensure_dependencies()

    # ai.common.ssl may install its own requirement first; that one is fine.
    model_installs = [c for c in depends_calls if 'sentence_transformers' in str(c[0]) or 'torch' in str(c[0])]
    assert model_installs == [], 'the loader installed its requirements before the refusal'
