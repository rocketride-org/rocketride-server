"""Regression cases for reviewed configuration and process-lifetime fixes."""

import importlib
import subprocess
from types import SimpleNamespace

import pytest
from .test_streams import NODE, node, feed, media as media_fixture

media = media_fixture


@pytest.mark.parametrize('value', ['oops', '[1]', '[1,2,3]', '[false,4]', '[3,2]', '[0,"nan"]', '-1-3'])
def test_bad_ranges_never_expand_to_full_input(value):
    """Reject malformed boundaries instead of silently decoding the whole source."""
    module = importlib.import_module(NODE + '._support.media')
    with pytest.raises(ValueError):
        module.parse_range(value)


@pytest.mark.parametrize('value', ['100-200', '100..200', '[100,200]', [100, 200]])
def test_range_input_forms(value):
    """Accept the documented string and JSON-array forms with identical units."""
    module = importlib.import_module(NODE + '._support.media')
    assert module.parse_range(value) == (100, 200)
    assert module.parse_range('') is None


@pytest.mark.parametrize('operation', ['run_ffmpeg', '_probe_ffmpeg'])
def test_ffmpeg_timeout_is_bounded_and_reported(monkeypatch, operation):
    """Propagate timeouts with command context, for encodes and metadata probes."""
    module = importlib.import_module(NODE + '._support.media')
    monkeypatch.setenv('ROCKETRIDE_MEDIA_FFMPEG_TIMEOUT', '12.5')
    monkeypatch.setattr(module, 'ffmpeg_exe', lambda: 'ffmpeg')

    def timeout(cmd, **kwargs):
        assert kwargs['timeout'] == 12.5
        raise subprocess.TimeoutExpired(cmd, kwargs['timeout'])

    monkeypatch.setattr(module.subprocess, 'run', timeout)
    with pytest.raises(RuntimeError, match='timed out after 12.5'):
        getattr(module, operation)([] if operation == 'run_ffmpeg' else 'input.mp4')


@pytest.mark.parametrize('value', ['nan', 'inf', '-1', '0', 'bad', '86401'])
def test_timeout_configuration_rejects_unbounded_values(monkeypatch, value):
    """Never turn an invalid timeout override into an unbounded process."""
    module = importlib.import_module(NODE + '._support.media')
    monkeypatch.setenv('ROCKETRIDE_MEDIA_FFMPEG_TIMEOUT', value)
    with pytest.raises(ValueError):
        module.ffmpeg_timeout()


@pytest.mark.parametrize('quality, expected', [(-1, 2), (1, 2), (1000, 31), (0, 2)])
def test_still_quality_is_bounded(media, monkeypatch, quality, expected):
    """Keep caller-supplied JPEG quantization inside the encoder's valid range."""
    module = importlib.import_module(NODE + '.media')
    observed = []
    original = module.cut_still

    def cut(*args, **kwargs):
        observed.append(kwargs['quality'])
        return original(*args, **kwargs)

    monkeypatch.setattr(module, 'cut_still', cut)
    instance = node({'mode': 'stills', 'quality': quality, 'stills': [{'id': 'one', 't_ms': 500}]})
    feed(instance, media)
    instance.closing()
    assert observed == [expected]


def test_silence_floor_uses_configured_minimum(monkeypatch):
    """Preserve pauses below the configured floor and include the exact boundary."""
    module = importlib.import_module(NODE + '.measure')
    monkeypatch.setattr(
        module,
        '_run_process',
        lambda *args, **kwargs: SimpleNamespace(
            stderr='silence_start: 0\nsilence_end: 0.15\nsilence_start: 1\nsilence_end: 1.2'
        ),
    )
    assert module.detect_silences('audio.wav', min_silence_ms=200, keep_pause_ms=0) == [(1000, 1200)]


def test_null_request_values_use_absent_field_semantics(tmp_path):
    """Do not turn JSON null into a misleading string-valued media option."""
    from .test_streams import node, feed

    source = tmp_path / 'input.mp4'
    source.write_bytes(b'media')
    instance = node({'range': None, 'sample_rate': None, 'spec': {}})
    captured = {}
    instance._process = lambda *args: captured.update(instance._ctx)
    feed(instance, source)
    instance.closing()
    assert 'range' not in captured and 'sample_rate' not in captured


@pytest.mark.parametrize('value', ['inf', '-inf', 'nan'])
def test_nonfinite_counts_fall_back(value):
    """Unbounded numeric options follow the existing invalid-value fallback."""
    module = importlib.import_module(NODE + '._support.media')
    assert module.parse_count(value, 7) == 7


def test_undeclared_stream_rejects_bytes_above_input_budget():
    """Unknown-length streams cannot fill disk beyond the configured budget."""
    from .test_streams import node, deliver
    from rocketlib import AVI_ACTION

    instance = node(config={'max_input_bytes': 6})
    root = instance._workspace.root
    try:
        deliver(instance, 'video', AVI_ACTION.BEGIN, b'{"name":"source.mp4"}')
        deliver(instance, 'video', AVI_ACTION.WRITE, b'123456')
        with pytest.raises(ValueError, match='max_input_mb'):
            deliver(instance, 'video', AVI_ACTION.WRITE, b'7')
        active = instance._active['video']
        active['file'].flush()
        assert (root / 'source.mp4').read_bytes() == b'123456'
    finally:
        instance.close()
    assert not root.exists()


def test_declared_input_above_budget_is_rejected_before_file_creation():
    """Known oversized inputs fail immediately instead of consuming scratch disk."""
    from .test_streams import node, deliver
    from rocketlib import AVI_ACTION

    instance = node(config={'max_input_bytes': 6})
    try:
        with pytest.raises(ValueError, match='max_input_mb'):
            deliver(instance, 'video', AVI_ACTION.BEGIN, b'{"name":"source.mp4","size":7}')
        assert not list(instance._workspace.root.iterdir())
    finally:
        instance.close()


def test_input_budget_is_cumulative_across_streams():
    """Separate assets cannot each consume the entire per-object budget."""
    from .test_streams import node, deliver
    from rocketlib import AVI_ACTION

    instance = node(config={'max_input_bytes': 6})
    try:
        deliver(instance, 'video', AVI_ACTION.BEGIN, b'{"name":"source.mp4","size":4}')
        deliver(instance, 'video', AVI_ACTION.WRITE, b'1234')
        deliver(instance, 'video', AVI_ACTION.END)
        deliver(instance, 'audio', AVI_ACTION.BEGIN, b'{"name":"music.wav"}')
        with pytest.raises(ValueError, match='max_input_mb'):
            deliver(instance, 'audio', AVI_ACTION.WRITE, b'abc')
        assert instance._active['audio']['file'].tell() == 0
    finally:
        instance.close()


def test_input_budget_resets_for_next_object(tmp_path):
    """Reused instances receive a fresh input allowance for each object."""
    from .test_streams import node, feed

    instance = node({'spec': {}}, config={'max_input_bytes': 6})
    instance._process = lambda *args: None
    source = tmp_path / 'input.mp4'
    source.write_bytes(b'123456')
    feed(instance, source)
    instance.closing()
    instance.open(SimpleNamespace(name='source.mp4'))
    feed(instance, source)
    instance.closing()


@pytest.mark.parametrize('value', ['nan', 'inf', '-inf', float('nan'), float('inf'), 'invalid', '-32.5'])
def test_profile_float_values_stay_finite(monkeypatch, value):
    """Keep safe defaults for non-finite inputs while preserving valid fractions."""
    from ai.common.config import Config
    from media_inspect._support.config import load_node_config

    monkeypatch.setattr(Config, 'getNodeConfig', lambda *_: {'silence_db': value, 'scene_threshold': value})
    state = SimpleNamespace(glb=SimpleNamespace(logicalType=NODE, connConfig={}))
    defaults = {'silence_db': -35.0, 'scene_threshold': 0.35}
    result = load_node_config(state, defaults, NODE)
    assert result == ({'silence_db': -32.5, 'scene_threshold': -32.5} if value == '-32.5' else defaults)
