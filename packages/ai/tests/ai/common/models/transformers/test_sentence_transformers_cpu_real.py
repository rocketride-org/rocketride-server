"""Real BERT on the local CPU path: forwards that share CPU slots give the serial results (no download, no GPU)."""

import contextlib
import functools
import sys
import threading
import types

import pytest

import ai.common.models.device_budget as budget_module
from ai.common.models.device_budget import DeviceBudget
from ai.common.models.transformers.sentence_transformers import SentenceTransformer, SentenceTransformerLoader

_MINILM = 'sentence-transformers/all-MiniLM-L6-v2'


class _OverlapWitness(DeviceBudget):
    """A four-slot CPU guard whose first two calls wait for each other inside, recording the peak inside."""

    def __init__(self):
        """Start with nothing inside."""
        super().__init__('cpu', slots=4)
        self.meet = threading.Barrier(2, timeout=10)
        self._count = threading.Lock()
        self.entered = 0
        self.active = 0
        self.peak = 0

    @contextlib.contextmanager
    def reserve(self, cost_mb, model=None, calls=1):
        """Hold a place as the real guard does; the first two holders meet before running.

        Args:
            cost_mb: The call's cost in MB, or ``None``.
            model: The model copy the call names.
            calls: How many calls of that model may be inside at once.

        Yields:
            None, while the call holds its place.
        """
        with super().reserve(cost_mb, model=model, calls=calls):
            with self._count:
                self.entered += 1
                first_pair = self.entered <= 2
                self.active += 1
                self.peak = max(self.peak, self.active)
            try:
                # small models finish too fast to overlap by chance; a serial guard breaks the barrier
                if first_pair:
                    self.meet.wait()
                yield
            finally:
                with self._count:
                    self.active -= 1


def _real_torch(monkeypatch):
    """Give ``ai.common.torch`` the installed torch, without its dependency install.

    Args:
        monkeypatch: The test's monkeypatch fixture.

    Returns:
        The torch module.
    """
    torch = pytest.importorskip('torch')
    pytest.importorskip('transformers')
    bridge = types.ModuleType('ai.common.torch')
    bridge.torch = torch
    monkeypatch.setitem(sys.modules, 'ai.common.torch', bridge)
    return torch


def test_minilm_forwards_in_cpu_slots_match_serial(monkeypatch, map_in_threads):
    """MiniLM through the local facade on CPU qualifies and gives the serial vectors from 8 threads on 4 slots."""
    np = pytest.importorskip('numpy')
    _real_torch(monkeypatch)
    pytest.importorskip('sentence_transformers')
    monkeypatch.setattr(SentenceTransformerLoader, '_ensure_dependencies', classmethod(lambda cls: None))
    try:
        encoder = SentenceTransformer(_MINILM, device='cpu', local_files_only=True)
    except OSError as e:
        pytest.skip(f'{_MINILM} is not in the local Hugging Face cache ({e})')
    assert SentenceTransformerLoader._local_cpu_calls(encoder._model) == SentenceTransformerLoader.LOCAL_CPU_CALLS

    words = 'the engine reads each page and splits its text into chunks before embedding them'.split()
    batches = [[' '.join(words[: 1 + (i * 7 + j * 3) % len(words)]) for j in range(1 + i % 4)] for i in range(24)]
    monkeypatch.setitem(budget_module._budgets, 'cpu', DeviceBudget('cpu', slots=4))
    serial = [encoder.encode(batch) for batch in batches]

    witness = _OverlapWitness()
    monkeypatch.setitem(budget_module._budgets, 'cpu', witness)
    concurrent = map_in_threads(encoder.encode, batches, workers=8, finish_s=60.0)

    assert witness.peak > 1
    for alone, shared in zip(serial, concurrent):
        assert np.allclose(alone, shared, rtol=0, atol=1e-6)


def test_a_small_random_bert_keeps_its_results_and_weights(monkeypatch, map_in_threads):
    """A random stock BertModel (no model files) gives the serial outputs from 8 threads and keeps its weights."""
    torch = _real_torch(monkeypatch)
    from transformers import BertConfig
    from transformers.models.bert.modeling_bert import BertModel

    config = BertConfig(
        vocab_size=101,
        hidden_size=48,
        num_hidden_layers=3,
        num_attention_heads=4,
        intermediate_size=96,
        max_position_embeddings=64,
    )
    # devices=[]: only the CPU generator is saved and seeded, never a GPU's
    with torch.random.fork_rng(devices=[]):
        torch.random.default_generator.manual_seed(19)
        transformer = BertModel(config).eval()

    class ModelBundle(list):
        """Weak-referenceable, like a loaded SentenceTransformer."""

    model = ModelBundle([types.SimpleNamespace(auto_model=transformer)])
    assert SentenceTransformerLoader._local_cpu_calls(model) == SentenceTransformerLoader.LOCAL_CPU_CALLS
    before = {key: value.clone() for key, value in transformer.state_dict().items()}
    requests = []
    for i in range(24):
        batch, length = 1 + i % 4, 1 + (i * 7) % 47
        ids = (torch.arange(batch * length).reshape(batch, length) + i) % config.vocab_size
        mask = torch.ones_like(ids)
        if length > 2:
            mask[:, -1] = 0
        requests.append({'encoded': {'input_ids': ids, 'attention_mask': mask}, 'batch_size': batch})

    def infer(request, local):
        """Run one request, on the CPU slots when ``local``, else behind the model's lock."""
        return SentenceTransformerLoader.inference(model, request, {'device': 'cpu'}, _local_cpu=local)

    expected = [infer(request, False) for request in requests]
    witness = _OverlapWitness()
    monkeypatch.setitem(budget_module._budgets, 'cpu', witness)
    actual = map_in_threads(lambda request: infer(request, True), requests, workers=8, finish_s=60.0)

    assert witness.peak > 1
    for serial, concurrent in zip(expected, actual):
        assert torch.allclose(serial, concurrent, rtol=0, atol=1e-6)
    for key, value in transformer.state_dict().items():
        assert torch.equal(before[key], value), key


def test_a_forward_replaced_on_a_bert_class_keeps_one_call(monkeypatch):
    """A real BertModel qualifies until a ``forward`` is set on one of its classes, as a plain function or a wrapper."""
    _real_torch(monkeypatch)
    from transformers import BertConfig
    from transformers.models.bert import modeling_bert

    config = BertConfig(
        vocab_size=101, hidden_size=48, num_hidden_layers=1, num_attention_heads=4, intermediate_size=96
    )
    model = [types.SimpleNamespace(auto_model=modeling_bert.BertModel(config).eval())]
    check = SentenceTransformerLoader._local_cpu_forward_calls
    assert check(model) == SentenceTransformerLoader.LOCAL_CPU_CALLS
    stock = modeling_bert.BertIntermediate.forward

    def plain(self, hidden_states):
        """Stand in for a forward that a tracing library sets on the class."""
        return stock(self, hidden_states)

    @functools.wraps(stock)
    def wrapped(self, hidden_states):
        """The same, carrying the stock forward's name and ``__module__``."""
        return stock(self, hidden_states)

    for replaced in (plain, wrapped):
        with monkeypatch.context() as patch:
            patch.setattr(modeling_bert.BertIntermediate, 'forward', replaced)
            assert check(model) == 1
    assert check(model) == SentenceTransformerLoader.LOCAL_CPU_CALLS
