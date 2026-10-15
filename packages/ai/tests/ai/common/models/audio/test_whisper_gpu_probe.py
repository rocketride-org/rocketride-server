"""The Whisper GPU probe and the CPU fallback it drives (#2498).

The probe is a child process; these tests run its real script against stub
``torch`` / ``ctranslate2`` / ``faster_whisper`` packages placed on the child's
path, so every stage (version guard, storage view, inference, clean exit) is
exercised with ordinary Python and no GPU. The loader's fallback is tested with
the probe stubbed, the way the other loader tests stub the model stack.

Run from the project root with the built engine or a venv that has ``ai`` on
the path, like test_whisper.py.
"""

from __future__ import annotations

import logging
import os
import subprocess
import sys
import textwrap
import types
from pathlib import Path

import pytest

import ai.common.models.audio.whisper as whispermod
from ai.common.models.audio.whisper import WhisperLoader, _gpu_probe_script

# The requirement files in the source tree, not the copies next to the module the
# engine imports: under the built engine ``whispermod`` is the shipped package.
_REPO = Path(__file__).resolve().parents[7]
_REQUIREMENTS = _REPO / 'packages' / 'ai' / 'src' / 'ai' / 'common' / 'models' / 'audio' / 'requirements_whisper.txt'
_NODE_REQUIREMENTS = _REPO / 'nodes' / 'src' / 'nodes' / 'audio_transcribe' / 'requirements.txt'


@pytest.fixture
def fresh_probe(monkeypatch):
    """Every test starts with the probe un-run and leaves it that way.

    A fake ``faster_whisper`` keeps the parent's weight prefetch off the network
    on hosts that have the real package; tests of the prefetch install their own.
    """
    monkeypatch.setattr(WhisperLoader, '_gpu_compatible', None)
    monkeypatch.setattr(WhisperLoader, '_gpu_probe_reason', None)
    monkeypatch.setitem(sys.modules, 'faster_whisper', types.SimpleNamespace(download_model=lambda *a, **k: None))


# ---------------------------------------------------------------------------
# The child script, run for real against a stub model stack
# ---------------------------------------------------------------------------

_STUB_TORCH = """
import os

__version__ = "2.10.0+cu128"
float32 = "float32"


class version:
    cuda = os.environ.get("PROBE_CUDA", "12.8")


class _Cudnn:
    @staticmethod
    def version():
        return 91002


class backends:
    cudnn = _Cudnn()


def zeros(*_args, **_kwargs):
    return object()
"""

_STUB_CT2 = """
import os

__version__ = os.environ.get("PROBE_CT2", "4.8.2")


def get_supported_compute_types(_device):
    return os.environ.get("PROBE_COMPUTE_TYPES", "float16,int8").split(",")


class StorageView:
    @staticmethod
    def from_array(_tensor):
        return object()
"""

_STUB_FASTER_WHISPER = """
import atexit
import os

STAGE = os.environ.get("PROBE_FAIL_STAGE", "")


def download_model(*_args, **_kwargs):
    return "/stub"


class WhisperModel:
    def __init__(self, model_name, device, device_index, compute_type, **kwargs):
        if STAGE == "load":
            raise RuntimeError("Library libcudnn_ops.so.9 is not found")
        self.model_name = model_name
        self.device = device
        self.device_index = device_index
        self.compute_type = compute_type
        self.kwargs = kwargs
        if STAGE == "shutdown":
            # A native crash at interpreter exit: the child has printed "probe: ok" by then.
            atexit.register(lambda: os._exit(134))

    def transcribe(self, audio, **_kwargs):
        # Like faster-whisper, nothing runs until the segments are consumed.
        def segments():
            if STAGE == "transcribe":
                raise RuntimeError("cuDNN convolution failed")
            if STAGE == "echo":
                print("probe model", self.model_name, self.device, self.device_index, self.compute_type, self.kwargs, flush=True)
            yield object()

        return segments(), None
"""


@pytest.fixture
def stub_stack(tmp_path):
    """A directory with stub torch, ctranslate2 and faster_whisper packages."""
    for name, source in (('torch', _STUB_TORCH), ('ctranslate2', _STUB_CT2), ('faster_whisper', _STUB_FASTER_WHISPER)):
        pkg = tmp_path / name
        pkg.mkdir()
        (pkg / '__init__.py').write_text(textwrap.dedent(source))
    return tmp_path


def _probe_lines(result):
    """The child's own stage lines; the engine binary adds a trailer of its own on failure."""
    return [line.strip() for line in result.stdout.splitlines() if line.startswith('probe:')]


def _run_probe_child(stub_stack, env=None, **script_kwargs):
    """Run the real probe script in a child with the stub packages first on its path."""
    script = f'import sys\nsys.path.insert(0, {str(stub_stack)!r})\n' + _gpu_probe_script(**script_kwargs)
    child_env = dict(os.environ)
    child_env.update(env or {})
    return subprocess.run([sys.executable, '-c', script], capture_output=True, text=True, timeout=60, env=child_env)


def test_probe_script_passes_on_a_working_stack(stub_stack):
    result = _run_probe_child(stub_stack, env={'PROBE_FAIL_STAGE': 'echo'})

    assert result.returncode == 0, result.stderr
    lines = _probe_lines(result)
    assert lines[-1] == 'probe: ok'
    assert 'probe: storage view ok' in lines
    assert any(line.startswith('probe: inference ok') for line in lines)
    # The inference stage loads the smallest model on the probed device in float16,
    # and the echo proves the lazy segments were consumed.
    assert 'probe model tiny cuda 0 float16 {}' in result.stdout


def test_probe_script_forwards_device_index_and_download_root(stub_stack):
    result = _run_probe_child(stub_stack, env={'PROBE_FAIL_STAGE': 'echo'}, device_index=2, download_root='/models')

    assert result.returncode == 0, result.stderr
    assert "probe model tiny cuda 2 float16 {'download_root': '/models'}" in result.stdout


def test_probe_script_uses_a_supported_precision(stub_stack):
    result = _run_probe_child(
        stub_stack, env={'PROBE_FAIL_STAGE': 'echo', 'PROBE_COMPUTE_TYPES': 'int8_float32,float32'}
    )

    assert result.returncode == 0, result.stderr
    assert 'probe model tiny cuda 0 int8_float32 {}' in result.stdout


@pytest.mark.parametrize(
    'ct2, cuda, passes',
    [
        ('4.7.1', '12.8', False),  # the guarded pair
        ('4.7.9', '12.8.1', False),
        ('4.8.0', '12.8', True),  # the floor the requirements now impose
        ('4.7.1', '12.6', True),  # 4.7 is only excluded with the 12.8 runtime
        ('4.6.0', '12.8', True),
    ],
)
def test_probe_script_version_guard_boundaries(stub_stack, ct2, cuda, passes):
    result = _run_probe_child(stub_stack, env={'PROBE_CT2': ct2, 'PROBE_CUDA': cuda})

    assert (result.returncode == 0) is passes, result.stdout + result.stderr
    if not passes:
        assert _probe_lines(result)[-1].startswith('probe: guard')


def test_probe_script_fails_when_the_model_cannot_load(stub_stack):
    result = _run_probe_child(stub_stack, env={'PROBE_FAIL_STAGE': 'load'})

    assert result.returncode != 0
    assert _probe_lines(result)[-1] == 'probe: storage view ok'  # the stage it reached
    assert 'libcudnn_ops' in result.stderr


def test_probe_script_fails_when_inference_raises_lazily(stub_stack):
    """faster-whisper runs the encoder and decoder only when the segments are read."""
    result = _run_probe_child(stub_stack, env={'PROBE_FAIL_STAGE': 'transcribe'})

    assert result.returncode != 0
    assert _probe_lines(result)[-1] == 'probe: storage view ok'  # never reached "inference ok"
    assert 'cuDNN convolution failed' in result.stderr


def test_probe_script_crash_at_shutdown_is_not_ok(stub_stack):
    """The child prints "probe: ok" and then dies while exiting: the exit code must decide."""
    result = _run_probe_child(stub_stack, env={'PROBE_FAIL_STAGE': 'shutdown'})

    assert 'probe: ok' in _probe_lines(result)
    assert result.returncode != 0


# ---------------------------------------------------------------------------
# _check_gpu_compatible: the parent's verdict and the reason it keeps
# ---------------------------------------------------------------------------


def test_check_gpu_compatible_runs_the_real_script_against_the_stub_stack(stub_stack, monkeypatch, fresh_probe):
    prefix = f'import sys\nsys.path.insert(0, {str(stub_stack)!r})\n'
    real = _gpu_probe_script
    monkeypatch.setattr(whispermod, '_gpu_probe_script', lambda **kw: prefix + real(**kw))

    assert WhisperLoader._check_gpu_compatible() is True
    assert WhisperLoader._gpu_probe_reason is None


def test_check_gpu_compatible_names_the_stage_and_exit_code_on_failure(stub_stack, monkeypatch, fresh_probe):
    prefix = f'import sys\nsys.path.insert(0, {str(stub_stack)!r})\n'
    real = _gpu_probe_script
    monkeypatch.setattr(whispermod, '_gpu_probe_script', lambda **kw: prefix + real(**kw))
    monkeypatch.setenv('PROBE_FAIL_STAGE', 'load')

    assert WhisperLoader._check_gpu_compatible() is False

    reason = WhisperLoader._gpu_probe_reason
    assert 'exit 1 after "probe: storage view ok"' in reason
    assert 'libcudnn_ops' in reason


def _completed(returncode, stdout='', stderr=''):
    return subprocess.CompletedProcess(args=['probe'], returncode=returncode, stdout=stdout, stderr=stderr)


def test_lines_without_the_probe_prefix_are_ignored(monkeypatch, fresh_probe):
    """The engine binary hosting the child may add its own lines; only probe: lines count."""
    monkeypatch.setattr(
        subprocess,
        'run',
        lambda *a, **k: _completed(0, stdout='probe: ok\n[120MB] Exit: Python\n        Message: fine\n'),
    )

    assert WhisperLoader._check_gpu_compatible() is True


def test_a_child_that_crashes_after_printing_ok_fails_the_probe(monkeypatch, fresh_probe):
    monkeypatch.setattr(
        subprocess,
        'run',
        lambda *a, **k: _completed(-6, stdout='probe: storage view ok\nprobe: inference ok 1\nprobe: ok\n'),
    )

    assert WhisperLoader._check_gpu_compatible() is False
    assert 'exit -6' in WhisperLoader._gpu_probe_reason


def test_probe_ok_must_be_the_last_stage_line(monkeypatch, fresh_probe):
    monkeypatch.setattr(subprocess, 'run', lambda *a, **k: _completed(0, stdout='probe: ok\nprobe: something after\n'))

    assert WhisperLoader._check_gpu_compatible() is False


def test_a_timeout_is_reported_but_not_cached(monkeypatch, fresh_probe):
    """A slow probe sends this load to the CPU; the next load probes again."""
    calls = []

    def _hang(*_a, **_k):
        calls.append(1)
        raise subprocess.TimeoutExpired(cmd='probe', timeout=whispermod._GPU_PROBE_TIMEOUT_S)

    monkeypatch.setattr(subprocess, 'run', _hang)

    assert WhisperLoader._check_gpu_compatible() is False
    assert f'within {whispermod._GPU_PROBE_TIMEOUT_S} s' in WhisperLoader._gpu_probe_reason
    assert WhisperLoader._gpu_compatible is None
    assert WhisperLoader._check_gpu_compatible() is False
    assert len(calls) == 2


def test_a_verdict_is_cached_for_the_process(monkeypatch, fresh_probe):
    calls = []

    def _run(*a, **k):
        calls.append(a)
        return _completed(0, stdout='probe: ok\n')

    monkeypatch.setattr(subprocess, 'run', _run)

    assert WhisperLoader._check_gpu_compatible() is True
    assert WhisperLoader._check_gpu_compatible(device_index=1) is True
    assert len(calls) == 1


def test_a_failed_weight_download_is_not_a_gpu_verdict(monkeypatch, fresh_probe):
    """The parent fetches the probe weights; a hub problem never means "CPU forever"."""
    attempts = []

    def _download(name, cache_dir=None):
        attempts.append((name, cache_dir))
        raise OSError('hub unreachable')

    monkeypatch.setitem(sys.modules, 'faster_whisper', types.SimpleNamespace(download_model=_download))
    ran = []
    monkeypatch.setattr(subprocess, 'run', lambda *a, **k: ran.append(a) or _completed(0, stdout='probe: ok\n'))

    assert WhisperLoader._check_gpu_compatible(download_root='/models') is False
    assert 'hub unreachable' in WhisperLoader._gpu_probe_reason
    assert WhisperLoader._gpu_compatible is None
    assert ran == []  # the child never started
    assert attempts == [(whispermod._GPU_PROBE_MODEL, '/models')]

    # The next load tries again.
    assert WhisperLoader._check_gpu_compatible(download_root='/models') is False
    assert len(attempts) == 2


def test_the_prefetched_weights_land_in_the_callers_cache(monkeypatch, fresh_probe):
    fetched = []
    monkeypatch.setitem(
        sys.modules,
        'faster_whisper',
        types.SimpleNamespace(download_model=lambda name, cache_dir=None: fetched.append(cache_dir)),
    )
    seen = {}

    def _run(*a, **k):
        seen['script'] = a[0][2]
        return _completed(0, stdout='probe: ok\n')

    monkeypatch.setattr(subprocess, 'run', _run)

    assert WhisperLoader._check_gpu_compatible(download_root='/models') is True
    assert fetched == ['/models']
    assert "'download_root': '/models'" in seen['script']


def test_first_candidate_gpu_skips_excluded_devices():
    torch = types.SimpleNamespace(cuda=types.SimpleNamespace(device_count=lambda: 3))

    assert WhisperLoader._first_candidate_gpu([], torch) == 0
    assert WhisperLoader._first_candidate_gpu([0], torch) == 1
    assert WhisperLoader._first_candidate_gpu([0, 1], torch) == 2
    assert WhisperLoader._first_candidate_gpu([0, 1, 2], torch) == 0  # nothing free: the allocator will say so


# ---------------------------------------------------------------------------
# load(): the fallback is reported, not silent
# ---------------------------------------------------------------------------


class _FakeWhisperModel:
    def __init__(self, model_name, device, compute_type, device_index=None, **kwargs):
        self.model_name = model_name
        self.device = device
        self.device_index = device_index
        self.compute_type = compute_type
        self.kwargs = kwargs


@pytest.fixture
def model_stack(monkeypatch, fresh_probe):
    """A CUDA-capable torch with two devices and a fake faster-whisper, with no dependency install."""
    torch = types.SimpleNamespace(cuda=types.SimpleNamespace(is_available=lambda: True, device_count=lambda: 2))
    monkeypatch.setitem(sys.modules, 'ai.common.torch', types.SimpleNamespace(torch=torch))
    monkeypatch.setitem(
        sys.modules,
        'faster_whisper',
        types.SimpleNamespace(WhisperModel=_FakeWhisperModel, download_model=lambda *a, **k: '/stub'),
    )
    monkeypatch.setattr(WhisperLoader, '_ensure_dependencies', staticmethod(lambda: None))
    return torch


def _probe_says(monkeypatch, verdict, reason=None):
    calls = []

    @classmethod
    def _fake(cls, device_index=0, download_root=None):
        calls.append({'device_index': device_index, 'download_root': download_root})
        cls._gpu_compatible = verdict
        cls._gpu_probe_reason = reason
        return verdict

    monkeypatch.setattr(WhisperLoader, '_check_gpu_compatible', _fake)
    return calls


def test_server_mode_falls_back_to_cpu_and_says_why(model_stack, monkeypatch, caplog):
    _probe_says(monkeypatch, False, 'exit 1 after "probe: storage view ok"; stderr: libcudnn_ops.so.9 not found')

    with caplog.at_level(logging.ERROR, logger='rocketlib.models.whisper'):
        bundle, metadata, gpu_index = WhisperLoader.load('tiny', allocate_gpu=lambda mem, ex: (0, 'cuda:0'))

    assert gpu_index == -1
    assert metadata['device'] == 'cpu'
    assert metadata['compute_type'] == 'int8'  # float16 is not a CPU type
    assert 'libcudnn_ops' in metadata['device_fallback']
    assert bundle['model'].device == 'cpu'
    errors = [record for record in caplog.records if record.levelno == logging.ERROR]
    assert len(errors) == 1 and 'libcudnn_ops' in errors[0].getMessage()


def test_server_mode_uses_the_gpu_when_the_probe_passes(model_stack, monkeypatch):
    calls = _probe_says(monkeypatch, True)

    bundle, metadata, gpu_index = WhisperLoader.load(
        'tiny', allocate_gpu=lambda mem, ex: (1, 'cuda:1'), download_root='/models'
    )

    assert (gpu_index, metadata['device']) == (1, 'cuda:1')
    assert 'device_fallback' not in metadata
    assert bundle['model'].device_index == 1
    assert calls == [{'device_index': 0, 'download_root': '/models'}]


def test_server_mode_probes_a_gpu_the_allocator_may_hand_out(model_stack, monkeypatch):
    calls = _probe_says(monkeypatch, True)

    WhisperLoader.load('tiny', allocate_gpu=lambda mem, ex: (1, 'cuda:1'), exclude_gpus=[0])

    assert calls[0]['device_index'] == 1


def test_local_mode_with_an_explicit_gpu_probes_that_device(model_stack, monkeypatch, caplog):
    calls = _probe_says(monkeypatch, False, 'exit -6 after "probe: inference ok 1"')

    with caplog.at_level(logging.ERROR, logger='rocketlib.models.whisper'):
        _bundle, metadata, gpu_index = WhisperLoader.load('tiny', device='cuda:2')

    assert calls[0]['device_index'] == 2
    assert (gpu_index, metadata['device']) == (-1, 'cpu')
    assert metadata['device_fallback'] == 'exit -6 after "probe: inference ok 1"'
    assert any("'cuda:2'" in record.getMessage() for record in caplog.records)


def test_explicit_cpu_never_probes(model_stack, monkeypatch):
    calls = _probe_says(monkeypatch, True)

    _bundle, metadata, gpu_index = WhisperLoader.load('tiny', device='cpu')

    assert calls == []
    assert (gpu_index, metadata['device']) == (-1, 'cpu')
    assert 'device_fallback' not in metadata


def test_no_cuda_is_a_choice_not_a_fallback(model_stack, monkeypatch):
    model_stack.cuda.is_available = lambda: False
    calls = _probe_says(monkeypatch, True)

    _bundle, metadata, _gpu_index = WhisperLoader.load('tiny', allocate_gpu=lambda mem, ex: (0, 'cuda:0'))

    assert calls == []
    assert metadata['device'] == 'cpu'
    assert 'device_fallback' not in metadata


# ---------------------------------------------------------------------------
# The requirements floor that keeps the guarded version out of the engine cache
# ---------------------------------------------------------------------------


def _pins(path):
    lines = [line.strip() for line in path.read_text().splitlines() if line.strip() and not line.startswith('#')]
    return [line for line in lines if line.startswith('ctranslate2')]


@pytest.mark.skipif(not _REQUIREMENTS.exists(), reason='needs the source tree')
def test_requirements_pin_ctranslate2_above_the_guarded_series():
    assert _pins(_REQUIREMENTS) == ['ctranslate2>=4.8,<5']


@pytest.mark.skipif(not _NODE_REQUIREMENTS.exists(), reason='needs the source tree')
def test_the_node_requirements_carry_the_same_floor():
    assert _pins(_NODE_REQUIREMENTS) == _pins(_REQUIREMENTS)
