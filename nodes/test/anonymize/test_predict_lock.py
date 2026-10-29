# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Tests for the anonymize node's GLiNER guard (``GliNERRecognizer._predict_lock``).

The guard follows the run mode, as in the vision nodes (#1350) and as #2821 proposes for
OCR: a real lock
for in-process inference, where one torch module cannot run concurrent forward
passes, and a no-op with ``--modelserver`` so the recognizer's chunk workers reach
the model server's own workers instead of queueing here one request at a time.

``glinerRecognizer.py`` is loaded by file path under a synthetic package whose
``__path__`` is the node's source directory, so its relative imports
(``.Ruleparser``, ``.anonymize``) resolve to the real modules. The GLiNER model
wrapper, the rule file and the engine path lookup are stubbed;
``ai.common.models.base.make_device_lock`` is the real one.

Usage:
    ./builder.cmd nodes:test --pytest-pattern=anonymize --verbose
"""

import contextlib
import importlib.util
import sys
import threading
import time
import types
from pathlib import Path

import pytest

_PKG = '_anonymize_lock_pkg_under_test'
_SRC = Path(__file__).parent.parent.parent / 'src' / 'nodes' / 'anonymize'


def _load_recognizer_module() -> types.ModuleType:
    """Load ``glinerRecognizer.py`` under a synthetic package rooted at the node's source."""
    pkg = types.ModuleType(_PKG)
    pkg.__path__ = [str(_SRC)]
    sys.modules[_PKG] = pkg
    try:
        spec = importlib.util.spec_from_file_location(f'{_PKG}.glinerRecognizer', _SRC / 'glinerRecognizer.py')
        mod = importlib.util.module_from_spec(spec)
        mod.__package__ = _PKG
        sys.modules[spec.name] = mod
        spec.loader.exec_module(mod)
        return mod
    finally:
        for name in [n for n in sys.modules if n == _PKG or n.startswith(f'{_PKG}.')]:
            sys.modules.pop(name, None)


_mod = _load_recognizer_module()
GliNERRecognizer = _mod.GliNERRecognizer


class _Config:
    @staticmethod
    def getNodeConfig(*_a: object, **_kw: object) -> dict:
        return {'model': 'stub/gliner', 'entityTypes': ['person', 'email']}


class _StubGLiNER:
    """Stand-in for ``ai.common.models.GLiNER``; ``on_predict`` runs inside every call."""

    on_predict = staticmethod(lambda: None)

    def __init__(self, *_a: object, **_kw: object) -> None:
        pass

    def predict_entities(self, text, labels, **_kw: object) -> list:
        type(self).on_predict()
        return [{'start': 0, 'end': 4, 'label': labels[0], 'text': text[:4], 'score': 0.9}]


@pytest.fixture
def make_recognizer(monkeypatch, tmp_path):
    """Build a ``GliNERRecognizer`` through its real ``__init__``, in the given run mode."""

    def _make(model_server: bool) -> GliNERRecognizer:
        argv = ['node.py'] + (['--modelserver=5590'] if model_server else [])
        monkeypatch.setattr(sys, 'argv', argv)
        monkeypatch.setattr(_mod, 'Config', _Config)
        monkeypatch.setattr(_mod, 'GLiNER', _StubGLiNER)
        monkeypatch.setattr(_mod, 'RuleParser', lambda _path: None)
        monkeypatch.setattr(_mod, 'expand', lambda _spec: str(tmp_path))
        return GliNERRecognizer('anonymize', {}, {})

    return _make


# Exactly four 1024-char windows at the recognizer's 896-char stride, so ``predict``
# submits four jobs to its own worker pool.
_TEXT = 'x' * (4 * (1024 - 128))


def _run_threads(n: int, fn) -> list:
    results: list = []
    errors: list = []

    def work() -> None:
        try:
            results.append(fn())
        except Exception as e:  # surfaced through the assert below
            errors.append(e)

    threads = [threading.Thread(target=work) for _ in range(n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=30)
    assert not errors, errors
    return results


def test_local_guard_is_a_lock(make_recognizer) -> None:
    rec = make_recognizer(model_server=False)
    assert isinstance(rec._predict_lock, type(threading.Lock()))


def test_model_server_guard_is_a_no_op(make_recognizer) -> None:
    rec = make_recognizer(model_server=True)
    assert isinstance(rec._predict_lock, contextlib.nullcontext)


def test_local_predictions_do_not_overlap(make_recognizer, monkeypatch) -> None:
    """In-process inference: one forward pass at a time, whatever the chunk workers do."""
    rec = make_recognizer(model_server=False)
    state = {'active': 0, 'peak': 0, 'calls': 0}
    guard = threading.Lock()

    def on_predict() -> None:
        with guard:
            state['active'] += 1
            state['calls'] += 1
            state['peak'] = max(state['peak'], state['active'])
        time.sleep(0.05)
        with guard:
            state['active'] -= 1

    monkeypatch.setattr(_StubGLiNER, 'on_predict', staticmethod(on_predict))
    results = rec.predict(_TEXT, ['person'])

    assert state['calls'] == 4
    assert state['peak'] == 1
    assert len(results) == 1  # the overlap filter keeps the first chunk's entity only


def test_model_server_predictions_run_concurrently(make_recognizer, monkeypatch) -> None:
    """Proxy mode: the four chunk workers are inside ``predict_entities`` at the same time."""
    rec = make_recognizer(model_server=True)
    # Four parties = the four chunks of _TEXT, one per worker of the recognizer's pool.
    # process_chunk swallows exceptions, so a BrokenBarrierError would not propagate: it
    # would show up as a missing forward pass, hence the count and the content check.
    barrier = threading.Barrier(4, timeout=10)
    state = {'completed': 0}
    guard = threading.Lock()

    def on_predict() -> None:
        barrier.wait()
        with guard:
            state['completed'] += 1

    monkeypatch.setattr(_StubGLiNER, 'on_predict', staticmethod(on_predict))

    results = rec.predict(_TEXT, ['person'])

    assert state['completed'] == 4
    assert [(e['label'], e['text']) for e in results] == [('person', 'xxxx')]


def test_model_server_recognizers_run_concurrently_across_documents(make_recognizer, monkeypatch) -> None:
    """Proxy mode: documents handled by different engine threads reach the server together too."""
    rec = make_recognizer(model_server=True)
    # Four parties = the four threads below, one single-chunk document each.
    barrier = threading.Barrier(4, timeout=10)
    monkeypatch.setattr(_StubGLiNER, 'on_predict', staticmethod(barrier.wait))

    results = _run_threads(4, lambda: rec.predict('short text', ['person']))

    # A swallowed BrokenBarrierError would leave a document with no entities.
    assert [[(e['label'], e['text']) for e in r] for r in results] == [[('person', 'shor')]] * 4
