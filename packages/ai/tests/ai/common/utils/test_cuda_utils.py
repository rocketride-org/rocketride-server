"""Unit tests for ai.common.utils.cuda_utils.

torch is faked (injected into sys.modules) so the device/dtype pickers are
covered without a real torch install.
"""

import logging
import sys
import types

import pytest

from ai.common.utils import cuda_utils
from ai.common.utils.cuda_utils import (
    pick_torch_device,
    pick_torch_dtype,
    resolve_pipeline_device,
    select_torch_device,
)


@pytest.fixture(autouse=True)
def _fresh_cuda_check():
    """Forget which CUDA ordinals were checked, so each test sees its own runtime."""
    cuda_utils._cuda_kernels_run.cache_clear()
    yield
    cuda_utils._cuda_kernels_run.cache_clear()


def _install_fake_torch(monkeypatch, *, cuda=False, mps=False):
    """Inject a minimal fake ai.common.torch so the pickers run without real torch."""
    torch = types.SimpleNamespace(
        cuda=types.SimpleNamespace(is_available=lambda: cuda),
        backends=types.SimpleNamespace(mps=types.SimpleNamespace(is_available=lambda: mps)),
        float16='float16',
        float32='float32',
        bfloat16='bfloat16',
    )
    pkg = types.ModuleType('ai.common.torch')
    pkg.torch = torch
    monkeypatch.setitem(sys.modules, 'ai.common.torch', pkg)
    return torch


@pytest.mark.parametrize(
    'cuda,mps,expected',
    [(True, False, 'cuda:0'), (False, True, 'mps'), (False, False, 'cpu'), (True, True, 'cuda:0')],
)
def test_pick_torch_device(monkeypatch, cuda, mps, expected):
    _install_fake_torch(monkeypatch, cuda=cuda, mps=mps)
    assert pick_torch_device() == expected


@pytest.mark.parametrize(
    'device,kwargs,expected',
    [
        ('cuda:0', {}, 'float32'),
        ('cuda:1', {'cuda': 'float16'}, 'float16'),
        ('mps', {'mps': 'bfloat16'}, 'bfloat16'),
        ('cpu', {}, 'float32'),
    ],
)
def test_pick_torch_dtype(monkeypatch, device, kwargs, expected):
    _install_fake_torch(monkeypatch)
    assert pick_torch_dtype(device, **kwargs) == expected


@pytest.mark.parametrize(
    'device,expected',
    [
        ('cpu', (-1, 'cpu')),
        ('mps', ('mps', 'mps')),
        ('cuda', (0, 'cuda:0')),
        ('cuda:0', (0, 'cuda:0')),
        ('cuda:2', (2, 'cuda:2')),
    ],
)
def test_resolve_pipeline_device_explicit(device, expected):
    assert resolve_pipeline_device(device) == expected


def test_resolve_pipeline_device_default_uses_pick(monkeypatch):
    monkeypatch.setattr(cuda_utils, 'pick_torch_device', lambda: 'cuda:1')
    assert resolve_pipeline_device(None) == (1, 'cuda:1')


# -----------------------------------------------------------------------------
# select_torch_device
# -----------------------------------------------------------------------------


class _Device:
    """Stands in for torch.device: the helper sees only its str() form, 'cuda:1', 'mps' and so on."""

    def __init__(self, name):
        self.name = name

    def __str__(self):
        return self.name


@pytest.fixture
def cuda_check(monkeypatch):
    """Replace the CUDA check: ``works`` says which ordinals run, ``checked`` lists the ones asked about.

    ``current`` is torch's current CUDA device, which an unindexed 'cuda' means.
    """
    state = types.SimpleNamespace(works={}, checked=[], current=0)
    torch = types.SimpleNamespace(
        cuda=types.SimpleNamespace(is_available=lambda: True, current_device=lambda: state.current)
    )
    pkg = types.ModuleType('ai.common.torch')
    pkg.torch = torch
    monkeypatch.setitem(sys.modules, 'ai.common.torch', pkg)

    def check(index):
        state.checked.append(index)
        return state.works.get(index, True)

    monkeypatch.setattr(cuda_utils, '_cuda_kernels_run', check)
    return state


@pytest.mark.parametrize(
    'device,expected',
    [
        ('cpu', ('cpu', -1)),
        (-1, ('cpu', -1)),
        (_Device('cpu'), ('cpu', -1)),
        (_Device('cpu:0'), ('cpu', -1)),
        ('mps', ('mps', -1)),
        (_Device('mps'), ('mps', -1)),
        (_Device('mps:0'), ('mps', -1)),
        ('cuda', ('cuda:0', 0)),
        (0, ('cuda:0', 0)),
        (_Device('cuda'), ('cuda:0', 0)),
        ('cuda:1', ('cuda:1', 1)),
        (2, ('cuda:2', 2)),
        (_Device('cuda:1'), ('cuda:1', 1)),
    ],
)
def test_select_torch_device_takes_every_device_form(cuda_check, device, expected):
    """Strings, CUDA indexes (-1 for CPU, as a HF pipeline takes it) and torch.device values all resolve."""
    assert select_torch_device(device) == expected


def test_select_torch_device_checks_only_cuda_devices(cuda_check):
    """CPU and MPS are used as given; a CUDA device is checked by its ordinal."""
    for device in ('cpu', 'mps', -1, _Device('mps')):
        select_torch_device(device)
    assert cuda_check.checked == []

    select_torch_device(_Device('cuda:1'))
    assert cuda_check.checked == [1]


@pytest.mark.parametrize('device', ['cuda', _Device('cuda')])
def test_an_unindexed_cuda_device_is_the_current_one(cuda_check, device):
    """To torch, 'cuda' is the current device, which another loader may have set to GPU 1."""
    cuda_check.current = 1

    assert select_torch_device(device) == ('cuda:1', 1)
    assert cuda_check.checked == [1]


def test_the_auto_picked_device_is_not_the_current_one(monkeypatch, cuda_check):
    """The automatic choice stays cuda:0, whatever the current device."""
    monkeypatch.setattr(cuda_utils, 'pick_torch_device', lambda: 'cuda:0')
    cuda_check.current = 1

    assert select_torch_device() == ('cuda:0', 0)


def test_select_torch_device_falls_back_to_cpu_when_cuda_cannot_run(cuda_check, caplog):
    cuda_check.works[1] = False

    with caplog.at_level(logging.WARNING, logger='rocketlib.models.cuda'):
        assert select_torch_device('cuda:1') == ('cpu', -1)
    assert 'cuda:1 cannot run the model' in caplog.text

    # Another GPU that works is still used
    assert select_torch_device('cuda:0') == ('cuda:0', 0)


def test_select_torch_device_checks_the_auto_picked_device(monkeypatch, cuda_check):
    monkeypatch.setattr(cuda_utils, 'pick_torch_device', lambda: 'cuda:0')
    cuda_check.works[0] = False
    assert select_torch_device() == ('cpu', -1)

    monkeypatch.setattr(cuda_utils, 'pick_torch_device', lambda: 'mps')
    assert select_torch_device(None) == ('mps', -1)


def test_select_torch_device_rejects_a_bool():
    """True is an int, but not a CUDA index anyone means."""
    with pytest.raises(TypeError):
        select_torch_device(True)


# -----------------------------------------------------------------------------
# The CUDA check
# -----------------------------------------------------------------------------


def _install_fake_cuda(monkeypatch, *, available=True, count=1, failure=None):
    """Inject a fake CUDA runtime; ``failure`` is raised when the device is synchronized.

    A missing kernel image is reported asynchronously, at the next
    synchronization, so that is where the fake raises it. The fake cannot show
    that a matrix multiply reaches a kernel the real GPU lacks; it pins down
    what the check concludes from each runtime answer, and that it asks once.
    """
    runs = []

    class _Tensor:
        def __matmul__(self, other):
            return self

        def sum(self):
            return self

        def item(self):
            return 512.0

    def ones(shape, device):
        runs.append(device)
        return _Tensor()

    def synchronize(index):
        if failure is not None:
            raise failure

    torch = types.SimpleNamespace(
        ones=ones,
        cuda=types.SimpleNamespace(
            is_available=lambda: available,
            device_count=lambda: count,
            synchronize=synchronize,
        ),
    )
    pkg = types.ModuleType('ai.common.torch')
    pkg.torch = torch
    monkeypatch.setitem(sys.modules, 'ai.common.torch', pkg)
    return runs


def test_the_cuda_check_passes_a_device_that_computes(monkeypatch):
    _install_fake_cuda(monkeypatch, count=2)
    assert cuda_utils._cuda_kernels_run(1) is True


def test_the_cuda_check_fails_a_device_without_a_kernel_image(monkeypatch, caplog):
    error = RuntimeError('CUDA error: no kernel image is available for execution on the device')
    _install_fake_cuda(monkeypatch, failure=error)

    with caplog.at_level(logging.WARNING, logger='rocketlib.models.cuda'):
        assert cuda_utils._cuda_kernels_run(0) is False
    assert 'no kernel image' in caplog.text


@pytest.mark.parametrize('available,count,index', [(False, 0, 0), (True, 1, 1)], ids=['no-cuda', 'no-such-ordinal'])
def test_the_cuda_check_fails_a_device_that_is_not_there(monkeypatch, available, count, index):
    runs = _install_fake_cuda(monkeypatch, available=available, count=count)
    assert cuda_utils._cuda_kernels_run(index) is False
    assert runs == []  # nothing is allocated on a device that does not exist


def test_the_cuda_check_runs_once_per_ordinal(monkeypatch):
    """Every later load of a model reuses the answer instead of computing on the GPU again."""
    runs = _install_fake_cuda(monkeypatch, count=2)

    for _ in range(3):
        cuda_utils._cuda_kernels_run(0)
        cuda_utils._cuda_kernels_run(1)

    assert runs == ['cuda:0', 'cuda:1']
