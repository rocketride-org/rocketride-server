"""The Whisper GPU probe and the CPU fallback it drives (#2498).

The probe is a child process; these tests run its real script against stub
``torch`` / ``ctranslate2`` / ``faster_whisper`` packages placed on the child's
path, so every stage (version guard, storage view, inference, clean exit) is
exercised with ordinary Python and no GPU. That includes the storage-view-only
verdict the child gives when the probe weights are not in the local cache. The
loader's fallback is tested with the probe stubbed, the way the other loader
tests stub the model stack.

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
def fresh_probe(monkeypatch, tmp_path):
    """Every test starts with the probe un-run and leaves it that way.

    A fake ``faster_whisper`` reports a complete cached copy of the probe weights,
    so the parent never starts the weight-fetch child: that child cannot see this
    fake and would reach the hub on hosts that have the real package. Tests of
    the prefetch install their own.
    """
    monkeypatch.setattr(WhisperLoader, '_gpu_compatible', None)
    monkeypatch.setattr(WhisperLoader, '_gpu_probe_reason', None)
    monkeypatch.setattr(WhisperLoader, '_gpu_probe_inference_skipped', None)
    monkeypatch.setattr(WhisperLoader, '_gpu_probe_fetch_timeouts', 0)
    cached = str(_weights(tmp_path / 'fixture', complete=True))
    monkeypatch.setitem(sys.modules, 'faster_whisper', types.SimpleNamespace(download_model=lambda *a, **k: cached))
    # The guard shortcut imports ai.common.torch, whose load_depends installs torch on a bare host.
    no_cuda = types.SimpleNamespace(torch=types.SimpleNamespace(version=types.SimpleNamespace(cuda=None)))
    monkeypatch.setitem(sys.modules, 'ai.common.torch', no_cuda)


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


def get_supported_compute_types(_device, device_index=0):
    # Like the real binding: a set (so indexing it would fail), per device.
    print("stub compute types queried for device", device_index, flush=True)
    return set(os.environ.get("PROBE_COMPUTE_TYPES", "float16,int8").split(","))


class StorageView:
    @staticmethod
    def from_array(_tensor):
        return object()
"""

_STUB_FASTER_WHISPER = """
import atexit
import os
import posixpath

STAGE = os.environ.get("PROBE_FAIL_STAGE", "")


def download_model(name, *_args, **kwargs):
    # The child may only read the local cache; downloading is the parent's job.
    if not kwargs.get("local_files_only"):
        raise AssertionError("the probe child must not download")
    cached = os.environ.get("PROBE_TINY_CACHED", "1")
    if cached == "0":
        raise FileNotFoundError(f"{name} is not in the local cache")
    if cached == "error":
        raise PermissionError("cache directory is not readable")
    if os.environ.get("PROBE_TINY_DIR"):
        return os.environ["PROBE_TINY_DIR"]  # a real snapshot directory, complete or not
    # The fake cache root is a marker the tests assert literally; it is never touched
    # on disk, so join it POSIX-style on every platform (os.path.join gives /cache\\tiny on Windows).
    return posixpath.join(kwargs.get("cache_dir") or "/cache", name)


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
    # The inference stage loads the smallest model, resolved from the local cache,
    # on the probed device in float16; the echo proves the lazy segments were consumed.
    assert 'probe model /cache/tiny cuda 0 float16 {}' in result.stdout


def test_probe_script_forwards_device_index_and_looks_in_the_callers_cache(stub_stack):
    result = _run_probe_child(stub_stack, env={'PROBE_FAIL_STAGE': 'echo'}, device_index=2, download_root='/models')

    assert result.returncode == 0, result.stderr
    assert 'probe model /models/tiny cuda 2 float16 {}' in result.stdout
    assert 'stub compute types queried for device 2' in result.stdout  # not GPU 0 by default


def test_probe_script_skips_inference_when_the_weights_are_not_local(stub_stack):
    """No weights in the cache: the verdict stops at the storage view and nothing is downloaded."""
    result = _run_probe_child(stub_stack, env={'PROBE_FAIL_STAGE': 'echo', 'PROBE_TINY_CACHED': '0'})

    assert result.returncode == 0, result.stderr
    lines = _probe_lines(result)
    assert lines[-1] == 'probe: ok'
    assert 'probe: storage view ok' in lines
    assert any(line.startswith('probe: inference skipped: tiny weights are not cached locally') for line in lines)
    assert 'probe model' not in result.stdout  # no model was loaded


def test_probe_script_fails_when_the_cache_cannot_be_read(stub_stack):
    """Only missing weights skip the stage; any other error resolving them is a probe failure."""
    result = _run_probe_child(stub_stack, env={'PROBE_FAIL_STAGE': 'echo', 'PROBE_TINY_CACHED': 'error'})

    assert result.returncode != 0
    assert _probe_lines(result)[-1] == 'probe: storage view ok'
    assert 'cache directory is not readable' in result.stderr


def test_probe_script_treats_an_incomplete_snapshot_as_not_cached(stub_stack, tmp_path):
    """The hub cache lists a snapshot before its files arrive; without model.bin there is nothing to load."""
    snapshot = tmp_path / 'snapshots' / 'abc'
    snapshot.mkdir(parents=True)
    (snapshot / 'config.json').write_text('{}')

    result = _run_probe_child(stub_stack, env={'PROBE_FAIL_STAGE': 'echo', 'PROBE_TINY_DIR': str(snapshot)})

    assert result.returncode == 0, result.stderr
    lines = _probe_lines(result)
    assert lines[-1] == 'probe: ok'
    assert any('model.bin is missing' in line or 'inference skipped' in line for line in lines)
    assert 'probe model' not in result.stdout


def test_probe_script_loads_a_local_model_directory_as_is(stub_stack, tmp_path):
    local = tmp_path / 'my-whisper'
    local.mkdir()
    (local / 'model.bin').write_bytes(b'weights')

    result = _run_probe_child(stub_stack, env={'PROBE_FAIL_STAGE': 'echo'}, model_name=str(local))

    assert result.returncode == 0, result.stderr
    assert f'probe model {local} cuda 0 float16 {{}}' in result.stdout


def test_probe_script_uses_a_supported_precision(stub_stack):
    result = _run_probe_child(
        stub_stack, env={'PROBE_FAIL_STAGE': 'echo', 'PROBE_COMPUTE_TYPES': 'int8_float32,float32'}
    )

    assert result.returncode == 0, result.stderr
    assert 'probe model /cache/tiny cuda 0 int8_float32 {}' in result.stdout


def test_probe_script_falls_back_to_float32_on_a_gpu_without_float16(stub_stack):
    """Older GPUs report only float32 (and maybe int8); the set has no order, so no indexing."""
    result = _run_probe_child(stub_stack, env={'PROBE_FAIL_STAGE': 'echo', 'PROBE_COMPUTE_TYPES': 'float32'})

    assert result.returncode == 0, result.stderr
    assert 'probe model /cache/tiny cuda 0 float32 {}' in result.stdout


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
    monkeypatch.setattr(WhisperLoader, '_gpu_probe_inference_skipped', 'stale')

    assert WhisperLoader._check_gpu_compatible() is True
    assert WhisperLoader._gpu_probe_reason is None
    assert WhisperLoader._gpu_probe_inference_skipped is None  # the inference stage ran and reset it


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


def test_a_timeout_names_the_stage_the_child_reached(monkeypatch, fresh_probe):
    """TimeoutExpired carries the child's output so far; the last probe line says where it hung."""

    def _hang(*_a, **_k):
        raise subprocess.TimeoutExpired(cmd='probe', timeout=1, output=b'probe: versions ...\nprobe: storage view ok\n')

    monkeypatch.setattr(subprocess, 'run', _hang)

    assert WhisperLoader._check_gpu_compatible() is False
    assert WhisperLoader._gpu_probe_reason.endswith('after "probe: storage view ok"')


def test_a_timeout_is_cached_like_any_other_failure(monkeypatch, fresh_probe):
    """The child reads only local files, so a hang is a verdict: it costs once per process."""
    calls = []

    def _hang(*_a, **_k):
        calls.append(1)
        raise subprocess.TimeoutExpired(cmd='probe', timeout=whispermod._GPU_PROBE_TIMEOUT_S)

    monkeypatch.setattr(subprocess, 'run', _hang)

    assert WhisperLoader._check_gpu_compatible() is False
    assert f'within {whispermod._GPU_PROBE_TIMEOUT_S} s' in WhisperLoader._gpu_probe_reason
    assert WhisperLoader._gpu_compatible is False
    assert WhisperLoader._check_gpu_compatible() is False
    assert len(calls) == 1


def test_an_out_of_memory_child_is_reported_but_not_a_verdict(monkeypatch, fresh_probe):
    """A full GPU says nothing about the CUDA stack: the next load probes again."""
    calls = []

    def _run(*a, **k):
        calls.append(1)
        return _completed(1, stdout='probe: storage view ok\n', stderr='CUDA failed with error out of memory')

    monkeypatch.setattr(subprocess, 'run', _run)

    assert WhisperLoader._check_gpu_compatible(device_index=1) is False
    assert 'out of memory' in WhisperLoader._gpu_probe_reason
    assert 'not a verdict' in WhisperLoader._gpu_probe_reason
    assert WhisperLoader._gpu_compatible is None
    assert WhisperLoader._check_gpu_compatible(device_index=1) is False
    assert len(calls) == 2


def test_local_files_only_skips_the_weight_fetch(monkeypatch, fresh_probe):
    def _download(*_a, **_k):
        raise AssertionError('no network when the caller asked for local files only')

    monkeypatch.setitem(sys.modules, 'faster_whisper', types.SimpleNamespace(download_model=_download))
    monkeypatch.setattr(subprocess, 'run', lambda *a, **k: _completed(0, stdout='probe: ok\n'))

    assert WhisperLoader._check_gpu_compatible(local_files_only=True) is True


def test_a_guarded_host_does_not_fetch_the_probe_weights(monkeypatch, fresh_probe):
    """ctranslate2 4.7.x with CUDA 12.8 stops the child at the guard; no point downloading first."""
    import importlib.metadata

    monkeypatch.setattr(importlib.metadata, 'version', lambda name: '4.7.1')
    torch = types.SimpleNamespace(version=types.SimpleNamespace(cuda='12.8'))
    monkeypatch.setitem(sys.modules, 'ai.common.torch', types.SimpleNamespace(torch=torch))
    attempts = []
    monkeypatch.setitem(
        sys.modules, 'faster_whisper', types.SimpleNamespace(download_model=lambda *a, **k: attempts.append(a))
    )
    monkeypatch.setattr(
        subprocess, 'run', lambda *a, **k: _completed(1, stdout='probe: guard excludes ctranslate2 4.7.x\n')
    )

    assert WhisperLoader._guard_refuses_installed_versions() == 'ctranslate2 4.7.1 with the CUDA 12.8 runtime'
    assert WhisperLoader._check_gpu_compatible() is False
    assert attempts == []
    assert 'probe: guard excludes' in WhisperLoader._gpu_probe_reason


def test_the_guard_shortcut_passes_other_versions(monkeypatch):
    import importlib.metadata

    torch = types.SimpleNamespace(version=types.SimpleNamespace(cuda='12.8'))
    monkeypatch.setitem(sys.modules, 'ai.common.torch', types.SimpleNamespace(torch=torch))
    monkeypatch.setattr(importlib.metadata, 'version', lambda name: '4.8.3')
    assert WhisperLoader._guard_refuses_installed_versions() is None
    monkeypatch.setattr(importlib.metadata, 'version', lambda name: (_ for _ in ()).throw(ModuleNotFoundError()))
    assert WhisperLoader._guard_refuses_installed_versions() is None  # cannot tell: fetch as usual


def test_a_skipped_inference_stage_is_a_storage_view_verdict(monkeypatch, fresh_probe, caplog):
    """Without local weights the child ends on the storage view: the GPU is used, with a warning."""
    stdout = (
        'probe: storage view ok\n'
        'probe: inference skipped: tiny weights are not cached locally; LocalEntryNotFoundError\n'
        'probe: ok\n'
    )
    monkeypatch.setattr(subprocess, 'run', lambda *a, **k: _completed(0, stdout=stdout))

    with caplog.at_level(logging.WARNING, logger='rocketlib.models.whisper'):
        assert WhisperLoader._check_gpu_compatible() is True

    assert WhisperLoader._gpu_probe_reason is None
    assert WhisperLoader._gpu_probe_inference_skipped.startswith('probe: inference skipped')
    assert any('storage view only' in record.getMessage() for record in caplog.records)


def test_a_verdict_is_cached_for_the_process(monkeypatch, fresh_probe):
    calls = []

    def _run(*a, **k):
        calls.append(a)
        return _completed(0, stdout='probe: ok\n')

    monkeypatch.setattr(subprocess, 'run', _run)

    assert WhisperLoader._check_gpu_compatible() is True
    assert WhisperLoader._check_gpu_compatible(device_index=1) is True
    assert len(calls) == 1


class _FakeFetch:
    """Stands in for the weight-fetch child: each entry of ``plan`` is 'timeout', 'fail' or 'ok'."""

    starts: list = []
    killed: int = 0
    plan: list = []
    on_ok = staticmethod(lambda: None)

    def __init__(self, args, **_kwargs):
        _FakeFetch.starts.append(args)
        self._outcome = _FakeFetch.plan.pop(0) if _FakeFetch.plan else 'ok'
        self.returncode = None

    def communicate(self, timeout=None):
        if self._outcome == 'timeout' and timeout is not None:
            raise subprocess.TimeoutExpired(cmd='fetch', timeout=timeout)
        if self._outcome == 'fail':
            self.returncode = 1
            return '', 'ConnectionError: hub unreachable'
        self.returncode = 0 if self._outcome == 'ok' else -9
        if self._outcome == 'ok':
            _FakeFetch.on_ok()
        return '', ''

    def kill(self):
        _FakeFetch.killed += 1


def _fetch_child(monkeypatch, plan, on_ok=lambda: None):
    """Install the stub fetch child with a plan of outcomes; returns the class for its records."""
    _FakeFetch.starts = []
    _FakeFetch.killed = 0
    _FakeFetch.plan = list(plan)
    _FakeFetch.on_ok = staticmethod(on_ok)
    monkeypatch.setattr(subprocess, 'Popen', _FakeFetch)
    return _FakeFetch


def _weights(tmp_path, complete=True):
    """A fake cache snapshot directory, with or without model.bin."""
    snapshot = tmp_path / 'snapshots' / 'abc'
    snapshot.mkdir(parents=True, exist_ok=True)
    (snapshot / 'config.json').write_text('{}')
    if complete:
        (snapshot / 'model.bin').write_bytes(b'weights')
    return snapshot


def _local_lookup(monkeypatch, snapshot):
    """A faster_whisper whose local-only lookup returns ``snapshot`` (or raises when None); downloading is not its job."""
    calls = []

    def _download(name, cache_dir=None, local_files_only=False):
        calls.append((name, cache_dir, local_files_only))
        if not local_files_only:
            raise AssertionError('the parent must not download in-process')
        if snapshot is None:
            raise FileNotFoundError('not cached')
        return str(snapshot)

    monkeypatch.setitem(sys.modules, 'faster_whisper', types.SimpleNamespace(download_model=_download))
    return calls


def test_a_failed_weight_download_does_not_decide_the_verdict(monkeypatch, fresh_probe, caplog):
    """The parent fetches the probe weights best effort; a hub problem never means "CPU"."""
    calls = _local_lookup(monkeypatch, None)
    fetch = _fetch_child(monkeypatch, ['fail'])
    ran = []
    monkeypatch.setattr(subprocess, 'run', lambda *a, **k: ran.append(a) or _completed(0, stdout='probe: ok\n'))

    with caplog.at_level(logging.WARNING, logger='rocketlib.models.whisper'):
        assert WhisperLoader._check_gpu_compatible(download_root='/models') is True

    # The local cache is asked first; only then is the hub tried, once, in a child.
    assert calls == [(whispermod._GPU_PROBE_MODEL, '/models', True)]
    assert len(fetch.starts) == 1 and fetch.starts[0][-2:] == [whispermod._GPU_PROBE_MODEL, '/models']
    assert len(ran) == 1  # the probe still ran; the child decides from its local cache
    assert WhisperLoader._gpu_probe_reason is None
    assert WhisperLoader._gpu_compatible is True  # a failed fetch is final, not provisional
    assert any('hub unreachable' in record.getMessage() for record in caplog.records)


def test_a_cached_tiny_makes_no_network_call(monkeypatch, fresh_probe, tmp_path):
    """With the weights in the cache the parent never touches the hub, so a firewalled host is not delayed."""
    calls = _local_lookup(monkeypatch, _weights(tmp_path, complete=True))
    fetch = _fetch_child(monkeypatch, [])

    assert WhisperLoader._prefetch_probe_weights('/models') is True
    assert calls == [(whispermod._GPU_PROBE_MODEL, '/models', True)]
    assert fetch.starts == []  # no fetch child, no network


def test_a_partial_snapshot_counts_as_not_cached_and_is_fetched_again(monkeypatch, fresh_probe, tmp_path):
    """An interrupted download leaves a snapshot without model.bin; the parent must not take it for a complete copy."""
    snapshot = _weights(tmp_path, complete=False)
    _local_lookup(monkeypatch, snapshot)
    fetch = _fetch_child(monkeypatch, ['ok'], on_ok=lambda: (snapshot / 'model.bin').write_bytes(b'weights'))

    assert WhisperLoader._prefetch_probe_weights(str(tmp_path)) is True
    assert len(fetch.starts) == 1  # the fetch resumed and completed the snapshot


_SKIPPED_STDOUT = 'probe: storage view ok\nprobe: inference skipped: tiny weights are not cached locally; LocalEntryNotFoundError\nprobe: ok\n'
_FULL_STDOUT = 'probe: storage view ok\nprobe: inference ok 1\nprobe: ok\n'


def test_a_slow_weight_fetch_is_stopped_and_the_verdict_stays_provisional_once(
    monkeypatch, fresh_probe, caplog, tmp_path
):
    """A hub that never answers costs the bound, the fetch child is killed, the probe still runs on what is local,
    and the storage-view verdict is not cached, so the next load fetches again and can run the inference stage.
    """
    snapshot = _weights(tmp_path, complete=False)  # a stopped fetch leaves a partial snapshot behind
    _local_lookup(monkeypatch, snapshot)
    fetch = _fetch_child(monkeypatch, ['timeout', 'ok'], on_ok=lambda: (snapshot / 'model.bin').write_bytes(b'weights'))
    children = []

    def _run(*a, **k):
        children.append(a)
        complete = (snapshot / 'model.bin').is_file()
        return _completed(0, stdout=_FULL_STDOUT if complete else _SKIPPED_STDOUT)

    monkeypatch.setattr(subprocess, 'run', _run)

    with caplog.at_level(logging.WARNING, logger='rocketlib.models.whisper'):
        assert WhisperLoader._check_gpu_compatible(download_root=str(tmp_path)) is True  # first load: GPU kept
    assert fetch.killed == 1
    assert WhisperLoader._gpu_compatible is None  # provisional: not cached
    assert WhisperLoader._gpu_probe_inference_skipped is not None
    assert any('did not finish within' in r.getMessage() for r in caplog.records)
    assert any('the next load probes again' in r.getMessage() for r in caplog.records)

    assert WhisperLoader._check_gpu_compatible(download_root=str(tmp_path)) is True  # second load: fetch completes
    assert len(fetch.starts) == 2 and len(children) == 2
    assert WhisperLoader._gpu_compatible is True and WhisperLoader._gpu_probe_inference_skipped is None

    assert WhisperLoader._check_gpu_compatible(download_root=str(tmp_path)) is True  # cached from here on
    assert len(fetch.starts) == 2 and len(children) == 2


def test_a_hub_that_never_answers_costs_the_bound_twice_then_the_verdict_is_cached(monkeypatch, fresh_probe, caplog):
    """Provisional once only: an unreachable hub must not cost every Whisper load the fetch bound."""
    _local_lookup(monkeypatch, None)
    fetch = _fetch_child(monkeypatch, ['timeout', 'timeout'])
    children = []
    monkeypatch.setattr(subprocess, 'run', lambda *a, **k: children.append(a) or _completed(0, stdout=_SKIPPED_STDOUT))

    with caplog.at_level(logging.WARNING, logger='rocketlib.models.whisper'):
        assert WhisperLoader._check_gpu_compatible() is True
        assert WhisperLoader._gpu_compatible is None  # first timeout: provisional
        assert WhisperLoader._check_gpu_compatible() is True
        assert WhisperLoader._gpu_compatible is True  # second timeout: the storage-view verdict is kept
        assert WhisperLoader._check_gpu_compatible() is True

    assert fetch.killed == 2 and len(fetch.starts) == 2 and len(children) == 2
    assert WhisperLoader._gpu_probe_fetch_timeouts == 2


def test_the_prefetched_weights_land_in_the_callers_cache(monkeypatch, fresh_probe):
    _local_lookup(monkeypatch, None)
    fetch = _fetch_child(monkeypatch, ['ok'])
    seen = {}

    def _run(*a, **k):
        seen['script'] = a[0][2]
        return _completed(0, stdout='probe: ok\n')

    monkeypatch.setattr(subprocess, 'run', _run)

    assert WhisperLoader._check_gpu_compatible(download_root='/models') is True
    assert fetch.starts[0][-2:] == [whispermod._GPU_PROBE_MODEL, '/models']  # the fetch child fills the same cache
    assert "name, root = 'tiny', '/models'" in seen['script']  # the probe child looks in the same cache


def test_first_candidate_gpu_skips_excluded_devices():
    torch = types.SimpleNamespace(cuda=types.SimpleNamespace(device_count=lambda: 3))  # no memory query

    assert WhisperLoader._first_candidate_gpu([], torch) == 0
    assert WhisperLoader._first_candidate_gpu([0], torch) == 1


def test_first_candidate_gpu_prefers_the_device_with_the_most_free_memory():
    free = {0: 1 << 30, 1: 70 << 30, 2: 30 << 30}
    torch = types.SimpleNamespace(
        cuda=types.SimpleNamespace(device_count=lambda: 3, mem_get_info=lambda i: (free[i], 80 << 30))
    )

    assert WhisperLoader._first_candidate_gpu([], torch) == 1
    assert WhisperLoader._first_candidate_gpu([1], torch) == 2
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
    def _fake(cls, device_index=0, download_root=None, local_files_only=False):
        record = {'device_index': device_index, 'download_root': download_root}
        if local_files_only:
            record['local_files_only'] = True
        calls.append(record)
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


def test_local_mode_without_a_device_falls_back_and_says_why(model_stack, monkeypatch, caplog):
    """The path audio_transcribe takes without a model server: device=None with CUDA available."""
    _probe_says(monkeypatch, False, 'exit 1 after "probe: storage view ok"')

    with caplog.at_level(logging.ERROR, logger='rocketlib.models.whisper'):
        _bundle, metadata, gpu_index = WhisperLoader.load('tiny')

    assert (gpu_index, metadata['device']) == (-1, 'cpu')
    assert metadata['device_fallback'] == 'exit 1 after "probe: storage view ok"'
    assert len([r for r in caplog.records if r.levelno == logging.ERROR]) == 1


def test_local_mode_without_a_device_uses_the_gpu_when_the_probe_passes(model_stack, monkeypatch):
    calls = _probe_says(monkeypatch, True)

    _bundle, metadata, gpu_index = WhisperLoader.load('tiny', download_root='/models')

    assert (gpu_index, metadata['device']) == (0, 'cuda:0')
    assert 'device_fallback' not in metadata
    assert calls == [{'device_index': 0, 'download_root': '/models'}]


def test_the_loader_forwards_local_files_only_to_the_probe(model_stack, monkeypatch):
    calls = _probe_says(monkeypatch, True)

    WhisperLoader.load('tiny', local_files_only=True)

    assert calls == [{'device_index': 0, 'download_root': None, 'local_files_only': True}]


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
