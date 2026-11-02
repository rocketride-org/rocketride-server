# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Tests for the embedding_video node's device guard (``IGlobal.device_lock``).

The guard follows the run mode, as in the vision nodes (#1350) and as #2821 proposes for
OCR: a real lock
for in-process inference, a no-op with ``--modelserver`` so the frames of videos
processed by different worker threads reach the model server together instead of
queueing here one frame at a time. (A single video's frames are embedded in order
either way.)

``IGlobal.py`` and ``IInstance.py`` are loaded by file path under a synthetic
package. The embedding model is stubbed and ``nodes.embedding_image.embedding`` is
replaced while ``beginGlobal`` imports it; OpenCV, the document schema and
``ai.common.models.base.make_device_lock`` are the real ones, and every test video
is written with OpenCV itself.

Usage:
    ./builder.cmd nodes:test --pytest-pattern=embedding_video --verbose
"""

import contextlib
import importlib.util
import sys
import threading
import time
import types
from pathlib import Path

import pytest

_PKG = '_embedding_video_lock_pkg_under_test'
_SRC = Path(__file__).parent.parent.parent / 'src' / 'nodes' / 'embedding_video'


def _load_node_modules() -> tuple:
    pkg = types.ModuleType(_PKG)
    pkg.__path__ = [str(_SRC)]
    sys.modules[_PKG] = pkg
    try:
        mods = []
        for name in ('IGlobal', 'IInstance'):
            spec = importlib.util.spec_from_file_location(f'{_PKG}.{name}', _SRC / f'{name}.py')
            mod = importlib.util.module_from_spec(spec)
            mod.__package__ = _PKG
            sys.modules[spec.name] = mod
            spec.loader.exec_module(mod)
            mods.append(mod)
        return tuple(mods)
    finally:
        for name in [n for n in sys.modules if n == _PKG or n.startswith(f'{_PKG}.')]:
            sys.modules.pop(name, None)


_iglobal_mod, _iinstance_mod = _load_node_modules()
IGlobal = _iglobal_mod.IGlobal
IInstance = _iinstance_mod.IInstance


class _Config:
    @staticmethod
    def getNodeConfig(*_a: object, **_kw: object) -> dict:
        # One frame per second of video; the test clips are two seconds long.
        return {'interval': 1, 'max_frames': 50}


class _StubEmbedding:
    """Stand-in for ``nodes.embedding_image.embedding.Embedding``; ``on_embed`` runs inside every call."""

    on_embed = staticmethod(lambda: None)
    model_name = 'stub/clip'

    def __init__(self, *_a: object, **_kw: object) -> None:
        pass

    def create_image_embedding(self, _image) -> list:
        type(self).on_embed()
        return [0.0, 1.0]


class _StubInstance:
    """Stand-in for the engine's instance object; ``DocMetadata`` reads the current object off it."""

    def __init__(self) -> None:
        self.documents: list = []
        self.currentObject = types.SimpleNamespace(
            objectId='obj-1', path='/clip.mp4', permissionId=0, componentId='embedding_video_1'
        )

    def writeDocuments(self, documents) -> None:
        self.documents.extend(documents)


def _mk(name: str, **attrs: object) -> types.ModuleType:
    m = types.ModuleType(name)
    for k, v in attrs.items():
        setattr(m, k, v)
    return m


@pytest.fixture
def make_global(monkeypatch):
    """Build an ``IGlobal`` through the real ``beginGlobal``, in the given run mode."""

    def _make(model_server: bool) -> IGlobal:
        argv = ['node.py'] + (['--modelserver=5590'] if model_server else [])
        monkeypatch.setattr(sys, 'argv', argv)
        monkeypatch.setattr(_iglobal_mod, 'Config', _Config)
        # beginGlobal imports the adapter from the sibling node; serve the stub instead.
        nodes_pkg = _mk('nodes')
        nodes_pkg.__path__ = []
        image_pkg = _mk('nodes.embedding_image')
        image_pkg.__path__ = []
        monkeypatch.setitem(sys.modules, 'nodes', nodes_pkg)
        monkeypatch.setitem(sys.modules, 'nodes.embedding_image', image_pkg)
        monkeypatch.setitem(
            sys.modules,
            'nodes.embedding_image.embedding',
            _mk('nodes.embedding_image.embedding', Embedding=_StubEmbedding),
        )

        glb = IGlobal.__new__(IGlobal)
        glb.IEndpoint = types.SimpleNamespace(endpoint=types.SimpleNamespace(bag={}, openMode='RUN'))
        glb.glb = types.SimpleNamespace(logicalType='embedding_video', connConfig={})
        glb.beginGlobal()
        return glb

    return _make


@pytest.fixture(scope='module')
def video_bytes() -> bytes:
    """A two-second 10 fps clip written by OpenCV, so frame extraction runs the real decode path."""
    import tempfile

    import numpy as np
    from ai.common.opencv import cv2

    with tempfile.TemporaryDirectory() as d:
        path = str(Path(d) / 'clip.mp4')
        writer = cv2.VideoWriter(path, cv2.VideoWriter_fourcc(*'mp4v'), 10.0, (64, 48))
        if not writer.isOpened():
            pytest.skip('OpenCV cannot write mp4v here')
        for i in range(20):
            frame = np.full((48, 64, 3), i * 12, dtype=np.uint8)
            writer.write(frame)
        writer.release()
        return Path(path).read_bytes()


def _embed_video(glb: IGlobal, data: bytes) -> list:
    """Run one clip through ``_process_video`` the way ``writeVideo`` END does."""
    node = IInstance.__new__(IInstance)
    node.IGlobal = glb
    node.IEndpoint = types.SimpleNamespace(endpoint=types.SimpleNamespace(jobConfig={'nodeId': 'embedding_video_1'}))
    node.instance = _StubInstance()
    node._frame_chunk_id = 0
    node._mime_type = 'video/mp4'
    node._source_descriptor = None
    node._process_video(data)
    return node.instance.documents


def _run_threads(n: int, glb: IGlobal, data: bytes) -> list:
    results: list = []
    errors: list = []

    def work() -> None:
        try:
            results.append(_embed_video(glb, data))
        except Exception as e:  # surfaced through the assert below
            errors.append(e)

    threads = [threading.Thread(target=work) for _ in range(n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=60)
    assert not errors, errors
    return results


def test_local_guard_is_a_lock(make_global) -> None:
    glb = make_global(model_server=False)
    assert isinstance(glb.device_lock, type(threading.Lock()))


def test_model_server_guard_is_a_no_op(make_global) -> None:
    glb = make_global(model_server=True)
    assert isinstance(glb.device_lock, contextlib.nullcontext)


def test_local_frame_embeddings_do_not_overlap(make_global, monkeypatch, video_bytes) -> None:
    """In-process inference: one ``create_image_embedding`` at a time across concurrent videos."""
    glb = make_global(model_server=False)
    state = {'active': 0, 'peak': 0, 'calls': 0}
    guard = threading.Lock()

    def on_embed() -> None:
        with guard:
            state['active'] += 1
            state['calls'] += 1
            state['peak'] = max(state['peak'], state['active'])
        time.sleep(0.02)
        with guard:
            state['active'] -= 1

    monkeypatch.setattr(_StubEmbedding, 'on_embed', staticmethod(on_embed))
    results = _run_threads(4, glb, video_bytes)

    assert [len(docs) for docs in results] == [2] * 4
    assert state['calls'] == 8
    assert state['peak'] == 1


def test_model_server_frame_embeddings_run_concurrently(make_global, monkeypatch, video_bytes) -> None:
    """Proxy mode: four videos' worker threads are inside the embedding call at the same time."""
    glb = make_global(model_server=True)
    barrier = threading.Barrier(4, timeout=30)
    monkeypatch.setattr(_StubEmbedding, 'on_embed', staticmethod(barrier.wait))

    results = _run_threads(4, glb, video_bytes)

    assert [len(docs) for docs in results] == [2] * 4
    assert all(doc.embedding == [0.0, 1.0] for docs in results for doc in docs)
