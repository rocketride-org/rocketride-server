# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Unit tests for the dynamic-test gate (framework.gate), warmup selection, and conftest marks."""

from types import SimpleNamespace

import pytest

from ai.common.utils.hardware import CudaMemory, HardwareSnapshot

from . import conftest
from .framework import gate, warmup
from .framework.discovery import NodeTestConfig

HEAVY = {'cuda': {'vramGb': 11}, 'mps': {'ramGb': 32, 'timeout': 1800}}


def _config(name='node', profiles=('p',), capabilities=(), requires=(), libs=(), hardware=None, timeout=60, **kw):
    return NodeTestConfig(
        node_name=name,
        provider=name,
        service_file=f'{name}/services.json',
        requires=list(requires),
        requires_libs=list(libs),
        requires_hardware=hardware,
        profiles=list(profiles),
        capabilities=list(capabilities),
        timeout=timeout,
        config_id=f'{name}:services',
        **kw,
    )


CUDA_8 = HardwareSnapshot('cuda', 'RTX 8G', 8.0, 7.0, 32.0, 20.0, ['engine.exe[1]'])
CUDA_80 = HardwareSnapshot('cuda', 'H100', 80.0, 78.0, 256.0, 200.0)
MAC_36 = HardwareSnapshot('mps', 'Apple Silicon', ram_total_gb=36.0, ram_available_gb=30.0)
REMOTE = HardwareSnapshot(None, source='unknown', note='server x is remote')


# --- build_specs -------------------------------------------------------------


def test_light_config_is_not_heavy():
    [spec] = gate.build_specs([_config(hardware=False)], 'test', CUDA_8, strict=False)
    assert spec.runnable and not spec.heavy and spec.id == 'node:services:p'


def test_hardware_met_carries_need_and_timeout():
    [spec] = gate.build_specs([_config(hardware=HEAVY, timeout=600)], 'fulltest', MAC_36, strict=False)
    assert spec.runnable and spec.heavy
    assert (spec.device, spec.need_gb, spec.timeout) == ('mps', 32.0, 1800)


def test_hardware_unmet_skips_with_category():
    [spec] = gate.build_specs([_config(name='caption', profiles=['qwen'], hardware=HEAVY)], 'fulltest', CUDA_8, False)
    assert spec.skip == '[hardware] caption:qwen: needs 11 GB VRAM; RTX 8G has 8.0 GB'
    assert spec.heavy and not spec.runnable and spec.fail is None


def test_strict_turns_hardware_skip_into_failure():
    [spec] = gate.build_specs([_config(hardware=HEAVY)], 'fulltest', CUDA_8, strict=True)
    assert spec.skip is None
    assert spec.fail == '[hardware] node:p: needs 11 GB VRAM; RTX 8G has 8.0 GB'
    assert spec.fail_strict


def test_remote_server_is_its_own_category():
    [spec] = gate.build_specs([_config(hardware=HEAVY)], 'fulltest', REMOTE, strict=False)
    assert spec.skip == '[remote] node:p: hardware unknown: server x is remote'


def test_invalid_requirement_fails_even_when_not_strict():
    [spec] = gate.build_specs([_config(hardware={'cuda': {'vramGB': 1}})], 'fulltest', CUDA_80, strict=False)
    assert spec.fail.startswith('[hardware] node:p: invalid requiresHardware in node/services.json: cuda: unknown key')
    assert spec.heavy and not spec.fail_strict


def test_missing_env_is_a_visible_skip(monkeypatch):
    monkeypatch.delenv('RR_TEST_NOT_SET', raising=False)
    [spec] = gate.build_specs([_config(requires=['RR_TEST_NOT_SET'], hardware=HEAVY)], 'test', CUDA_8, False)
    assert spec.skip == '[env] node:p: required environment variable(s) not set: RR_TEST_NOT_SET'


def test_missing_libs_skip():
    [spec] = gate.build_specs([_config(libs=['librocketride-does-not-exist.so.9'])], 'test', CUDA_8, False)
    assert spec.skip.startswith('[libs] node:p: required shared library not available: librocketride-does-not-exist')


def test_exclusions_and_profileless_configs():
    configs = [
        _config(name='dbg', capabilities=['debug']),
        _config(name='skipped'),
        _config(name='optin'),
        _config(name='plain', profiles=()),
    ]
    specs = gate.build_specs(configs, 'test', CUDA_8, False, skip_nodes={'skipped', 'optin'}, include_skip={'optin'})
    assert [s.id for s in specs] == ['optin:services:p', 'plain:services']
    assert specs[1].profile is None


# --- snapshot resolution -----------------------------------------------------


def test_env_override(monkeypatch):
    env = {gate.ENV_DEVICE: 'CUDA', gate.ENV_VRAM_GB: '24', gate.ENV_RAM_GB: '64'}
    snap = gate.resolve_snapshot(env, 'http://gpu-box:5565')
    assert (snap.device, snap.vram_total_gb, snap.vram_free_gb, snap.ram_total_gb, snap.source) == (
        'cuda',
        24.0,
        24.0,
        64.0,
        'env',
    )


@pytest.mark.parametrize(
    'env,message',
    [
        ({gate.ENV_DEVICE: 'gpu'}, 'expected one of cuda, mps, cpu'),
        ({gate.ENV_DEVICE: 'cuda', gate.ENV_VRAM_GB: 'lots'}, 'positive number of GB'),
        ({gate.ENV_DEVICE: 'cpu', gate.ENV_RAM_GB: '-1'}, 'positive number of GB'),
    ],
)
def test_env_override_rejects(env, message):
    with pytest.raises(ValueError, match=message):
        gate.resolve_snapshot(env, 'http://localhost:5565')


def test_remote_uri_is_unknown():
    snap = gate.resolve_snapshot({}, 'wss://model.example.com:443')
    assert snap.device is None and snap.source == 'unknown'
    assert 'model.example.com is remote' in snap.note


@pytest.mark.parametrize('uri', ['http://localhost:40001', 'http://127.0.0.1:5565', 'ws://[::1]:5565'])
def test_loopback_uri_probes(monkeypatch, uri):
    monkeypatch.setattr(gate, 'probe_hardware', lambda: CUDA_8)
    assert gate.resolve_snapshot({}, uri) is CUDA_8


# --- lanes -------------------------------------------------------------------


@pytest.mark.parametrize(
    'needs,budget,workers,setting,expected',
    [
        ([10, 10, 10], 100, 1, 'auto', 1),
        ([10, 10, 10], 100, 8, 'auto', 3),
        ([10, 10, 10], 25, 8, 'auto', 2),
        ([30, 2, 2, 2], 31, 8, 'auto', 1),
        ([10, 10, 10], 5, 8, 'auto', 1),
        ([10, None], 100, 8, 'auto', 1),
        ([10, 10], None, 8, 'auto', 1),
        ([10, 10, 10], 1, 8, '2', 2),
        ([10], 100, 8, '4', 1),
        ([], 100, 8, 'auto', 1),
    ],
)
def test_lane_count(needs, budget, workers, setting, expected):
    assert gate.lane_count(needs, budget, workers, setting) == expected


def test_assign_lanes_keeps_peak_within_budget():
    configs = [_config(name=f'n{i}', hardware={'cuda': {'vramGb': gb}}) for i, gb in enumerate([20, 4, 10, 4, 2, 30])]
    configs.append(_config(name='light', hardware=False))
    specs = gate.build_specs(configs, 'fulltest', CUDA_80, False)
    lanes, count = gate.assign_lanes(specs, CUDA_80, workers=4, setting='auto')
    assert count == 4
    assert 'fulltest/light:services:p' not in lanes
    by_lane = {lane: [s.need_gb for s in specs if lanes.get(s.key) == lane] for lane in range(count)}
    assert by_lane == {0: [4.0, 30.0], 1: [20.0, 2.0], 2: [10.0], 3: [4.0]}
    assert sum(max(needs) for needs in by_lane.values()) == 64.0 <= gate.lane_budget_gb(CUDA_80)


def test_skipped_heavy_specs_still_get_a_lane():
    specs = gate.build_specs([_config(hardware=HEAVY)], 'fulltest', CUDA_8, False)
    lanes, count = gate.assign_lanes(specs, CUDA_8, workers=4, setting='auto')
    assert lanes == {'fulltest/node:services:p': 0} and count == 1


def test_lane_budget():
    assert gate.lane_budget_gb(CUDA_80) == pytest.approx(74.0)
    assert gate.lane_budget_gb(MAC_36) == pytest.approx(26.0)
    assert gate.lane_budget_gb(REMOTE) is None
    assert gate.lane_budget_gb(HardwareSnapshot('cuda', source='env')) is None


@pytest.mark.parametrize('value,expected', [(None, '1'), ('', '1'), ('auto', 'auto'), (' AUTO ', 'auto'), ('3', '3')])
def test_parse_lanes(value, expected):
    assert gate.parse_lanes(value) == expected


@pytest.mark.parametrize('value', ['0', '-2', 'many'])
def test_parse_lanes_rejects(value):
    with pytest.raises(ValueError, match='ROCKETRIDE_TEST_HW_LANES'):
        gate.parse_lanes(value)


# --- preflight ---------------------------------------------------------------


def _clock():
    now = [0.0]
    return (lambda: now[0]), (lambda seconds: now.__setitem__(0, now[0] + seconds))


def test_wait_for_free_vram_succeeds_once_memory_drains():
    readings = iter([2.0, 5.0, 12.0])
    clock, sleep = _clock()
    ok, mem = gate.wait_for_free_vram(
        11, timeout_s=10, poll_s=2, probe=lambda: CudaMemory('RTX', 24.0, next(readings)), clock=clock, sleep=sleep
    )
    assert ok and mem.free_gb == 12.0


def test_wait_for_free_vram_times_out():
    clock, sleep = _clock()
    ok, mem = gate.wait_for_free_vram(
        11,
        timeout_s=5,
        poll_s=2,
        probe=lambda: CudaMemory('RTX', 24.0, 3.0, ['engine.exe[9] 20.0 GB']),
        clock=clock,
        sleep=sleep,
    )
    assert not ok and mem.residents == ['engine.exe[9] 20.0 GB']


def test_wait_for_free_vram_without_nvml():
    assert gate.wait_for_free_vram(11, probe=lambda: None) == (True, None)


# --- reporting ---------------------------------------------------------------


@pytest.mark.parametrize(
    'reason,expected',
    [
        ('[hardware] a:b: needs 11 GB VRAM', ('hardware', 'a:b: needs 11 GB VRAM')),
        ('Skipped: [env] a: not set', ('env', 'a: not set')),
        ('Server not available', ('marker', 'Server not available')),
        ('[bogus] text', ('marker', '[bogus] text')),
    ],
)
def test_split_reason(reason, expected):
    assert gate.split_reason(reason) == expected


def test_heavy_nodeids_matches_file_and_param():
    keys = {'fulltest/caption:services:fulltest2:qwen3-vl-4b', 'test/detect:services:rfdetr'}
    ids = [
        'test/test_dynamic_full.py::TestDynamicNodesFull::test_node_cases[caption:services:fulltest2:qwen3-vl-4b]',
        'test/test_dynamic.py::TestDynamicNodes::test_node_cases[caption:services:fulltest2:qwen3-vl-4b]',
        'test\\test_dynamic.py::TestDynamicNodes::test_node_cases[detect:services:rfdetr]',
        'test/test_other.py::test_x[detect:services:rfdetr]',
        'test/test_dynamic.py::TestDynamicNodes::test_plain',
    ]
    assert gate.heavy_nodeids(ids, keys) == [ids[0], ids[2]]


def test_format_skip_report_groups_and_filters():
    plan = gate.Plan(CUDA_8, strict=False, specs=[])
    entries = [
        ('t::b', 'hardware', 'b: needs 11 GB VRAM', None),
        ('t::a', 'hardware', 'a: needs 12 GB VRAM', 'fails in strict mode'),
        ('t::c', 'env', 'c: not set', None),
        ('t::d', 'hardware', 'd: invalid requiresHardware', 'fails: invalid declaration'),
    ]
    lines = gate.format_skip_report(entries, 10, plan, 'all')
    body = lines[2:]
    assert body[:7] == [
        '[hardware] 3',
        '  t::a',
        '      a: needs 12 GB VRAM  (fails in strict mode)',
        '  t::b',
        '      b: needs 11 GB VRAM',
        '  t::d',
        '      d: invalid requiresHardware  (fails: invalid declaration)',
    ]
    assert '[env] 1' in body
    assert lines[-1].startswith('4 of 10 selected test(s) listed.')

    only_env = gate.format_skip_report(entries, 10, plan, 'env')
    assert '[hardware] 3' not in only_env and '[env] 1' in only_env

    assert 'No selected test will be skipped for [libs].' in gate.format_skip_report(entries, 10, plan, 'libs')


# --- conftest marks ----------------------------------------------------------


class _FakeConfig:
    def __init__(self, snapshot, workers=1, timeout='600'):
        self.stash = pytest.Stash()
        self.stash[conftest._SNAPSHOT] = snapshot
        self.option = SimpleNamespace(dist='loadgroup' if workers > 1 else 'no', tx=['popen'] * workers)
        self._timeout = timeout

    def getoption(self, name, default=None):
        return default

    def getini(self, name):
        return self._timeout


def _marks(param):
    return {mark.name: mark for mark in param.marks}


def test_params_marks(monkeypatch):
    configs = {
        'test': [],
        'fulltest': [
            _config(name='big', hardware={'cuda': {'vramGb': 30, 'timeout': 1200}}),
            _config(name='small', hardware={'cuda': {'vramGb': 2}}),
            _config(name='huge', hardware={'cuda': {'vramGb': 200}}),
            _config(name='light', hardware=False),
        ],
    }
    monkeypatch.setattr(conftest, 'discover_testable_nodes', lambda test_key='test': configs[test_key])
    monkeypatch.delenv(gate.ENV_STRICT, raising=False)
    monkeypatch.setenv(gate.ENV_LANES, 'auto')
    params = {p.id: _marks(p) for p in conftest._params(_FakeConfig(CUDA_80, workers=4), 'fulltest')}

    big = params['big:services:p']
    assert big['xdist_group'].args == ('hw0',)
    assert big['requires_hardware'].kwargs == {'device': 'cuda', 'need_gb': 30.0}
    assert big['timeout'].args == (1200,)
    assert params['small:services:p']['xdist_group'].args == ('hw1',)
    assert 'timeout' not in params['small:services:p']

    huge = params['huge:services:p']
    assert huge['skip'].kwargs['reason'].startswith('[hardware] huge:p: needs 200 GB VRAM')
    assert 'requires_hardware' not in huge and huge['xdist_group'].args == ('hw0',)

    assert params['light:services:p'] == {}


def test_params_strict_marks_failure(monkeypatch):
    configs = {'test': [], 'fulltest': [_config(name='huge', hardware={'cuda': {'vramGb': 200}})]}
    monkeypatch.setattr(conftest, 'discover_testable_nodes', lambda test_key='test': configs[test_key])
    monkeypatch.setenv(gate.ENV_STRICT, '1')
    [param] = conftest._params(_FakeConfig(CUDA_80), 'fulltest')
    marks = _marks(param)
    assert 'skip' not in marks
    assert marks['hardware_unmet'].kwargs['reason'].startswith('[hardware] huge:p: needs 200 GB VRAM')
    assert marks['hardware_unmet'].kwargs['strict'] is True


class _FakeItem:
    def __init__(self, snapshot, *marks):
        self._marks = {mark.mark.name: mark.mark for mark in marks}
        self.config = SimpleNamespace(stash=pytest.Stash())
        self.config.stash[conftest._SNAPSHOT] = snapshot

    def get_closest_marker(self, name):
        return self._marks.get(name)


def _no_wait(*args, **kwargs):
    raise AssertionError('VRAM preflight should not run')


def test_setup_fails_strict_hardware_miss(monkeypatch):
    monkeypatch.setattr(gate, 'wait_for_free_vram', _no_wait)
    item = _FakeItem(CUDA_8, pytest.mark.hardware_unmet(reason='[hardware] x:p: needs 11 GB VRAM', strict=True))
    with pytest.raises(
        pytest.fail.Exception, match=r'needs 11 GB VRAM \(strict mode: ROCKETRIDE_TEST_HARDWARE_STRICT is set\)$'
    ):
        conftest.pytest_runtest_setup(item)


def test_setup_fails_invalid_declaration_without_strict_note(monkeypatch):
    monkeypatch.setattr(gate, 'wait_for_free_vram', _no_wait)
    item = _FakeItem(
        CUDA_8, pytest.mark.hardware_unmet(reason='[hardware] x:p: invalid requiresHardware', strict=False)
    )
    with pytest.raises(pytest.fail.Exception, match=r'invalid requiresHardware$'):
        conftest.pytest_runtest_setup(item)


def test_setup_fails_when_vram_stays_busy(monkeypatch):
    calls = []

    def short(need):
        calls.append(need)
        return False, CudaMemory('RTX', 8.0, 2.0, ['python.exe[42] 5.5 GB'])

    monkeypatch.setattr(gate, 'wait_for_free_vram', short)
    item = _FakeItem(CUDA_8, pytest.mark.requires_hardware(device='cuda', need_gb=6.0))
    with pytest.raises(pytest.fail.Exception) as excinfo:
        conftest.pytest_runtest_setup(item)
    assert calls == [6.0]
    message = str(excinfo.value)
    assert 'needs 6 GB free VRAM but only 2.0 GB of 8.0 GB is free' in message
    assert '(held by: python.exe[42] 5.5 GB)' in message


def test_setup_passes_when_vram_is_free(monkeypatch):
    monkeypatch.setattr(gate, 'wait_for_free_vram', lambda need: (True, CudaMemory('RTX', 8.0, 7.0)))
    conftest.pytest_runtest_setup(_FakeItem(CUDA_8, pytest.mark.requires_hardware(device='cuda', need_gb=6.0)))


@pytest.mark.parametrize(
    'snapshot,device,need',
    [
        (HardwareSnapshot('cuda', 'remote', 80.0, 80.0, source='env'), 'cuda', 6.0),  # override: nothing to probe
        (MAC_36, 'mps', 16.0),  # only CUDA is checked
        (CUDA_8, 'cuda', None),  # no declared need
    ],
)
def test_setup_skips_vram_preflight(monkeypatch, snapshot, device, need):
    monkeypatch.setattr(gate, 'wait_for_free_vram', _no_wait)
    conftest.pytest_runtest_setup(_FakeItem(snapshot, pytest.mark.requires_hardware(device=device, need_gb=need)))


def test_setup_ignores_light_tests(monkeypatch):
    monkeypatch.setattr(gate, 'wait_for_free_vram', _no_wait)
    conftest.pytest_runtest_setup(_FakeItem(CUDA_8))


def test_collect_mode_writes_report_file(tmp_path):
    report = tmp_path / 'report.txt'
    config = SimpleNamespace(
        getoption=lambda name, default=None: str(report) if name == 'rocketride_report' else default
    )
    mode = conftest._SkipReportMode(config)
    mode.lines = ['hardware: cpu', '[env] 1']
    session = SimpleNamespace(exitstatus=pytest.ExitCode.NO_TESTS_COLLECTED)
    mode.pytest_sessionfinish(session, pytest.ExitCode.NO_TESTS_COLLECTED)
    assert session.exitstatus == pytest.ExitCode.OK
    assert report.read_text(encoding='utf-8') == 'Tests that will be skipped\nhardware: cpu\n[env] 1\n'


# --- warmup selection --------------------------------------------------------


def _profiled(name, profiles, default=None):
    return _config(name=name, profiles=list(profiles), preconfig={'default': default, 'profiles': profiles})


def test_collect_refs():
    caption = _profiled(
        'caption',
        {'qwen': {'model': 'Qwen/Qwen3-VL-4B-Instruct', 'revision': 'ebb281ec70b05090aa6165b016eac8ec08e71b17'}},
    )
    whisper = _profiled('audio_transcribe', {'tiny': {'model': 'tiny'}, 'big': {'model': 'large'}})
    detect = _profiled(
        'detect', {'rfdetr': {'engine': 'rfdetr', 'model': 'PekingU/rtdetr_r50vd'}, 'gd': {'model': 'IDEA/gd'}}
    )
    gliner = _profiled('anonymize', {'s': {'model': 'urchade/gliner_small-v2.1'}, 'custom': {'model': ''}})
    ocr = _profiled('ocr', {'latin': {'engine': 'easyocr'}})
    llm = _profiled('audio_tts', {'kokoro': {'engine': 'kokoro'}}, default='kokoro')

    refs = warmup.collect_refs(
        [
            (caption, 'qwen'),
            (caption, 'qwen'),
            (whisper, 'tiny'),
            (whisper, 'big'),
            (detect, 'rfdetr'),
            (detect, 'gd'),
            (gliner, 's'),
            (gliner, 'custom'),
            (ocr, 'latin'),
            (llm, None),
        ]
    )
    by_repo = {ref.repo_id: ref for ref in refs}
    assert list(by_repo) == [
        'Qwen/Qwen3-VL-4B-Instruct',
        'Systran/faster-whisper-tiny',
        'Systran/faster-whisper-large-v3',
        'IDEA/gd',
        'urchade/gliner_small-v2.1',
        'hexgrad/Kokoro-82M',
    ]
    qwen = by_repo['Qwen/Qwen3-VL-4B-Instruct']
    assert qwen.users == ['caption:qwen'] and qwen.label == 'Qwen/Qwen3-VL-4B-Instruct@ebb281ec'
    assert (
        by_repo['Systran/faster-whisper-tiny'].allow and not by_repo['Systran/faster-whisper-tiny'].prefer_safetensors
    )
    assert not by_repo['urchade/gliner_small-v2.1'].prefer_safetensors
    assert by_repo['hexgrad/Kokoro-82M'].users == ['audio_tts:kokoro']


FILES = [
    ('config.json', 1),
    ('model.safetensors', 900),
    ('pytorch_model.bin', 900),
    ('onnx/model.onnx', 500),
    ('onnx/model_quantized.onnx', 200),
    ('openvino/openvino_model.bin', 400),
    ('tf_model.h5', 900),
    ('flax_model.msgpack', 900),
    ('tokenizer.json', 2),
]


def test_select_files_prefers_safetensors_and_drops_foreign_formats():
    chosen = warmup.select_files(warmup.ModelRef('a/b'), FILES)
    assert [p for p, _ in chosen] == ['config.json', 'model.safetensors', 'tokenizer.json']


def test_select_files_keeps_checkpoints_when_asked():
    chosen = warmup.select_files(warmup.ModelRef('a/b', prefer_safetensors=False), FILES)
    assert [p for p, _ in chosen] == ['config.json', 'model.safetensors', 'pytorch_model.bin', 'tokenizer.json']


def test_select_files_whisper_allow_list():
    files = [('model.bin', 3000), ('config.json', 1), ('vocabulary.json', 1), ('README.md', 1), ('.gitattributes', 1)]
    ref = warmup.collect_refs([(_profiled('audio_transcribe', {'x': {'model': 'large-v3'}}), 'x')])[0]
    assert [p for p, _ in warmup.select_files(ref, files)] == ['model.bin', 'config.json', 'vocabulary.json']


def test_select_files_drops_housekeeping():
    files = [('.gitattributes', 1), ('README.md', 1), ('handler.py', 1), ('birefnet.py', 1), ('model.safetensors', 9)]
    assert [p for p, _ in warmup.select_files(warmup.ModelRef('a/b'), files)] == ['birefnet.py', 'model.safetensors']


@pytest.mark.parametrize('size,expected', [(0, '0 MB'), (42 * 1024**2, '42 MB'), (int(8.27 * 1024**3), '8.27 GB')])
def test_format_size(size, expected):
    assert warmup.format_size(size) == expected


def test_describe_status():
    ref = warmup.ModelRef('a/b', 'c' * 40, users=['n:p'])
    gib = 1024**3
    assert warmup.describe(warmup.RefStatus(ref, error='GatedRepoError: 401')) == (
        'a/b@cccccccc: unavailable (GatedRepoError: 401) [n:p]'
    )
    assert warmup.describe(warmup.RefStatus(ref, files=[('m', gib)])) == 'a/b@cccccccc: cached, 1.00 GB [n:p]'
    status = warmup.RefStatus(ref, files=[('m', gib), ('c', 1)], missing=[('m', gib)])
    assert warmup.describe(status) == 'a/b@cccccccc: 1.00 GB to download (1 of 2 files) [n:p]'
    assert warmup.describe(warmup.RefStatus(ref)) == 'a/b@cccccccc: no matching files [n:p]'
