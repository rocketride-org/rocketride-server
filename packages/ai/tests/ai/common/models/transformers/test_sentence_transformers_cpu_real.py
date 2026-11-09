"""Offline real-BERT parity tests; no weights download, service or GPU required."""

from concurrent.futures import ThreadPoolExecutor
import sys
import threading
import types

import pytest

from ai.common.models.transformers.sentence_transformers import SentenceTransformerLoader


class _OverlapWitness:
    """Wrap a model gate: the first two holders meet inside it, and the peak is recorded."""

    def __init__(self, gate):
        self.gate = gate
        self.meet = threading.Barrier(2, timeout=5)
        self.lock = threading.Lock()
        self.entered = 0
        self.active = 0
        self.peak = 0

    def __enter__(self):
        self.gate.__enter__()
        with self.lock:
            self.entered += 1
            first_pair = self.entered <= 2
            self.active += 1
            self.peak = max(self.peak, self.active)
        if first_pair:
            try:
                self.meet.wait()
            except threading.BrokenBarrierError:
                # A serial gate never admits the pair; release it so the test fails, not hangs.
                self.__exit__(None, None, None)
                raise
        return self

    def __exit__(self, *exc):
        with self.lock:
            self.active -= 1
        return self.gate.__exit__(*exc)


@pytest.mark.parametrize('hidden_size,layers', [(32, 2), (48, 3)])
def test_native_bert_concurrent_outputs_and_state_match_serial(monkeypatch, hidden_size, layers):
    """Mixed request sizes keep their results and never mutate shared weights/buffers."""
    torch = pytest.importorskip('torch')
    bert_module = pytest.importorskip('transformers.models.bert.modeling_bert')
    from transformers import BertConfig

    bridge = types.ModuleType('ai.common.torch')
    bridge.torch = torch
    monkeypatch.setitem(sys.modules, 'ai.common.torch', bridge)

    # Random, small native BERTs exercise the real implementation offline. Model
    # and machine names are deliberately absent; no production math threads change.
    config = BertConfig(
        vocab_size=101,
        hidden_size=hidden_size,
        num_hidden_layers=layers,
        num_attention_heads=4,
        intermediate_size=hidden_size * 2,
        max_position_embeddings=64,
    )
    with torch.random.fork_rng():
        torch.manual_seed(19)
        transformer = bert_module.BertModel(config).eval()

    class ModelBundle(list):
        pass

    model = ModelBundle([types.SimpleNamespace(auto_model=transformer)])
    assert SentenceTransformerLoader._local_cpu_forward_slots(model) == 2
    before = {key: value.clone() for key, value in transformer.state_dict().items()}
    buffers = {key: value.clone() for key, value in transformer.named_buffers()}
    requests = []
    for i in range(24):
        batch, length = 1 + i % 4, 1 + (i * 7) % 47
        ids = (torch.arange(batch * length).reshape(batch, length) + i) % config.vocab_size
        mask = torch.ones_like(ids)
        if length > 2:
            mask[:, -1] = 0
        requests.append({'encoded': {'input_ids': ids, 'attention_mask': mask}, 'batch_size': batch})

    def infer(request, local):
        return SentenceTransformerLoader.inference(model, request, {'device': 'cpu'}, _local_cpu=local)

    expected = [infer(request, False) for request in requests]
    # Retire the serial test gate only while idle, to compare both policies on
    # precisely the same weights. Production never replaces a live model's gate.
    SentenceTransformerLoader._drop_model_lock(id(model))
    # Small models finish too fast to overlap by chance: the first two forwards
    # wait for each other inside the real gate, so the comparison covers overlap.
    witness = _OverlapWitness(SentenceTransformerLoader._get_model_lock(model, local_cpu=True))
    SentenceTransformerLoader._model_locks[id(model)] = witness
    with ThreadPoolExecutor(max_workers=8) as pool:
        actual = list(pool.map(lambda request: infer(request, True), requests))
    assert witness.peak == 2

    for serial, concurrent in zip(expected, actual):
        assert not concurrent.requires_grad
        assert torch.isfinite(concurrent).all()
        assert torch.equal(serial, concurrent)
    for key, value in transformer.state_dict().items():
        assert torch.equal(before[key], value), key
    for key, value in transformer.named_buffers():
        assert torch.equal(buffers[key], value), key
