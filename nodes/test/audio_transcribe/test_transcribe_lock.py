# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Tests for the audio_transcribe node's transcription guard (``IGlobal.transcribe_lock``).

The guard follows the run mode, as in the vision nodes (#1350) and OCR (#2820): a real lock
for in-process inference (one copy, one CTranslate2 worker), a no-op with
``--modelserver`` so concurrent streams in one task reach the model server together
instead of queueing here across the whole round trip.

``IGlobal.py`` is loaded by file path under a synthetic package. The Whisper model
wrapper is stubbed; ``ai.common.models.base.make_device_lock`` is the real one.

Usage:
    ./builder.cmd nodes:test --pytest-pattern=audio_transcribe --verbose
"""

import contextlib
import importlib.util
import sys
import threading
import time
import types
from pathlib import Path

import pytest

_PKG = '_audio_transcribe_lock_pkg_under_test'
_SRC = Path(__file__).parent.parent.parent / 'src' / 'nodes' / 'audio_transcribe'


def _load_iglobal_module() -> types.ModuleType:
    pkg = types.ModuleType(_PKG)
    pkg.__path__ = [str(_SRC)]
    sys.modules[_PKG] = pkg
    try:
        spec = importlib.util.spec_from_file_location(f'{_PKG}.IGlobal', _SRC / 'IGlobal.py')
        mod = importlib.util.module_from_spec(spec)
        mod.__package__ = _PKG
        sys.modules[spec.name] = mod
        spec.loader.exec_module(mod)
        return mod
    finally:
        for name in [n for n in sys.modules if n == _PKG or n.startswith(f'{_PKG}.')]:
            sys.modules.pop(name, None)


_mod = _load_iglobal_module()
IGlobal = _mod.IGlobal


class _Config:
    @staticmethod
    def getNodeConfig(*_a: object, **_kw: object) -> dict:
        return {}


class _StubWhisper:
    """Stand-in for ``ai.common.models.Whisper``; ``on_transcribe`` runs inside every call."""

    on_transcribe = staticmethod(lambda: None)

    def __init__(self, *_a: object, **_kw: object) -> None:
        pass

    def transcribe(self, audio_bytes, **_kw: object) -> dict:
        type(self).on_transcribe()
        return {'$text': 'hello', '$segments': [{'text': 'hello', 'start': 0.0, 'end': 1.0}]}


@pytest.fixture
def make_global(monkeypatch):
    """Build an ``IGlobal`` through the real ``beginGlobal``, in the given run mode."""

    def _make(model_server: bool) -> IGlobal:
        argv = ['node.py'] + (['--modelserver=5590'] if model_server else [])
        monkeypatch.setattr(sys, 'argv', argv)
        monkeypatch.setattr(_mod, 'Config', _Config)
        monkeypatch.setattr(_mod, 'Whisper', _StubWhisper)

        glb = IGlobal.__new__(IGlobal)
        glb.glb = types.SimpleNamespace(logicalType='audio_transcribe', connConfig={})
        glb.beginGlobal()
        return glb

    return _make


def _run_threads(n: int, glb: IGlobal) -> list:
    results: list = []
    errors: list = []

    def work() -> None:
        try:
            results.append(glb.transcribe(b'\x00\x01' * 1600))
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
    assert isinstance(glb.transcribe_lock, type(threading.Lock()))


def test_model_server_guard_is_a_no_op(make_global) -> None:
    glb = make_global(model_server=True)
    assert isinstance(glb.transcribe_lock, contextlib.nullcontext)


def test_local_transcriptions_do_not_overlap(make_global, monkeypatch) -> None:
    """In-process inference: one ``transcribe`` at a time, whatever the number of worker threads."""
    glb = make_global(model_server=False)
    state = {'active': 0, 'peak': 0}
    guard = threading.Lock()

    def on_transcribe() -> None:
        with guard:
            state['active'] += 1
            state['peak'] = max(state['peak'], state['active'])
        time.sleep(0.05)
        with guard:
            state['active'] -= 1

    monkeypatch.setattr(_StubWhisper, 'on_transcribe', staticmethod(on_transcribe))
    results = _run_threads(4, glb)

    assert [[s.text for s in r] for r in results] == [['hello']] * 4
    assert state['peak'] == 1


def test_model_server_transcriptions_run_concurrently(make_global, monkeypatch) -> None:
    """Proxy mode: worker threads are inside ``transcribe`` at the same time (a node lock would break the barrier)."""
    glb = make_global(model_server=True)
    barrier = threading.Barrier(4, timeout=10)
    monkeypatch.setattr(_StubWhisper, 'on_transcribe', staticmethod(barrier.wait))

    results = _run_threads(4, glb)

    assert [[s.text for s in r] for r in results] == [['hello']] * 4
