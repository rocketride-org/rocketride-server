# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Unit tests for the face_detection node's missing-system-library handling.

Verifies that when MediaPipe's native lib can't dlopen a system dep (e.g.
``libGLESv2.so.2``), the node re-raises an actionable error. The lib is never
actually removed — a synthetic ``OSError`` is fed to the mapping and
``create_from_options`` is stubbed to raise. The node is loaded by file path
with ``depends`` / ``ai.common.config`` stubbed, so no engine venv or mediapipe
install is needed.

Usage: ./builder nodes:test --pytest-pattern=face_detection
"""

import contextlib
import importlib.util
import sys
import tempfile
import types
from pathlib import Path
from typing import Iterator

import pytest

_MODULE_PATH = Path(__file__).parent.parent.parent / 'src' / 'nodes' / 'face_detection' / 'face_detection.py'
_STUB_NAMES = ('ai', 'ai.common', 'ai.common.config', 'depends')


class _Config:
    """Stand-in for ``ai.common.config.Config`` (only ``getNodeConfig`` is called)."""

    @staticmethod
    def getNodeConfig(*_a: object, **_kw: object) -> dict:
        return {}


def _install_min_stubs() -> None:
    """Plant just-enough fake modules so the node's top-level imports resolve."""
    depends = types.ModuleType('depends')
    depends.load_depends = lambda *_a, **_kw: None
    depends.model_cache_dir = lambda *_a, **_kw: tempfile.gettempdir()
    sys.modules['depends'] = depends

    ai = types.ModuleType('ai')
    ai.__path__ = []  # mark as package so sub-imports resolve
    sys.modules['ai'] = ai
    ai_common = types.ModuleType('ai.common')
    ai_common.__path__ = []
    sys.modules['ai.common'] = ai_common
    ai_config = types.ModuleType('ai.common.config')
    ai_config.Config = _Config
    sys.modules['ai.common.config'] = ai_config


@contextlib.contextmanager
def _scoped_stubs() -> Iterator[None]:
    """Install stub modules for the block, restoring sys.modules on exit."""
    snapshot = {name: sys.modules.get(name) for name in _STUB_NAMES}
    _install_min_stubs()
    try:
        yield
    finally:
        for name, mod in snapshot.items():
            if mod is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = mod


with _scoped_stubs():
    _spec = importlib.util.spec_from_file_location('_face_detection_direct', _MODULE_PATH)
    _mod = importlib.util.module_from_spec(_spec)
    _spec.loader.exec_module(_mod)

FaceDetector = _mod.FaceDetector


# ---------------------------------------------------------------------------
# _missing_lib_error mapping
# ---------------------------------------------------------------------------


def test_missing_lib_error_known_soname_gives_install_hint():
    err = FaceDetector._missing_lib_error(
        OSError('libGLESv2.so.2: cannot open shared object file: No such file or directory')
    )
    assert isinstance(err, RuntimeError)
    msg = str(err)
    assert 'libGLESv2.so.2' in msg
    assert 'apt-get install -y libgles2' in msg


def test_missing_lib_error_unknown_soname_falls_back_to_generic():
    err = FaceDetector._missing_lib_error(
        OSError('libfoo.so.7: cannot open shared object file: No such file or directory')
    )
    assert isinstance(err, RuntimeError)
    assert 'libfoo.so.7' in str(err)


def test_missing_lib_error_unrelated_oserror_passes_through():
    original = OSError('some unrelated failure')
    assert FaceDetector._missing_lib_error(original) is original


# ---------------------------------------------------------------------------
# _build_detector re-raises the friendly error (simulating libGLESv2 absent)
# ---------------------------------------------------------------------------


def _stub_mediapipe(create_from_options):
    """Minimal mediapipe stubs so _build_detector's lazy imports resolve."""
    mp = types.ModuleType('mediapipe')
    mp.__path__ = []
    tasks = types.ModuleType('mediapipe.tasks')
    tasks.__path__ = []
    py = types.ModuleType('mediapipe.tasks.python')
    py.__path__ = []
    py.BaseOptions = lambda **_k: object()
    vision = types.ModuleType('mediapipe.tasks.python.vision')
    vision.__path__ = []
    vision.FaceDetectorOptions = lambda **_k: object()
    vision.RunningMode = type('RunningMode', (), {'IMAGE': 1})
    vision.FaceDetector = type('FaceDetector', (), {'create_from_options': staticmethod(create_from_options)})
    tasks.python = py
    py.vision = vision
    return {
        'mediapipe': mp,
        'mediapipe.tasks': tasks,
        'mediapipe.tasks.python': py,
        'mediapipe.tasks.python.vision': vision,
    }


def test_build_detector_translates_missing_lib(monkeypatch):
    def _raise(_opts):
        raise OSError('libGLESv2.so.2: cannot open shared object file: No such file or directory')

    for name, mod in _stub_mediapipe(_raise).items():
        monkeypatch.setitem(sys.modules, name, mod)

    # Bypass __init__ so no model download / real config is needed.
    det = FaceDetector.__new__(FaceDetector)
    det.profile = 'short'
    det.threshold = 0.5
    det.emit_landmarks = True
    det.model_url = 'http://example/model.tflite'
    monkeypatch.setattr(det, '_resolve_model_path', lambda: '/tmp/model.tflite')

    with pytest.raises(RuntimeError, match='apt-get install -y libgles2'):
        det._build_detector()


def test_build_detector_succeeds_when_lib_present(monkeypatch):
    sentinel = object()
    for name, mod in _stub_mediapipe(lambda _opts: sentinel).items():
        monkeypatch.setitem(sys.modules, name, mod)

    det = FaceDetector.__new__(FaceDetector)
    det.profile = 'short'
    det.threshold = 0.5
    det.emit_landmarks = True
    det.model_url = 'http://example/model.tflite'
    monkeypatch.setattr(det, '_resolve_model_path', lambda: '/tmp/model.tflite')

    assert det._build_detector() is sentinel


# ---------------------------------------------------------------------------
# _rescale_to_original maps downscaled-inference coords back to original size
# ---------------------------------------------------------------------------


def test_rescale_to_original_maps_box_centroid_and_landmarks():
    faces = [
        {
            'label': 'face',
            'score': 0.9,
            'box': {'x1': 100.0, 'y1': 50.0, 'x2': 200.0, 'y2': 150.0},
            'centroid': {'x': 150.0, 'y': 100.0},
            'landmarks': [{'name': 'nose_tip', 'x': 150.0, 'y': 100.0}],
        }
    ]
    # inference at (1000, 500), original (2000, 1000) -> fx = fy = 2.
    out = FaceDetector._rescale_to_original(faces, (1000, 500), 2000, 1000)
    assert out[0]['box'] == {'x1': 200.0, 'y1': 100.0, 'x2': 400.0, 'y2': 300.0}
    assert out[0]['centroid'] == {'x': 300.0, 'y': 200.0}
    assert out[0]['landmarks'][0]['x'] == 300.0
    assert out[0]['landmarks'][0]['y'] == 200.0


def test_rescale_to_original_noop_when_sizes_match():
    faces = [{'box': {'x1': 1.0, 'y1': 2.0, 'x2': 3.0, 'y2': 4.0}}]
    out = FaceDetector._rescale_to_original(faces, (500, 500), 500, 500)
    assert out[0]['box'] == {'x1': 1.0, 'y1': 2.0, 'x2': 3.0, 'y2': 4.0}
