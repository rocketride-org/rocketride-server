"""
Unit tests for ai.common.torch.probe_cuda.

probe_cuda() reads the module-global `torch`, so each test swaps that global
for a double. No GPU and no real CUDA call is involved; the module itself
still needs torch importable, so the suite skips where it is not.

Run from project root:
  PYTHONPATH=packages/ai/src python -m pytest packages/ai/tests/ai/common/test_torch_probe.py -v
"""

import pytest

torch_module = pytest.importorskip('ai.common.torch', reason='torch is not installed in this environment')

probe_cuda = torch_module.probe_cuda


class _FakeTensor:
    """Tensor stand-in whose matmul records that a compute kernel was requested."""

    def __init__(self, recorder):
        self.recorder = recorder

    def __matmul__(self, other):
        self.recorder['gemm'] = True
        return self


class _FakeCuda:
    def __init__(self, available=True, synchronize_error=None, recorder=None):
        self._available = available
        self._synchronize_error = synchronize_error
        self.recorder = recorder if recorder is not None else {}

    def is_available(self):
        return self._available

    def synchronize(self, device=None):
        self.recorder['synchronized'] = device
        if self._synchronize_error is not None:
            raise self._synchronize_error


class _FakeTorch:
    def __init__(self, available=True, randn_error=None, synchronize_error=None):
        self.recorder = {}
        self.cuda = _FakeCuda(available, synchronize_error, self.recorder)
        self._randn_error = randn_error

    def randn(self, *shape, device=None):
        self.recorder['randn_device'] = device
        if self._randn_error is not None:
            raise self._randn_error
        return _FakeTensor(self.recorder)


def _install(monkeypatch, fake):
    monkeypatch.setattr(torch_module, 'torch', fake)
    return fake


def test_probe_succeeds_when_kernels_run(monkeypatch):
    """A device whose GEMM and synchronize both succeed probes True."""
    fake = _install(monkeypatch, _FakeTorch())

    assert probe_cuda(0) is True
    assert fake.recorder['gemm'] is True
    assert fake.recorder['synchronized'] == 'cuda:0'


def test_probe_fails_when_cuda_unavailable(monkeypatch):
    """No CUDA at all probes False without touching the device."""
    fake = _install(monkeypatch, _FakeTorch(available=False))

    assert probe_cuda(0) is False
    assert 'randn_device' not in fake.recorder


def test_probe_fails_on_synchronize_error(monkeypatch):
    """An async kernel error surfaced by synchronize() probes False.

    This is the cudaErrorNoKernelImageForDevice case: allocation and the
    matmul launch both appear to succeed, and only synchronize() reports it.
    """
    fake = _install(monkeypatch, _FakeTorch(synchronize_error=RuntimeError('no kernel image is available')))

    assert probe_cuda(0) is False
    assert fake.recorder['gemm'] is True


def test_probe_fails_on_allocation_error(monkeypatch):
    """A device that cannot even allocate probes False rather than raising."""
    _install(monkeypatch, _FakeTorch(randn_error=RuntimeError('CUDA error: invalid device ordinal')))

    assert probe_cuda(3) is False


@pytest.mark.parametrize('index', [0, 1, 7])
def test_probe_targets_the_selected_device(monkeypatch, index):
    """The probe allocates and synchronizes on the requested device, not cuda:0."""
    fake = _install(monkeypatch, _FakeTorch())

    assert probe_cuda(index) is True
    assert fake.recorder['randn_device'] == f'cuda:{index}'
    assert fake.recorder['synchronized'] == f'cuda:{index}'


def test_probe_defaults_to_device_zero(monkeypatch):
    """Called with no argument, the probe targets device 0."""
    fake = _install(monkeypatch, _FakeTorch())

    assert probe_cuda() is True
    assert fake.recorder['randn_device'] == 'cuda:0'
