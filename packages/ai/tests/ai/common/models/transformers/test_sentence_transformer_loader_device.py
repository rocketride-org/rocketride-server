"""
Unit tests for local-mode device selection in SentenceTransformerLoader.load.

Covers the CPU fallback path: when the CUDA kernel probe fails, the loader must
build the model on CPU instead of the requested device. The real sentence
transformer package is never imported; a double records the device it was
handed.

Run from project root:
  PYTHONPATH=packages/ai/src python -m pytest \
    packages/ai/tests/ai/common/models/transformers/test_sentence_transformer_loader_device.py -v
"""

import sys
import types

import pytest

import ai.common.models.transformers.sentence_transformers as sentence_transformers_module

SentenceTransformerLoader = sentence_transformers_module.SentenceTransformerLoader


class _FakeModel:
    """Records the device it was constructed on and satisfies the metadata reads."""

    max_seq_length = 128

    def __init__(self, model_name_or_path=None, device=None, **kwargs):
        self.model_name_or_path = model_name_or_path
        self.device = device
        self.kwargs = kwargs

    def eval(self):
        return self

    def get_sentence_embedding_dimension(self):
        return 384


@pytest.fixture
def loader_env(monkeypatch):
    """Stub the sentence_transformers package, ai.common.torch, and dependency loading."""
    built = {}

    def fake_st(model_name_or_path=None, device=None, **kwargs):
        model = _FakeModel(model_name_or_path=model_name_or_path, device=device, **kwargs)
        built['model'] = model
        return model

    st_module = types.ModuleType('sentence_transformers')
    st_module.SentenceTransformer = fake_st
    monkeypatch.setitem(sys.modules, 'sentence_transformers', st_module)

    monkeypatch.setattr(SentenceTransformerLoader, '_ensure_dependencies', classmethod(lambda cls: None))
    monkeypatch.setattr(SentenceTransformerLoader, '_get_memory_footprint', staticmethod(lambda model: 0.5))

    torch_module = types.ModuleType('ai.common.torch')

    def configure(probe_result=True, cuda_available=True):
        torch_module.torch = types.SimpleNamespace(cuda=types.SimpleNamespace(is_available=lambda: cuda_available))
        torch_module.probe_cuda = lambda index=0: probe_result
        built['probed'] = []
        original = torch_module.probe_cuda

        def recording_probe(index=0):
            built['probed'].append(index)
            return original(index)

        torch_module.probe_cuda = recording_probe
        monkeypatch.setitem(sys.modules, 'ai.common.torch', torch_module)
        return built

    return configure


def test_load_falls_back_to_cpu_when_probe_fails(loader_env):
    """An explicit CUDA device whose probe fails builds the model on CPU."""
    built = loader_env(probe_result=False)

    model, metadata, gpu_index = SentenceTransformerLoader.load('all-MiniLM-L6-v2', device='cuda:0')

    assert built['model'].device == 'cpu'
    assert metadata['device'] == 'cpu'
    assert gpu_index == -1
    assert built['probed'] == [0]


def test_load_keeps_gpu_when_probe_succeeds(loader_env):
    """A passing probe leaves the requested device untouched."""
    built = loader_env(probe_result=True)

    model, metadata, gpu_index = SentenceTransformerLoader.load('all-MiniLM-L6-v2', device='cuda:1')

    assert built['model'].device == 'cuda:1'
    assert metadata['device'] == 'cuda:1'
    assert gpu_index == 1
    assert built['probed'] == [1]


def test_load_probes_the_requested_device_index(loader_env):
    """The probe runs against the requested ordinal, not a hardcoded device 0."""
    built = loader_env(probe_result=True)

    SentenceTransformerLoader.load('all-MiniLM-L6-v2', device='cuda:3')

    assert built['probed'] == [3]


def test_bare_cuda_probes_device_zero(loader_env):
    """A bare 'cuda' device probes ordinal 0."""
    built = loader_env(probe_result=True)

    SentenceTransformerLoader.load('all-MiniLM-L6-v2', device='cuda')

    assert built['probed'] == [0]


def test_cpu_request_skips_the_probe(loader_env):
    """An explicit CPU request never touches the probe."""
    built = loader_env(probe_result=False)

    model, metadata, gpu_index = SentenceTransformerLoader.load('all-MiniLM-L6-v2', device='cpu')

    assert built['model'].device == 'cpu'
    assert gpu_index == -1
    assert built['probed'] == []


def test_autodetect_falls_back_to_cpu_when_probe_fails(loader_env):
    """With device=None on a CUDA host, a failed probe still lands on CPU."""
    built = loader_env(probe_result=False, cuda_available=True)

    model, metadata, gpu_index = SentenceTransformerLoader.load('all-MiniLM-L6-v2')

    assert built['model'].device == 'cpu'
    assert metadata['device'] == 'cpu'
    assert gpu_index == -1
