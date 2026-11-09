"""
Unit tests for ai.common.models.transformers.sentence_transformers.

Focus areas:
- Existing per-model serialization for custom models and non-local paths.
- Bounded local CPU forwards without serializing independent models or OCR.

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
import gc
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

    def __init__(self, hidden_size=3, delay=0.02, meet=None):
        """Create the recorder.

        Args:
            hidden_size (int): Width of the fake hidden state.
            delay (float): Seconds each forward pass stays in flight.
            meet (threading.Barrier | None): When set, every forward pass waits
                on it, so passes that can overlap are guaranteed to meet.
        """
        self.hidden_size = hidden_size
        self.delay = delay
        self.meet = meet
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
        if self.meet is not None:
            self.meet.wait()
        time.sleep(self.delay)

        with self._state_lock:
            self.active -= 1

        batch, seq = inputs['attention_mask'].size()
        output = types.SimpleNamespace()
        output.last_hidden_state = _FakeTensor(np.ones((batch, seq, self.hidden_size)))
        return output


class _ModelBundle(list):
    """Weak-referenceable stand-in for a loaded model bundle.

    Production's ``actual_model`` is an ``nn.Module`` (weak-referenceable); a
    plain ``list`` is not, so it silently exercises ``_get_model_lock``'s
    no-eviction fallback instead of the path production actually takes.
    """


def _make_model(recorder):
    """Build a model bundle shaped like actual_model[0].auto_model."""
    module = types.SimpleNamespace(auto_model=recorder)
    return _ModelBundle([module])


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


def test_get_model_lock_is_stable_per_model():
    """The same model maps to the same lock; different models do not share one."""
    model = _make_model(_ForwardRecorder())
    other_model = _make_model(_ForwardRecorder())

    first = SentenceTransformerLoader._get_model_lock(model)
    again = SentenceTransformerLoader._get_model_lock(model)
    other = SentenceTransformerLoader._get_model_lock(other_model)

    assert first is again
    assert first is not other


def test_get_model_lock_entry_is_dropped_when_model_is_collected():
    """A retired model's lock entry does not linger in the registry."""
    model = _make_model(_ForwardRecorder())
    model_id = id(model)

    SentenceTransformerLoader._get_model_lock(model)
    assert model_id in SentenceTransformerLoader._model_locks

    del model
    gc.collect()

    assert model_id not in SentenceTransformerLoader._model_locks


def test_get_model_lock_tolerates_models_without_weakref_support():
    """A model that cannot be weak-referenced still gets a working lock."""
    model = [types.SimpleNamespace(auto_model=_ForwardRecorder())]  # plain list: no __weakref__

    lock = SentenceTransformerLoader._get_model_lock(model)

    assert lock is SentenceTransformerLoader._get_model_lock(model)


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
    # One recorder shared by both bundles, so it observes true overlap across
    # them. Per-model recorders would each see a single call and would pass
    # even if one global lock serialized everything.
    recorder = _ForwardRecorder(delay=0, meet=threading.Barrier(2, timeout=5))
    model_a = _make_model(recorder)
    model_b = _make_model(recorder)
    metadata = {'device': 'cpu'}

    barrier = threading.Barrier(2, timeout=5)

    def run(model):
        barrier.wait()
        return SentenceTransformerLoader.inference(model, _make_preprocessed(), metadata)

    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [executor.submit(run, model_a), executor.submit(run, model_b)]
        for future in futures:
            future.result()

    # Both forward passes were in flight at once: distinct model ids do not
    # block each other.
    assert recorder.calls == 2
    assert recorder.max_active == 2


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
    model = _local_encoder(monkeypatch, recorder)

    def run_encode(worker_idx):
        sentences = [f'search_document: worker-{worker_idx}-item-{i}' for i in range(4)]
        return model.encode(sentences, batch_size=2)

    with ThreadPoolExecutor(max_workers=4) as executor:
        results = list(executor.map(run_encode, range(8)))

    assert recorder.max_active == 1
    for result in results:
        assert isinstance(result, np.ndarray)
        assert result.shape == (4, recorder.hidden_size)


def _local_encoder(monkeypatch, recorder, batches=None):
    """A SentenceTransformer on the local path, backed by `recorder`."""
    shared_model = _make_model(recorder)

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
        if batches is not None:
            batches.append(list(inputs))
        return _make_preprocessed(batch=len(inputs))

    def fake_postprocess(model, raw_output, batch_size, output_fields, **kwargs):
        if batches is not None:
            return [{'$embeddings': _embedding_of(text)} for text in batches[-1]]
        return [{'$embeddings': raw_output[i].array.tolist()} for i in range(batch_size)]

    monkeypatch.setattr(sentence_transformers_module, 'get_model_server_address', lambda: None)
    monkeypatch.setattr(SentenceTransformerLoader, 'load', staticmethod(fake_load))
    monkeypatch.setattr(SentenceTransformerLoader, 'preprocess', staticmethod(fake_preprocess))
    monkeypatch.setattr(SentenceTransformerLoader, 'postprocess', staticmethod(fake_postprocess))
    return sentence_transformers_module.SentenceTransformer('nomic-ai/nomic-embed-text-v1.5', device='cpu')


def _embedding_of(text):
    """An embedding that identifies the sentence it came from."""
    return [float(len(text)), float(ord(text[0])), 1.0]


def test_encode_local_sorts_by_length_and_restores_order(monkeypatch, fake_torch):
    """Batches are built shortest-first, and every row comes back on its own sentence."""
    batches = []
    model = _local_encoder(monkeypatch, _ForwardRecorder(delay=0.0), batches)
    sentences = ['w' * 40, 'x' * 5, 'y' * 120, 'z' * 20]

    result = model.encode(sentences, batch_size=2)

    assert [len(text) for batch in batches for text in batch] == [5, 20, 40, 120]
    for index, sentence in enumerate(sentences):
        assert list(result[index]) == _embedding_of(sentence), f'row {index} does not belong to its sentence'


def test_inference_reports_lock_wait_as_queue_time(fake_torch):
    """Time blocked on another thread's forward pass is queue wait, not compute."""
    recorder = _ForwardRecorder(delay=0.5)
    shared_model = _make_model(recorder)
    metadata = {'device': 'cpu'}

    SentenceTransformerLoader.take_lock_wait()

    barrier = threading.Barrier(2, timeout=5)
    waits = {}

    def run(name):
        barrier.wait()
        SentenceTransformerLoader.take_lock_wait()
        SentenceTransformerLoader.inference(shared_model, _make_preprocessed(), metadata)
        waits[name] = SentenceTransformerLoader.take_lock_wait()

    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [executor.submit(run, 'a'), executor.submit(run, 'b')]
        for future in futures:
            future.result()

    # One thread went straight through; the other queued behind it for roughly
    # the forward-pass delay. Whichever won the race, the waits differ.
    assert recorder.max_active == 1
    blocked = max(waits.values())
    assert blocked >= 25, f'expected a measurable queue wait, got {waits}'


def test_take_lock_wait_resets_between_calls(fake_torch):
    """Lock wait is consumed once, so it cannot leak into a later encode."""
    recorder = _ForwardRecorder(delay=0)
    model = _make_model(recorder)

    SentenceTransformerLoader.take_lock_wait()
    SentenceTransformerLoader.inference(model, _make_preprocessed(), {'device': 'cpu'})

    first = SentenceTransformerLoader.take_lock_wait()
    assert first >= 0.0
    assert SentenceTransformerLoader.take_lock_wait() == 0.0


@pytest.fixture
def qualified_cpu(monkeypatch, fake_torch):
    """Isolate admission mechanics from the implementation check tested separately."""
    monkeypatch.setattr(SentenceTransformerLoader, '_local_cpu_forward_slots', classmethod(lambda cls, model: 2))


def test_local_cpu_encoder_bounds_shared_forwards(monkeypatch, qualified_cpu):
    """Exercise encode(), including its handoff to the real loader, with eight callers."""
    recorder = _ForwardRecorder(meet=threading.Barrier(2, timeout=5))
    encoder = _local_encoder(monkeypatch, recorder)
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda i: encoder.encode([f'document {i}']), range(16)))
    assert recorder.calls == 16
    assert recorder.max_active == 2
    assert all(result.shape == (1, recorder.hidden_size) for result in results)


@pytest.mark.parametrize('qualified', [False, True])
def test_local_cpu_distinct_models_overlap(monkeypatch, fake_torch, qualified):
    """A fallback lock is per model, not exclusive ownership of the process CPU."""
    if qualified:
        monkeypatch.setattr(SentenceTransformerLoader, '_local_cpu_forward_slots', classmethod(lambda cls, model: 2))
    recorder = _ForwardRecorder(delay=0, meet=threading.Barrier(2, timeout=5))
    models = [_make_model(recorder), _make_model(recorder)]
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(
            pool.map(
                lambda model: SentenceTransformerLoader.inference(
                    model, _make_preprocessed(), {'device': 'cpu'}, _local_cpu=True
                ),
                models,
            )
        )
    assert len(results) == 2
    assert recorder.max_active == 2


@pytest.mark.parametrize('qualified', [False, True])
def test_local_cpu_forward_overlaps_ocr_budget(monkeypatch, fake_torch, qualified):
    """An OCR CPU reservation and an embedding forward must be able to meet."""
    from ai.common.models.device_budget import DeviceBudget

    if qualified:
        monkeypatch.setattr(SentenceTransformerLoader, '_local_cpu_forward_slots', classmethod(lambda cls, model: 2))
    meet = threading.Barrier(2, timeout=5)
    model = _make_model(_ForwardRecorder(delay=0, meet=meet))

    def ocr():
        with DeviceBudget('cpu').reserve(None):
            meet.wait()

    with ThreadPoolExecutor(max_workers=2) as pool:
        forward = pool.submit(
            SentenceTransformerLoader.inference, model, _make_preprocessed(), {'device': 'cpu'}, _local_cpu=True
        )
        other = pool.submit(ocr)
        forward.result(timeout=10)
        other.result(timeout=10)


@pytest.mark.parametrize(
    'device,server,local', [('cpu', True, True), ('cuda:0', False, True), ('mps', False, True), ('cpu', False, False)]
)
def test_non_local_cpu_paths_keep_lock(qualified_cpu, device, server, local):
    """Eligibility alone cannot enable accelerator, server or direct-loader overlap."""
    recorder = _ForwardRecorder()
    model = _make_model(recorder)
    if server:
        model = types.SimpleNamespace(model_obj=model, metadata={'device': device})
    with ThreadPoolExecutor(max_workers=4) as pool:
        list(
            pool.map(
                lambda _: SentenceTransformerLoader.inference(
                    model, _make_preprocessed(), {'device': device}, _local_cpu=local
                ),
                range(8),
            )
        )
    assert recorder.calls == 8
    assert recorder.max_active == 1


def test_local_cpu_exception_releases_all_permits(qualified_cpu):
    """Two failures must not leak either slot or prevent subsequent forwards."""
    meet = threading.Barrier(2, timeout=5)

    class FailingForward(_ForwardRecorder):
        fail = True

        def __call__(self, **inputs):
            if self.fail:
                meet.wait()
                raise RuntimeError('forward failed')
            return super().__call__(**inputs)

    recorder = FailingForward(meet=meet)
    model = _make_model(recorder)

    def run():
        return SentenceTransformerLoader.inference(model, _make_preprocessed(), {'device': 'cpu'}, _local_cpu=True)

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(run) for _ in range(2)]
        for future in futures:
            with pytest.raises(RuntimeError, match='forward failed'):
                future.result(timeout=10)
        recorder.fail = False
        futures = [pool.submit(run) for _ in range(2)]
        assert all(f.result(timeout=10).array.shape == (2, 3) for f in futures)
    assert recorder.max_active == 2


def test_caller_timeout_does_not_release_worker_permit(qualified_cpu):
    """A caller that stops waiting cannot admit a third forward before workers exit."""
    entered = threading.Barrier(3, timeout=5)
    release = threading.Event()

    class HeldForward(_ForwardRecorder):
        def __call__(self, **inputs):
            entered.wait()
            assert release.wait(5)
            return super().__call__(**inputs)

    model = _make_model(HeldForward())

    def run():
        return SentenceTransformerLoader.inference(model, _make_preprocessed(), {'device': 'cpu'}, _local_cpu=True)

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(run) for _ in range(2)]
        try:
            entered.wait()
            for future in futures:
                with pytest.raises(TimeoutError):
                    future.result(timeout=0.01)
                assert not future.cancel()
            gate = SentenceTransformerLoader._get_model_lock(model)
            assert not gate.acquire(blocking=False)
        finally:
            release.set()
        for future in futures:
            future.result(timeout=10)
    assert gate.acquire(blocking=False)
    assert gate.acquire(blocking=False)
    assert not gate.acquire(blocking=False)
    gate.release()
    gate.release()


def test_local_cpu_gate_is_cached_and_collected(monkeypatch, qualified_cpu):
    """Qualification happens once and retirement removes the semaphore too."""
    model = _make_model(_ForwardRecorder())
    model_id = id(model)
    first = SentenceTransformerLoader._get_model_lock(model, local_cpu=True)
    monkeypatch.setattr(
        SentenceTransformerLoader,
        '_local_cpu_forward_slots',
        classmethod(lambda cls, model: pytest.fail('requalified')),
    )
    assert first is SentenceTransformerLoader._get_model_lock(model, local_cpu=True)
    del model
    gc.collect()
    assert model_id not in SentenceTransformerLoader._model_locks


def test_local_cpu_wait_is_reported(qualified_cpu):
    """The third caller reports admission wait through the existing metric."""
    model = _make_model(_ForwardRecorder(delay=0.1))
    meet = threading.Barrier(3, timeout=5)

    def run():
        SentenceTransformerLoader.take_lock_wait()
        meet.wait()
        SentenceTransformerLoader.inference(model, _make_preprocessed(), {'device': 'cpu'}, _local_cpu=True)
        return SentenceTransformerLoader.take_lock_wait()

    with ThreadPoolExecutor(max_workers=3) as pool:
        waits = list(pool.map(lambda _: run(), range(3)))
    assert max(waits) >= 25


@pytest.fixture
def native_bert(monkeypatch, fake_torch):
    """A native-class stand-in lets CI exercise policy without downloading torch/models."""
    fp32 = object()
    monkeypatch.setattr(_FakeTorch, 'float32', fp32, raising=False)

    class BertModel:
        __module__ = 'transformers.models.bert.modeling_bert'

        def __init__(self):
            self.training = False
            self.config = types.SimpleNamespace(is_decoder=False, add_cross_attention=False)
            self._forward_hooks = {}
            self._forward_pre_hooks = {}
            self.weight = types.SimpleNamespace(
                device=types.SimpleNamespace(type='cpu'), dtype=fp32, is_floating_point=lambda: True
            )
            self.extra_modules = []

        def modules(self):
            return iter([self, *self.extra_modules])

        def parameters(self):
            return iter([self.weight])

        def buffers(self):
            return iter([])

    module = types.ModuleType(BertModel.__module__)
    module.BertModel = BertModel
    monkeypatch.setitem(sys.modules, BertModel.__module__, module)
    return _make_model(BertModel())


def test_native_cpu_policy_needs_no_machine_probe(monkeypatch, native_bert):
    """The policy works on macOS/Windows too, without Linux-only affinity or /proc."""
    monkeypatch.setattr(
        sentence_transformers_module.os,
        'sched_getaffinity',
        lambda _: pytest.fail('hardware-specific qualification'),
        raising=False,
    )
    assert SentenceTransformerLoader._local_cpu_forward_slots(native_bert) == 2


@pytest.mark.parametrize(
    'mutation',
    ['training', 'decoder', 'cross_attention', 'hook', 'pre_hook', 'forward', 'dtype', 'device', 'custom_submodule'],
)
def test_unsafe_implementations_retain_one_slot(native_bert, mutation):
    """Readonly CPU behavior, not an architecture/model/hardware name, is the boundary."""
    transformer = native_bert[0].auto_model
    if mutation == 'training':
        transformer.training = True
    elif mutation == 'decoder':
        transformer.config.is_decoder = True
    elif mutation == 'cross_attention':
        transformer.config.add_cross_attention = True
    elif mutation == 'hook':
        transformer._forward_hooks[0] = lambda: None
    elif mutation == 'pre_hook':
        transformer._forward_pre_hooks[0] = lambda: None
    elif mutation == 'forward':
        transformer.forward = lambda: None
    elif mutation == 'dtype':
        transformer.weight.dtype = object()
    elif mutation == 'device':
        transformer.weight.device.type = 'cuda'
    else:
        transformer.extra_modules.append(types.SimpleNamespace(training=False))
    assert SentenceTransformerLoader._local_cpu_forward_slots(native_bert) == 1


def test_custom_bert_subclass_remains_serial(native_bert):
    """A custom class with a BERT-compatible API is not proof of read-only forwards."""

    class CustomBert(type(native_bert[0].auto_model)):
        pass

    native_bert[0].auto_model = CustomBert()
    assert SentenceTransformerLoader._local_cpu_forward_slots(native_bert) == 1
