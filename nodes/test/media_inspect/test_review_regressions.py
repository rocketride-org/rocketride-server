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
