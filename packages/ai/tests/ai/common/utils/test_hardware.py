# =============================================================================
# MIT License
#
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""Unit tests for ai.common.utils.hardware.

pynvml and psutil are faked (injected into sys.modules), so the probe is covered
without a GPU.
"""

import sys
import types

import pytest

from ai.common.utils import hardware
from ai.common.utils.hardware import (
    HardwareSnapshot,
    check_hardware,
    parse_hardware_requirement,
    probe_cuda_memory,
    probe_hardware,
)

GIB = 1024**3


def _install_fake_nvml(monkeypatch, gpus, driver=12080, init_error=False, mig=None):
    """gpus: list of (name, uuid, total_gb, free_gb, [(pid, used_bytes_or_None)]).

    mig: {uuid: same 5-tuple} for instances resolvable by UUID only.
    """
    mig = mig or {}
    nvml = types.ModuleType('pynvml')

    def init():
        if init_error:
            raise RuntimeError('NVML Shared Library Not Found')

    def by_uuid(uuid):
        key = uuid.decode() if isinstance(uuid, bytes) else uuid
        if key not in mig:
            raise RuntimeError('NVML_ERROR_NOT_FOUND')
        return ('mig', key)

    def rec(handle):
        return mig[handle[1]] if isinstance(handle, tuple) else gpus[handle]

    nvml.nvmlInit = init
    nvml.nvmlShutdown = lambda: None
    nvml.nvmlSystemGetCudaDriverVersion = lambda: driver
    nvml.nvmlDeviceGetCount = lambda: len(gpus)
    nvml.nvmlDeviceGetHandleByIndex = lambda i: i
    nvml.nvmlDeviceGetHandleByUUID = by_uuid
    nvml.nvmlDeviceGetName = lambda h: rec(h)[0].encode()
    nvml.nvmlDeviceGetUUID = lambda h: rec(h)[1]
    nvml.nvmlDeviceGetMemoryInfo = lambda h: types.SimpleNamespace(
        total=int(rec(h)[2] * GIB), free=int(rec(h)[3] * GIB), used=int((rec(h)[2] - rec(h)[3]) * GIB)
    )
    procs = lambda h: [types.SimpleNamespace(pid=pid, usedGpuMemory=used) for pid, used in rec(h)[4]]  # noqa: E731
    nvml.nvmlDeviceGetComputeRunningProcesses = procs
    nvml.nvmlDeviceGetGraphicsRunningProcesses = lambda h: []
    monkeypatch.setitem(sys.modules, 'pynvml', nvml)


def _install_fake_psutil(monkeypatch, total_gb=32.0, available_gb=20.0, names=None):
    names = names or {}
    psutil = types.ModuleType('psutil')
    psutil.virtual_memory = lambda: types.SimpleNamespace(total=int(total_gb * GIB), available=int(available_gb * GIB))
    psutil.Process = lambda pid: types.SimpleNamespace(name=lambda: names.get(pid, f'proc{pid}'))
    monkeypatch.setitem(sys.modules, 'psutil', psutil)


@pytest.fixture(autouse=True)
def _clean_cuda_env(monkeypatch):
    monkeypatch.delenv('CUDA_VISIBLE_DEVICES', raising=False)
    monkeypatch.delenv('CUDA_DEVICE_ORDER', raising=False)
    _install_fake_psutil(monkeypatch)


def _no_nvml(monkeypatch):
    monkeypatch.setitem(sys.modules, 'pynvml', None)


# --- probe -------------------------------------------------------------------


def test_probe_single_gpu(monkeypatch):
    _install_fake_nvml(monkeypatch, [('RTX A', 'GPU-aaa', 24.0, 20.5, [])])
    snap = probe_hardware()
    assert (snap.device, snap.name, snap.vram_total_gb, snap.vram_free_gb) == ('cuda', 'RTX A', 24.0, 20.5)
    assert (snap.ram_total_gb, snap.ram_available_gb) == (32.0, 20.0)


def test_probe_old_driver_is_not_cuda(monkeypatch):
    _install_fake_nvml(monkeypatch, [('Old', 'GPU-o', 12.0, 12.0, [])], driver=11080)
    monkeypatch.setattr(hardware, '_is_apple_silicon', lambda: False)
    assert probe_hardware().device == 'cpu'


def test_probe_nvml_unavailable_falls_back(monkeypatch):
    _install_fake_nvml(monkeypatch, [], init_error=True)
    monkeypatch.setattr(hardware, '_is_apple_silicon', lambda: False)
    assert probe_hardware().device == 'cpu'


@pytest.mark.parametrize('apple,expected', [(True, 'mps'), (False, 'cpu')])
def test_probe_without_nvidia(monkeypatch, apple, expected):
    _no_nvml(monkeypatch)
    monkeypatch.setattr(hardware, '_is_apple_silicon', lambda: apple)
    snap = probe_hardware()
    assert snap.device == expected
    assert snap.vram_total_gb is None
    assert snap.ram_total_gb == 32.0


@pytest.mark.parametrize('visible', ['', '-1', '3'])
def test_hidden_or_out_of_range_devices(monkeypatch, visible):
    _install_fake_nvml(monkeypatch, [('A', 'GPU-a', 24.0, 24.0, [])])
    monkeypatch.setenv('CUDA_VISIBLE_DEVICES', visible)
    assert probe_cuda_memory() is None


def test_uuid_prefix_selects_device(monkeypatch):
    _install_fake_nvml(monkeypatch, [('Small', 'GPU-111', 8.0, 8.0, []), ('Big', 'GPU-222', 80.0, 70.0, [])])
    monkeypatch.setenv('CUDA_VISIBLE_DEVICES', 'GPU-22,GPU-111')
    mem = probe_cuda_memory()
    assert (mem.name, mem.total_gb, mem.free_gb) == ('Big', 80.0, 70.0)


def test_mig_selector_reports_the_instance_not_its_parent(monkeypatch):
    _install_fake_nvml(
        monkeypatch,
        [('H100', 'GPU-h', 80.0, 79.0, [])],
        mig={'MIG-abc': ('H100 MIG 1g.10gb', 'MIG-abc', 10.0, 9.5, [])},
    )
    monkeypatch.setenv('CUDA_VISIBLE_DEVICES', 'MIG-abc')
    mem = probe_cuda_memory()
    assert (mem.name, mem.total_gb, mem.free_gb) == ('H100 MIG 1g.10gb', 10.0, 9.5)


def test_unresolvable_mig_selector_reports_unknown_vram(monkeypatch):
    _install_fake_nvml(monkeypatch, [('H100', 'GPU-h', 80.0, 79.0, [])])
    monkeypatch.setenv('CUDA_VISIBLE_DEVICES', 'MIG-gone')
    mem = probe_cuda_memory()
    assert (mem.name, mem.total_gb, mem.free_gb) == ('MIG-gone', None, None)
    # Still cuda, so a cuda requirement is rejected as unknown instead of measured
    # against the parent GPU's 80 GB.
    snap = probe_hardware()
    assert (snap.device, snap.vram_total_gb) == ('cuda', None)
    assert 'VRAM unknown' in check_hardware(REQ, snap).reason


def test_index_is_exact_with_pci_order(monkeypatch):
    _install_fake_nvml(monkeypatch, [('Small', 'GPU-1', 8.0, 8.0, []), ('Big', 'GPU-2', 80.0, 70.0, [])])
    monkeypatch.setenv('CUDA_DEVICE_ORDER', 'PCI_BUS_ID')
    monkeypatch.setenv('CUDA_VISIBLE_DEVICES', '1')
    assert probe_cuda_memory().name == 'Big'


@pytest.mark.parametrize('visible', [None, '1'])
def test_ambiguous_order_takes_smallest(monkeypatch, visible):
    _install_fake_nvml(monkeypatch, [('Big', 'GPU-2', 80.0, 70.0, []), ('Small', 'GPU-1', 8.0, 6.0, [])])
    if visible is not None:
        monkeypatch.setenv('CUDA_VISIBLE_DEVICES', visible)
    mem = probe_cuda_memory()
    assert (mem.total_gb, mem.free_gb) == (8.0, 6.0)
    assert mem.name == 'one of Big, Small'


def test_residents_sorted_and_named(monkeypatch):
    procs = [(10, None), (11, int(2 * GIB)), (12, int(5 * GIB)), (13, None)]
    _install_fake_nvml(monkeypatch, [('A', 'GPU-a', 24.0, 17.0, procs)])
    _install_fake_psutil(monkeypatch, names={10: 'chrome.exe', 11: 'python.exe', 12: 'engine.exe', 13: 'engine.exe'})
    assert probe_cuda_memory().residents == [
        'engine.exe[12] 5.0 GB',
        'python.exe[11] 2.0 GB',
        'engine.exe[13]',
        'chrome.exe[10]',
    ]


def test_residents_capped(monkeypatch):
    _install_fake_nvml(monkeypatch, [('A', 'GPU-a', 24.0, 17.0, [(pid, None) for pid in range(9)])])
    residents = probe_cuda_memory().residents
    assert len(residents) == 7
    assert residents[-1] == '+3 more'


def test_snapshot_roundtrip_and_describe():
    snap = HardwareSnapshot('cuda', 'RTX', 8.0, 6.5, 32.0, 20.0, ['engine.exe[1]'], 'probe')
    assert HardwareSnapshot.from_dict(snap.to_dict()) == snap
    assert snap.describe() == 'cuda RTX, 8.0 GB VRAM (6.5 GB free), 32.0 GB RAM [probe]'
    assert HardwareSnapshot(None, source='unknown', note='remote').describe() == 'unknown (remote)'


# --- requirement parsing -----------------------------------------------------


def test_parse_full_requirement():
    req = parse_hardware_requirement({'cuda': {'vramGb': 11}, 'mps': {'ramGb': 32, 'timeout': 1800}, 'cpu': False})
    assert set(req.devices) == {'cuda', 'mps'}
    assert req.devices['cuda'].vram_gb == 11.0
    assert req.devices['mps'].timeout == 1800
    assert req.need_gb('cuda') == 11.0
    assert req.need_gb('mps') == 32.0
    assert req.need_gb('cpu') is None


@pytest.mark.parametrize('value', [None, False])
def test_parse_no_requirement(value):
    assert parse_hardware_requirement(value) is None


def test_parse_true_and_empty_allow_without_minimum():
    req = parse_hardware_requirement({'cuda': True, 'cpu': {}})
    assert req.devices['cuda'].vram_gb is None
    assert req.need_gb('cpu') is None


@pytest.mark.parametrize(
    'value,message',
    [
        (True, 'expected an object or false'),
        ({'gpu': {}}, 'unknown machine class'),
        ({'cuda': {'vramGB': 12}}, 'unknown key'),
        ({'mps': {'vramGb': 12}}, 'unknown key'),
        ({'cuda': {'vramGb': 0}}, 'positive number'),
        ({'cuda': {'vramGb': '12'}}, 'positive number'),
        ({'cuda': {'vramGb': True}}, 'positive number'),
        # json.loads reads these; NaN compares False against every minimum.
        ({'cuda': {'vramGb': float('nan')}}, 'positive number'),
        ({'cuda': {'vramGb': float('inf')}}, 'positive number'),
        ({'cpu': {'timeout': 1.5}}, 'whole seconds'),
        ({'cuda': 12}, 'expected an object, true or false'),
        ({'cuda': False, 'cpu': False}, 'no machine class is allowed'),
        ({}, 'no machine class is allowed'),
    ],
)
def test_parse_rejects(value, message):
    with pytest.raises(ValueError, match=message):
        parse_hardware_requirement(value)


# --- checks ------------------------------------------------------------------

REQ = parse_hardware_requirement({'cuda': {'vramGb': 11}, 'mps': {'ramGb': 32, 'timeout': 1800}})


def _cuda(total, free, residents=()):
    return HardwareSnapshot('cuda', 'RTX', total, free, 64.0, 40.0, list(residents))


def test_check_passes_with_timeout_and_need():
    ok = check_hardware(REQ, HardwareSnapshot('mps', 'Apple Silicon', ram_total_gb=36.0))
    assert ok.ok and ok.device == 'mps' and ok.timeout == 1800 and ok.need_gb == 32.0


def test_check_device_not_allowed():
    res = check_hardware(REQ, HardwareSnapshot('cpu', 'x86_64', ram_total_gb=128.0))
    assert not res.ok
    assert res.reason == 'runs on cuda/mps only; this machine is cpu (x86_64)'


def test_check_total_vram_too_small():
    res = check_hardware(REQ, _cuda(8.0, 7.0))
    assert res.reason == 'needs 11 GB VRAM; RTX has 8.0 GB'


def test_check_free_vram_names_residents():
    res = check_hardware(REQ, _cuda(24.0, 4.0, ['engine.exe[7] 19.0 GB']))
    assert not res.ok
    assert 'only 4.0 GB of 24.0 GB free' in res.reason
    assert res.reason.endswith('(held by: engine.exe[7] 19.0 GB)')


def test_check_ram_too_small():
    res = check_hardware(REQ, HardwareSnapshot('mps', 'Apple Silicon', ram_total_gb=16.0))
    assert res.reason == 'needs 32 GB RAM; this machine has 16.0 GB'


def test_check_unknown_values():
    assert 'VRAM unknown' in check_hardware(REQ, HardwareSnapshot('cuda', 'remote')).reason
    assert 'RAM unknown' in check_hardware(REQ, HardwareSnapshot('mps')).reason
    res = check_hardware(REQ, HardwareSnapshot(None, source='unknown', note='server is remote'))
    assert res.reason == 'hardware unknown: server is remote'
