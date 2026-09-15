# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Unit tests for GliNERRecognizer.predict chunking and concurrency.

``predict`` splits text into overlapping chunks and runs them through a
ThreadPoolExecutor. GLiNER wraps a single torch module, which cannot take
concurrent forward passes, so a lock is held around ``predict_entities`` only:
chunking, offset arithmetic and the overlap filter stay concurrent.

These tests pin two things:

* the entities and offsets ``predict`` returns for a multi-chunk input, which is
  what the overlap filter and the final dedup decide, and
* that concurrent chunks never enter ``predict_entities`` at the same time,
  while still genuinely running in parallel.

No GLiNER model or engine is required: the module is loaded by path with the
heavy dependencies stubbed, and a recording double stands in for the model.
"""

import importlib.util
import os
import sys
import threading
import time
import types

import pytest

_ANON_DIR = os.path.join(os.path.dirname(__file__), '..', 'src', 'nodes', 'anonymize')

CHUNK_SIZE = 1024
OVERLAP = 128
STRIDE = CHUNK_SIZE - OVERLAP


def _load_recognizer_module():
    """Load glinerRecognizer.py with its heavy imports stubbed out.

    It is loaded as ``anonymize_under_test.glinerRecognizer`` so its relative
    imports resolve against the real sibling files (Ruleparser, anonymize), both
    of which are dependency-free.

    sys.modules is snapshotted and restored around the load: the stubs only need
    to exist while the module body executes, and leaving them behind would hand a
    fake ``rocketlib`` or ``ai.common`` to every test that runs afterwards.
    """
    package_name = 'anonymize_under_test'
    stubs = {
        package_name: types.ModuleType(package_name),
        'rocketlib': types.SimpleNamespace(debug=lambda *a, **k: None, expand=lambda value='': value),
        'ai': types.ModuleType('ai'),
        'ai.common': types.ModuleType('ai.common'),
        'ai.common.config': types.SimpleNamespace(
            Config=types.SimpleNamespace(getNodeConfig=lambda *a, **k: {}),
        ),
        'ai.common.models': types.SimpleNamespace(GLiNER=lambda *a, **k: None),
    }
    stubs[package_name].__path__ = [os.path.abspath(_ANON_DIR)]
    stubs['ai'].common = stubs['ai.common']

    path = os.path.join(_ANON_DIR, 'glinerRecognizer.py')
    spec = importlib.util.spec_from_file_location(f'{package_name}.glinerRecognizer', path)
    module = importlib.util.module_from_spec(spec)

    # Only install names that are not already present, and remember which, so a
    # real rocketlib/ai.common in the engine environment is never shadowed.
    installed = [name for name in stubs if name not in sys.modules]
    for name in installed:
        sys.modules[name] = stubs[name]
    sys.modules[spec.name] = module
    try:
        spec.loader.exec_module(module)
    finally:
        # The module now holds direct references to what it imported, so the
        # sys.modules entries are no longer needed.
        for name in installed:
            sys.modules.pop(name, None)
        sys.modules.pop(spec.name, None)

    return module


recognizer_module = _load_recognizer_module()
GliNERRecognizer = recognizer_module.GliNERRecognizer


class _MarkerModel:
    """Finds a fixed marker in each chunk and records concurrency.

    Returned offsets are chunk-relative, exactly as GLiNER's own would be, so
    predict() is responsible for turning them into absolute positions.
    """

    def __init__(self, marker='ACME', label='organization', delay=0.0):
        self.marker = marker
        self.label = label
        self.delay = delay
        self.active = 0
        self.max_active = 0
        self.calls = 0
        self.chunks_seen = []
        self._lock = threading.Lock()

    def predict_entities(self, chunk, labels):
        with self._lock:
            self.active += 1
            self.calls += 1
            self.max_active = max(self.max_active, self.active)
            self.chunks_seen.append(chunk)
        try:
            if self.delay:
                time.sleep(self.delay)
            found = []
            start = chunk.find(self.marker)
            while start != -1:
                found.append(
                    {
                        'start': start,
                        'end': start + len(self.marker),
                        'label': self.label,
                        'text': self.marker,
                        'score': 0.99,
                    }
                )
                start = chunk.find(self.marker, start + 1)
            return found
        finally:
            with self._lock:
                self.active -= 1


def make_recognizer(model):
    """Build a recognizer with only what predict() touches."""
    instance = GliNERRecognizer.__new__(GliNERRecognizer)
    instance.model = model
    instance._predict_lock = threading.Lock()
    return instance


def build_text(marker_positions, marker='ACME', total_length=4000):
    """Filler text with the marker placed at each requested absolute offset."""
    body = ['.'] * total_length
    for position in marker_positions:
        for index, character in enumerate(marker):
            body[position + index] = character
    return ''.join(body)


def _expected_after_overlap_filter(marker_positions, text_length, marker='ACME'):
    """Recompute predict()'s contract independently of its implementation.

    A chunk starting at ``offset`` drops anything before ``offset + OVERLAP``
    unless it is the first chunk, because the previous chunk already covered it.
    """
    kept = set()
    for chunk_idx, offset in enumerate(range(0, text_length, STRIDE)):
        chunk_end = min(offset + CHUNK_SIZE, text_length)
        for position in marker_positions:
            if position < offset or position + len(marker) > chunk_end:
                continue
            if chunk_idx > 0 and position < offset + OVERLAP:
                continue
            kept.add((position, position + len(marker)))
    return sorted(kept)


# -----------------------------------------------------------------------------
# Offsets and dedup across chunk boundaries
# -----------------------------------------------------------------------------


def test_multi_chunk_input_returns_absolute_offsets():
    """Offsets are absolute, deduplicated, and ordered by position."""
    positions = [10, 500, 1500, 2500, 3500]
    text = build_text(positions)
    model = _MarkerModel()

    results = make_recognizer(model).predict(text, ['organization'])

    assert model.calls > 1, 'the input must actually span several chunks'
    spans = [(r['start'], r['end']) for r in results]
    assert spans == sorted(spans), 'results must be ordered by offset'
    assert spans == _expected_after_overlap_filter(positions, len(text))
    for start, end in spans:
        assert text[start:end] == 'ACME', 'offsets must point at the entity'


def test_entity_in_an_overlap_region_is_not_duplicated():
    """A marker inside two chunks' shared region is reported exactly once."""
    # STRIDE..CHUNK_SIZE is covered by both chunk 0 and chunk 1.
    position = STRIDE + 10
    text = build_text([position])
    model = _MarkerModel()

    results = make_recognizer(model).predict(text, ['organization'])

    assert [(r['start'], r['end']) for r in results] == [(position, position + 4)]


def test_results_are_stable_across_runs():
    """Thread completion order must not affect the returned sequence."""
    positions = [10, 900, 1800, 2700, 3600]
    text = build_text(positions)

    runs = [
        [(r['start'], r['end'], r['label']) for r in make_recognizer(_MarkerModel()).predict(text, ['organization'])]
        for _ in range(5)
    ]

    assert all(run == runs[0] for run in runs), 'parallel execution must be deterministic'


def test_single_chunk_input_keeps_every_entity():
    """With one chunk there is no overlap region, so nothing is filtered.

    Note the text must be no longer than STRIDE, not CHUNK_SIZE: chunk starts
    step by STRIDE, so a CHUNK_SIZE-long text already produces a second chunk.
    """
    positions = [0, 100, 700]
    text = build_text(positions, total_length=STRIDE)
    model = _MarkerModel()

    results = make_recognizer(model).predict(text, ['organization'])

    assert model.calls == 1, 'this input must be a single chunk'
    assert [(r['start'], r['end']) for r in results] == [(p, p + 4) for p in positions]


def test_empty_text_yields_no_results():
    model = _MarkerModel()

    assert make_recognizer(model).predict('', ['organization']) == []
    assert model.calls == 0


# -----------------------------------------------------------------------------
# Concurrency
# -----------------------------------------------------------------------------


def test_forward_pass_is_serialized_but_chunks_run_in_parallel():
    """The lock covers predict_entities only, so calls never overlap."""
    positions = [10, 900, 1800, 2700, 3600]
    text = build_text(positions)
    model = _MarkerModel(delay=0.02)

    results = make_recognizer(model).predict(text, ['organization'])

    assert model.calls >= 4, 'several chunks must be submitted'
    assert model.max_active == 1, 'predict_entities must never run concurrently'
    assert results, 'serialization must not lose results'


def test_predict_still_uses_a_thread_pool():
    """Guard against silently dropping back to a sequential loop.

    The chunks are handed to worker threads, so predict_entities must be called
    from threads other than the caller's.
    """
    positions = [10, 900, 1800, 2700]
    text = build_text(positions)

    calling_threads = set()
    model = _MarkerModel()
    original = model.predict_entities

    def recording(chunk, labels):
        calling_threads.add(threading.current_thread().name)
        return original(chunk, labels)

    model.predict_entities = recording

    make_recognizer(model).predict(text, ['organization'])

    assert threading.current_thread().name not in calling_threads, 'work must run off the calling thread'


def test_a_failing_chunk_does_not_lose_the_others():
    """One bad batch is logged and skipped; the rest still come back."""
    positions = [10, 900, 1800, 2700, 3600]
    text = build_text(positions)

    model = _MarkerModel()
    original = model.predict_entities
    state = {'calls': 0}

    def flaky(chunk, labels):
        state['calls'] += 1
        if state['calls'] == 2:
            raise RuntimeError('CUDA error on this chunk')
        return original(chunk, labels)

    model.predict_entities = flaky

    results = make_recognizer(model).predict(text, ['organization'])

    assert results, 'a single chunk failure must not empty the result'


@pytest.mark.parametrize('label_count', [1, 40, 70])
def test_label_batching_covers_every_label(label_count):
    """Labels are batched in 32s; every batch reaches the model once per chunk."""
    # STRIDE keeps this to a single chunk, so calls == batches exactly.
    text = build_text([10], total_length=STRIDE)
    model = _MarkerModel()
    labels = [f'label_{index}' for index in range(label_count)]

    make_recognizer(model).predict(text, labels)

    expected_batches = (label_count + 31) // 32
    assert model.calls == expected_batches
