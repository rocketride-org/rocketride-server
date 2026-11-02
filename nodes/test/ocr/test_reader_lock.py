# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Tests for the OCR node's reader guard (``IGlobal.readerLock``).

The guard follows the run mode, as in the other vision nodes: a real lock for
in-process inference, a no-op with ``--modelserver`` so concurrent worker threads
reach the model server's batcher instead of queueing one image at a time.

``IGlobal.py`` and ``IInstance.py`` are loaded by file path under a synthetic
package. Their heavy imports (``depends``, OpenCV, img2table, the OCR engines) are
stubbed; ``ai.common.models.base.make_device_lock`` is the real one.

Usage:
    ./builder.cmd nodes:test --pytest-pattern=ocr --verbose
"""

import contextlib
import importlib.util
import sys
import threading
import time
import types
from pathlib import Path
from typing import Iterator

import pytest

from rocketlib import AVI_ACTION

_PKG = '_ocr_lock_pkg_under_test'
_SRC = Path(__file__).parent.parent.parent / 'src' / 'nodes' / 'ocr'

_LOAD_STUBS = (
    'numpy',
    'PIL',
    'PIL.Image',
    'depends',
    'ai.common.opencv',
    'img2table',
    'img2table.ocr',
    'img2table.ocr._types',
)


def _mk(name: str, **attrs: object) -> types.ModuleType:
    m = types.ModuleType(name)
    for k, v in attrs.items():
        setattr(m, k, v)
    return m


def _pkg(name: str) -> types.ModuleType:
    m = _mk(name)
    m.__path__ = []
    return m


@contextlib.contextmanager
def _scoped_load_stubs() -> Iterator[None]:
    """Stub the module-level imports of ``IGlobal.py`` / ``IInstance.py`` while loading them."""
    snapshot = {name: sys.modules.get(name) for name in _LOAD_STUBS}
    pil = _pkg('PIL')
    pil.Image = _mk('PIL.Image', open=lambda *a, **kw: None)
    sys.modules.update(
        {
            'numpy': _mk('numpy', array=lambda *a, **kw: None, ndarray=object),
            'PIL': pil,
            'PIL.Image': pil.Image,
            'depends': _mk('depends', depends=lambda *a, **kw: None),
            'ai.common.opencv': _mk('ai.common.opencv', cv2=object()),
            'img2table': _pkg('img2table'),
            'img2table.ocr': _pkg('img2table.ocr'),
            'img2table.ocr._types': _mk('img2table.ocr._types', OCRInstance=object),
        }
    )
    try:
        yield
    finally:
        for name, mod in snapshot.items():
            if mod is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = mod


def _load(name: str) -> types.ModuleType:
    spec = importlib.util.spec_from_file_location(f'{_PKG}.{name}', _SRC / f'{name}.py')
    mod = importlib.util.module_from_spec(spec)
    mod.__package__ = _PKG
    sys.modules[f'{_PKG}.{name}'] = mod
    spec.loader.exec_module(mod)
    return mod


with _scoped_load_stubs():
    sys.modules[_PKG] = _pkg(_PKG)
    _iglobal_mod = _load('IGlobal')
    _iinstance_mod = _load('IInstance')
    for _name in (_PKG, f'{_PKG}.IGlobal', f'{_PKG}.IInstance'):
        sys.modules.pop(_name, None)

IGlobal = _iglobal_mod.IGlobal
IInstance = _iinstance_mod.IInstance


class _Config:
    @staticmethod
    def getNodeConfig(*_a: object, **_kw: object) -> dict:
        return {}


class _StubReader:
    """Stand-in for ``ocr.Reader``; ``on_read`` runs inside every ``read`` call."""

    on_read = staticmethod(lambda: None)

    def __init__(self, *_a: object, **_kw: object) -> None:
        pass

    def read(self, image_data) -> str:
        type(self).on_read()
        return 'text'


class _NoTables:
    def __init__(self, *_a: object, **_kw: object) -> None:
        pass

    def extract_tables(self, **_kw: object) -> list:
        return []


class _StubInstance:
    def __init__(self) -> None:
        self.texts: list = []

    def writeText(self, text) -> None:
        self.texts.append(text)

    def writeTable(self, table) -> None:
        pass


@pytest.fixture
def make_global(monkeypatch):
    """Build an ``IGlobal`` through the real ``beginGlobal``, in the given run mode."""

    def _make(model_server: bool) -> IGlobal:
        argv = ['node.py'] + (['--modelserver=5590'] if model_server else [])
        monkeypatch.setattr(sys, 'argv', argv)
        monkeypatch.setattr(_iglobal_mod, 'Config', _Config)
        monkeypatch.setitem(sys.modules, _PKG, _pkg(_PKG))
        monkeypatch.setitem(sys.modules, f'{_PKG}.ocr', _mk(f'{_PKG}.ocr', Reader=_StubReader, SCRIPT_FAMILIES={}))
        monkeypatch.setitem(sys.modules, 'img2table', _pkg('img2table'))
        monkeypatch.setitem(sys.modules, 'img2table.document', _mk('img2table.document', Image=_NoTables))

        glb = IGlobal.__new__(IGlobal)
        glb.IEndpoint = types.SimpleNamespace(endpoint=types.SimpleNamespace(bag={}))
        glb.glb = types.SimpleNamespace(logicalType='ocr', connConfig={})
        glb.beginGlobal()
        return glb

    return _make


def _ocr_image(glb: IGlobal) -> list:
    """Run one image through ``writeImage`` the way the engine does: BEGIN, WRITE, END."""
    node = IInstance.__new__(IInstance)
    node.IGlobal = glb
    node.instance = _StubInstance()
    node.writeImage(AVI_ACTION.BEGIN, 'image/png', b'')
    node.writeImage(AVI_ACTION.WRITE, 'image/png', b'png-bytes')
    node.writeImage(AVI_ACTION.END, 'image/png', b'')
    return node.instance.texts


def _run_threads(n: int, glb: IGlobal) -> list:
    results: list = []
    errors: list = []

    def work() -> None:
        try:
            results.append(_ocr_image(glb))
        except Exception as e:  # surfaced through the assert below
            errors.append(e)

    threads = [threading.Thread(target=work) for _ in range(n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=30)
    assert not errors, errors
    return results


def test_local_guard_is_a_lock(make_global) -> None:
    glb = make_global(model_server=False)
    assert isinstance(glb.readerLock, type(threading.Lock()))


def test_model_server_guard_is_a_no_op(make_global) -> None:
    glb = make_global(model_server=True)
    assert isinstance(glb.readerLock, contextlib.nullcontext)


def test_local_reads_do_not_overlap(make_global, monkeypatch) -> None:
    """In-process inference: one ``read`` at a time, whatever the number of worker threads."""
    glb = make_global(model_server=False)
    state = {'active': 0, 'peak': 0}
    guard = threading.Lock()

    def on_read() -> None:
        with guard:
            state['active'] += 1
            state['peak'] = max(state['peak'], state['active'])
        time.sleep(0.05)
        with guard:
            state['active'] -= 1

    monkeypatch.setattr(_StubReader, 'on_read', staticmethod(on_read))
    results = _run_threads(4, glb)

    assert results == [['text']] * 4
    assert state['peak'] == 1


def test_model_server_reads_run_concurrently(make_global, monkeypatch) -> None:
    """Proxy mode: worker threads are inside ``read`` at the same time (a node lock would break the barrier)."""
    glb = make_global(model_server=True)
    barrier = threading.Barrier(4, timeout=10)
    monkeypatch.setattr(_StubReader, 'on_read', staticmethod(barrier.wait))

    results = _run_threads(4, glb)

    assert results == [['text']] * 4
