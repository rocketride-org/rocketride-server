"""
Unit tests for ai.common.models.transformers.sentence_transformers.

Focus areas:
- Per-model serialization of the GPU forward pass inside
  SentenceTransformerLoader.inference()

The tests drive the real inference() body and stub only the forward pass, so
the lock under test is the one that ships. torch is not installed in every
test environment, so ai.common.torch is replaced by a numpy-backed stand-in
that implements the handful of ops inference() uses.

Run from project root:
  PYTHONPATH=packages/ai/src python -m pytest \
    packages/ai/tests/ai/common/models/transformers/test_sentence_transformers.py -v
"""

from concurrent.futures import ThreadPoolExecutor
import contextlib
import sys
import threading
import time
import types

import numpy as np
import pytest

import ai.common.models.transformers.sentence_transformers as sentence_transformers_module

SentenceTransformerLoader = sentence_transformers_module.SentenceTransformerLoader


# -----------------------------------------------------------------------------
# Minimal torch stand-in
# -----------------------------------------------------------------------------


class _FakeTensor:
    """Numpy-backed tensor covering only the ops inference() performs."""

    def __init__(self, array):
        self.array = np.asarray(array, dtype=np.float64)

    def to(self, device):  # device movement is a no-op here
        return self

    def float(self):
        return self

    def size(self):
        return self.array.shape

    def unsqueeze(self, dim):
        return _FakeTensor(np.expand_dims(self.array, dim))

    def expand(self, shape):
        return _FakeTensor(np.broadcast_to(self.array, shape))

    def sum(self, dim=None):
        return _FakeTensor(self.array.sum(axis=dim))

    def __mul__(self, other):
        return _FakeTensor(self.array * other.array)

    def __truediv__(self, other):
        return _FakeTensor(self.array / other.array)

    def __getitem__(self, index):
        return _FakeTensor(self.array[index])


class _FakeFunctional:
    @staticmethod
    def normalize(tensor, p=2, dim=1):
        norm = np.linalg.norm(tensor.array, ord=p, axis=dim, keepdims=True)
        norm = np.where(norm == 0, 1.0, norm)
        return _FakeTensor(tensor.array / norm)


class _FakeNN:
    functional = _FakeFunctional


class _FakeTorch:
    nn = _FakeNN

    @staticmethod
    def no_grad():
        return contextlib.nullcontext()

    @staticmethod
    def sum(tensor, dim=None):
        return tensor.sum(dim=dim)

    @staticmethod
    def clamp(tensor, min=None):
        return _FakeTensor(np.clip(tensor.array, min, None))


@pytest.fixture
def fake_torch(monkeypatch):
    """Install a numpy-backed stand-in for ai.common.torch."""
    module = types.ModuleType('ai.common.torch')
    module.torch = _FakeTorch
    monkeypatch.setitem(sys.modules, 'ai.common.torch', module)
    return module


# -----------------------------------------------------------------------------
# Test doubles for the model bundle
# -----------------------------------------------------------------------------


class _ForwardRecorder:
    """Stands in for the transformer forward pass and records overlap."""

    def __init__(self, hidden_size=3, delay=0.02):
        self.hidden_size = hidden_size
        self.delay = delay
        self.active = 0
        self.max_active = 0
        self.calls = 0
        self._state_lock = threading.Lock()

    def __call__(self, **inputs):
        with self._state_lock:
            self.active += 1
            self.calls += 1
            self.max_active = max(self.max_active, self.active)

        # Hold the critical section open long enough for overlap to show up.
        time.sleep(self.delay)

        with self._state_lock:
            self.active -= 1

        batch, seq = inputs['attention_mask'].size()
        output = types.SimpleNamespace()
        output.last_hidden_state = _FakeTensor(np.ones((batch, seq, self.hidden_size)))
        return output


def _make_model(recorder):
    """Build a model bundle shaped like actual_model[0].auto_model."""
    module = types.SimpleNamespace(auto_model=recorder)
    return [module]


def _make_preprocessed(batch=2, seq=4):
    return {
        'encoded': {
            'input_ids': _FakeTensor(np.ones((batch, seq))),
            'attention_mask': _FakeTensor(np.ones((batch, seq))),
        },
        'batch_size': batch,
    }


# -----------------------------------------------------------------------------
# SentenceTransformerLoader._get_model_lock
# -----------------------------------------------------------------------------


def test_get_model_lock_is_stable_per_model_id():
    """The same model id maps to the same lock; different ids do not share one."""
    first = SentenceTransformerLoader._get_model_lock(1234)
    again = SentenceTransformerLoader._get_model_lock(1234)
    other = SentenceTransformerLoader._get_model_lock(5678)

    assert first is again
    assert first is not other


# -----------------------------------------------------------------------------
# SentenceTransformerLoader.inference
# -----------------------------------------------------------------------------


def test_inference_serializes_forward_pass_for_shared_model(fake_torch):
    """Concurrent inference() calls on one model never overlap in the forward pass."""
    recorder = _ForwardRecorder()
    model = _make_model(recorder)
    metadata = {'device': 'cpu'}

    def run(_):
        return SentenceTransformerLoader.inference(model, _make_preprocessed(), metadata)

    with ThreadPoolExecutor(max_workers=4) as executor:
        results = list(executor.map(run, range(8)))

    assert recorder.calls == 8
    assert recorder.max_active == 1
    for result in results:
        assert result.array.shape == (2, 3)


def test_inference_allows_distinct_models_to_overlap(fake_torch):
    """Separate model instances hold separate locks and may run concurrently."""
    recorder_a = _ForwardRecorder(delay=0.05)
    recorder_b = _ForwardRecorder(delay=0.05)
    model_a = _make_model(recorder_a)
    model_b = _make_model(recorder_b)
    metadata = {'device': 'cpu'}

    barrier = threading.Barrier(2, timeout=5)

    def run(model):
        barrier.wait()
        return SentenceTransformerLoader.inference(model, _make_preprocessed(), metadata)

    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [executor.submit(run, model_a), executor.submit(run, model_b)]
        for future in futures:
            future.result()

    # Each model saw exactly one call, and neither blocked on the other's lock.
    assert recorder_a.calls == 1
    assert recorder_b.calls == 1


def test_inference_serializes_via_model_obj_unwrap(fake_torch):
    """Server-mode wrappers key the lock on the unwrapped model, not the wrapper."""
    recorder = _ForwardRecorder()
    shared_model = _make_model(recorder)

    def make_wrapper():
        wrapper = types.SimpleNamespace()
        wrapper.model_obj = shared_model
        wrapper.metadata = {'device': 'cpu'}
        return wrapper

    # Two distinct wrappers around one underlying model must share a lock.
    wrappers = [make_wrapper() for _ in range(4)]

    def run(wrapper):
        return SentenceTransformerLoader.inference(wrapper, _make_preprocessed(), None)

    with ThreadPoolExecutor(max_workers=4) as executor:
        list(executor.map(run, wrappers))

    assert recorder.calls == 4
    assert recorder.max_active == 1


# -----------------------------------------------------------------------------
# SentenceTransformer.encode (local path)
# -----------------------------------------------------------------------------


def test_encode_local_serializes_shared_model(monkeypatch, fake_torch):
    """encode() serializes the shared model through the loader's lock."""
    recorder = _ForwardRecorder()
    shared_model = _make_model(recorder)

    def fake_get_model_server_address():
        return None

    def fake_load(model_name, device=None, allocate_gpu=None, exclude_gpus=None, **kwargs):
        metadata = {
            'embedding_dimension': recorder.hidden_size,
            'max_seq_length': 128,
            'device': device or 'cpu',
            'model_name': model_name,
            'loader': 'sentence_transformer',
            'estimated_memory_gb': 0.0,
        }
        return shared_model, metadata, -1

    def fake_preprocess(model, inputs, metadata=None):
        return _make_preprocessed(batch=len(inputs))

    def fake_postprocess(model, raw_output, batch_size, output_fields, **kwargs):
        return [{'$embeddings': raw_output[i].array.tolist()} for i in range(batch_size)]

    monkeypatch.setattr(sentence_transformers_module, 'get_model_server_address', fake_get_model_server_address)
    monkeypatch.setattr(SentenceTransformerLoader, 'load', staticmethod(fake_load))
    monkeypatch.setattr(SentenceTransformerLoader, 'preprocess', staticmethod(fake_preprocess))
    monkeypatch.setattr(SentenceTransformerLoader, 'postprocess', staticmethod(fake_postprocess))

    model = sentence_transformers_module.SentenceTransformer('nomic-ai/nomic-embed-text-v1.5', device='cpu')

    def run_encode(worker_idx):
        sentences = [f'search_document: worker-{worker_idx}-item-{i}' for i in range(4)]
        return model.encode(sentences, batch_size=2)

    with ThreadPoolExecutor(max_workers=4) as executor:
        results = list(executor.map(run_encode, range(8)))

    assert recorder.max_active == 1
    for result in results:
        assert isinstance(result, np.ndarray)
        assert result.shape == (4, recorder.hidden_size)
