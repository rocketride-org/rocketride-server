"""Unit tests for EasyOCR load-failure handling across local and server mode.

A GPU load failure may degrade to CPU only in local mode. In server mode
allocate_gpu() holds a reservation for this model, so the failure has to
surface and let the caller release it instead of quietly running on CPU while
the allocator still counts the GPU as taken.

The real easyocr and torch packages are never imported; doubles record which
device each construction attempt asked for.

Run from project root:
  PYTHONPATH=packages/ai/src python -m pytest \
    packages/ai/tests/ai/common/models/test_easyocr_device.py -v
"""

import sys
import types

import pytest

from ai.common.models.ocr.easyocr import EasyOCRLoader


class _FakeReader:
    """Stands in for easyocr.Reader; records the gpu flag it was given."""

    def __init__(self, languages, gpu=False, verbose=False, **kwargs):
        self.languages = languages
        self.gpu = gpu


@pytest.fixture
def easyocr_env(monkeypatch):
    """Stub easyocr, opencv, ai.common.torch and dependency loading."""
    attempts = []

    def make_reader_factory(fail_on_gpu):
        def factory(languages, gpu=False, verbose=False, **kwargs):
            attempts.append({'gpu': gpu})
            if gpu and fail_on_gpu:
                raise RuntimeError('CUDA error: out of memory')
            return _FakeReader(languages, gpu=gpu, verbose=verbose)

        return factory

    easyocr_module = types.ModuleType('easyocr')
    monkeypatch.setitem(sys.modules, 'easyocr', easyocr_module)

    opencv_module = types.ModuleType('ai.common.opencv')
    opencv_module.cv2 = object()
    monkeypatch.setitem(sys.modules, 'ai.common.opencv', opencv_module)

    # Minimal torch surface: the DataParallel unwrap below only needs the
    # isinstance checks to be answerable and torch.device to be constructible.
    class _FakeDataParallel:
        pass

    class _FakeModule:
        pass

    torch_module = types.ModuleType('ai.common.torch')
    torch_module.torch = types.SimpleNamespace(
        cuda=types.SimpleNamespace(is_available=lambda: True),
        device=lambda spec: spec,
        nn=types.SimpleNamespace(DataParallel=_FakeDataParallel, Module=_FakeModule),
    )
    torch_module.probe_cuda = lambda index: True
    monkeypatch.setitem(sys.modules, 'ai.common.torch', torch_module)

    monkeypatch.setattr(EasyOCRLoader, '_ensure_dependencies', classmethod(lambda cls: None))

    def configure(fail_on_gpu=False, probe_result=True):
        easyocr_module.Reader = make_reader_factory(fail_on_gpu)
        torch_module.probe_cuda = lambda index: probe_result
        return attempts

    return configure


def test_local_mode_retries_on_cpu_when_gpu_load_fails(easyocr_env):
    """Local mode has no reservation to honour, so it may degrade to CPU."""
    attempts = easyocr_env(fail_on_gpu=True)

    bundle, metadata, gpu_index = EasyOCRLoader.load('easyocr', device='cuda:0')

    assert [a['gpu'] for a in attempts] == [True, False]
    assert bundle['device'] == 'cpu'
    assert metadata['device'] == 'cpu'
    assert gpu_index == -1


def test_server_mode_does_not_retry_on_cpu_when_gpu_load_fails(easyocr_env):
    """Server mode must surface the failure so the allocator can release the GPU."""
    attempts = easyocr_env(fail_on_gpu=True)

    def allocate_gpu(memory_gb, exclude_gpus):
        return 1, 'cuda:1'

    with pytest.raises(Exception, match='Failed to load EasyOCR'):
        EasyOCRLoader.load('easyocr', allocate_gpu=allocate_gpu)

    # One GPU attempt and no CPU retry behind the allocator's back.
    assert [a['gpu'] for a in attempts] == [True]


def test_server_mode_failure_preserves_the_original_cause(easyocr_env):
    """The wrapped error keeps its __cause__ so the traceback survives."""
    easyocr_env(fail_on_gpu=True)

    def allocate_gpu(memory_gb, exclude_gpus):
        return 0, 'cuda:0'

    with pytest.raises(Exception) as excinfo:
        EasyOCRLoader.load('easyocr', allocate_gpu=allocate_gpu)

    assert isinstance(excinfo.value.__cause__, RuntimeError)
    assert 'out of memory' in str(excinfo.value.__cause__)


def test_local_mode_cpu_request_never_attempts_gpu(easyocr_env):
    """An explicit CPU request skips the GPU path entirely."""
    attempts = easyocr_env(fail_on_gpu=True)

    bundle, metadata, gpu_index = EasyOCRLoader.load('easyocr', device='cpu')

    assert [a['gpu'] for a in attempts] == [False]
    assert bundle['device'] == 'cpu'
    assert gpu_index == -1


def test_local_mode_failed_probe_loads_on_cpu_without_gpu_attempt(easyocr_env):
    """A failed kernel probe means the GPU is never handed to easyocr at all."""
    attempts = easyocr_env(fail_on_gpu=True, probe_result=False)

    bundle, metadata, gpu_index = EasyOCRLoader.load('easyocr', device='cuda:0')

    assert [a['gpu'] for a in attempts] == [False]
    assert bundle['device'] == 'cpu'
    assert gpu_index == -1
