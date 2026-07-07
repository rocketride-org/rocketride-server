"""Unit tests for ai.common.utils.cuda_utils.

torch is faked (injected into sys.modules) so the device/dtype pickers are
covered without a real torch install.
"""

import sys
import types

import pytest

from ai.common.utils import cuda_utils
from ai.common.utils.cuda_utils import pick_torch_device, pick_torch_dtype, resolve_pipeline_device


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
