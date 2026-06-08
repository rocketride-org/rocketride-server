"""
Unit tests for ai.common.models.transformers.sentence_transformers.

Focus areas:
- Concurrency serialization in local encode path
"""

from concurrent.futures import ThreadPoolExecutor
import threading
import time

import numpy as np

import ai.common.models.transformers.sentence_transformers as sentence_transformers_module


def test_encode_local_serializes_concurrent_inference(monkeypatch):
    """Local SentenceTransformer.encode serializes shared model access."""
    active_calls = 0
    max_active_calls = 0
    state_lock = threading.Lock()

    def fake_get_model_server_address():
        return None

    def fake_load(model_name, device=None, allocate_gpu=None, exclude_gpus=None, **kwargs):
        metadata = {
            'embedding_dimension': 1,
            'max_seq_length': 128,
            'device': device or 'cpu',
            'model_name': model_name,
            'loader': 'sentence_transformer',
            'estimated_memory_gb': 0.0,
        }
        return object(), metadata, -1

    def fake_preprocess(model, inputs, metadata=None):
        return {
            'encoded': {'input_ids': inputs},
            'batch_size': len(inputs),
        }

    def fake_inference(model, preprocessed, metadata=None, stream=None):
        nonlocal active_calls, max_active_calls
        with state_lock:
            active_calls += 1
            if active_calls > max_active_calls:
                max_active_calls = active_calls

        # Simulate GPU call overlap window.
        time.sleep(0.02)

        with state_lock:
            active_calls -= 1

        return [[0.25] for _ in range(preprocessed['batch_size'])]

    def fake_postprocess(model, raw_output, batch_size, output_fields, **kwargs):
        return [{'$embeddings': row} for row in raw_output]

    monkeypatch.setattr(sentence_transformers_module, 'get_model_server_address', fake_get_model_server_address)
    monkeypatch.setattr(
        sentence_transformers_module.SentenceTransformerLoader,
        'load',
        staticmethod(fake_load),
    )
    monkeypatch.setattr(
        sentence_transformers_module.SentenceTransformerLoader,
        'preprocess',
        staticmethod(fake_preprocess),
    )
    monkeypatch.setattr(
        sentence_transformers_module.SentenceTransformerLoader,
        'inference',
        staticmethod(fake_inference),
    )
    monkeypatch.setattr(
        sentence_transformers_module.SentenceTransformerLoader,
        'postprocess',
        staticmethod(fake_postprocess),
    )

    model = sentence_transformers_module.SentenceTransformer('nomic-ai/nomic-embed-text-v1.5', device='cpu')

    def run_encode(worker_idx):
        sentences = [f'search_document: worker-{worker_idx}-item-{i}' for i in range(4)]
        return model.encode(sentences, batch_size=2)

    with ThreadPoolExecutor(max_workers=4) as executor:
        results = list(executor.map(run_encode, range(8)))

    assert max_active_calls == 1
    for result in results:
        assert isinstance(result, np.ndarray)
        assert result.shape == (4, 1)
