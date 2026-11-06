"""docTR is placed on the device its loader chose (no torch or docTR needed)."""

import sys
import types

import pytest

from ai.common.models.ocr.doctr import DocTRLoader


class _Predictor:
    """docTR predictor stand-in: records where it is moved."""

    def __init__(self):
        """Start on CPU."""
        self.moves = []

    def to(self, device):
        """Record a move.

        Args:
            device: The target device.

        Returns:
            This predictor.
        """
        self.moves.append(str(device))
        return self

    def cuda(self, device=None):
        """Record a move to the current CUDA device, as torch does without an index.

        Args:
            device: Ignored; torch's default is the current device.

        Returns:
            This predictor.
        """
        self.moves.append('cuda:0 (current)')
        return self


@pytest.fixture
def predictor(monkeypatch):
    """Stub docTR, opencv and torch, and return the predictor ``ocr_predictor`` builds.

    Args:
        monkeypatch: pytest's monkeypatch fixture.

    Returns:
        The stand-in predictor.
    """
    built = _Predictor()
    models = types.SimpleNamespace(ocr_predictor=lambda **kw: built)
    cuda = types.SimpleNamespace(is_available=lambda: True)
    monkeypatch.setattr(DocTRLoader, '_ensure_dependencies', staticmethod(lambda: None))
    monkeypatch.setitem(sys.modules, 'doctr', types.SimpleNamespace(models=models))
    monkeypatch.setitem(sys.modules, 'doctr.models', models)
    monkeypatch.setitem(sys.modules, 'ai.common.opencv', types.SimpleNamespace(cv2=None))
    monkeypatch.setitem(sys.modules, 'ai.common.torch', types.SimpleNamespace(torch=types.SimpleNamespace(cuda=cuda)))
    return built


def test_the_predictor_goes_to_the_allocated_gpu(predictor):
    """A model server that allocates ``cuda:1`` gets the predictor on ``cuda:1``, not on the current device."""
    bundle, metadata, gpu_index = DocTRLoader.load(allocate_gpu=lambda memory_gb, exclude: (1, 'cuda:1'))
    assert predictor.moves == ['cuda:1']
    assert bundle['device'] == metadata['device'] == 'cuda:1'
    assert gpu_index == 1


def test_the_predictor_goes_to_the_named_gpu(predictor):
    """An explicit ``cuda:1`` places the predictor there."""
    DocTRLoader.load(device='cuda:1')
    assert predictor.moves == ['cuda:1']


def test_the_predictor_stays_on_cpu(predictor):
    """On CPU the predictor is not moved."""
    bundle, _, gpu_index = DocTRLoader.load(device='cpu')
    assert predictor.moves == []
    assert bundle['device'] == 'cpu'
    assert gpu_index == -1
