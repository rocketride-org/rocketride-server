"""Regression cases for reviewed configuration and process-lifetime fixes."""

import importlib
import asyncio
import subprocess
from types import SimpleNamespace

import pytest
from .test_streams import NODE, media as media_fixture

media = media_fixture


async def test_native_worker_exit_preserves_diagnostics():
    """An exited worker must fail promptly without querying its vanished task."""
    from .test_live import close_with_diagnostics

    class PendingPipe:
        async def close(self):
            """Represent a request whose worker exited without answering."""
            await asyncio.Event().wait()

    ended = asyncio.Event()
    ended.set()
    events = [{'event': 'exited', 'exitCode': -11}]
    with pytest.raises(pytest.fail.Exception, match='exitCode.*-11'):
        await asyncio.wait_for(close_with_diagnostics(PendingPipe(), ended, events, 420), 1)


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


@pytest.mark.parametrize('value', ['[0,1,2]', '0,1,2', '0;1;2', [0, 1, 2]])
def test_skip_pieces_accepts_json_and_delimited_lists(value):
    """Do not lose the first or last ordinal when a request contains JSON."""
    module = importlib.import_module(NODE + '.media')
    assert module.parse_ordinals(value) == {0, 1, 2}


@pytest.mark.parametrize('value', ['[0,', '[true]', '0,bad,2', '0,1.5', [-1]])
def test_bad_skip_pieces_fails_explicitly(value):
    """Malformed resume instructions must not silently repeat expensive work."""
    module = importlib.import_module(NODE + '.media')
    with pytest.raises(ValueError):
        module.parse_ordinals(value)


def test_model_cache_keeps_only_most_recent_model(monkeypatch):
    """Reuse one model, and release the cache's old reference when switching."""
    import sys

    module = importlib.import_module(NODE + '.align')
    monkeypatch.setattr(module, '_models', {})
    fake_whisper = SimpleNamespace(WhisperModel=lambda name, **kwargs: SimpleNamespace(name=name))
    monkeypatch.setitem(sys.modules, 'faster_whisper', fake_whisper)
    first = module.get_model('tiny')
    assert module.get_model('tiny') is first
    second = module.get_model('small')
    assert second.name == 'small' and list(module._models) == ['small']


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


def test_pieces_require_audio_sink_before_processing(tmp_path):
    """No completion manifest may claim audio that was never delivered."""
    from .test_streams import node

    instance = node({'mode': 'pieces'})
    instance.instance.hasListener = lambda lane: lane != 'audio'
    try:
        with pytest.raises(ValueError, match='audio consumer'):
            instance._pieces({}, 'source.mp4', tmp_path / 'missing.mp4', {'has_audio': True})
        assert not instance.instance.texts and not instance.instance.answers
    finally:
        instance.close()


def test_pieces_manifest_follows_successful_delivery(media, monkeypatch):
    """A downstream error must not leave a misleading completed reference."""
    from .test_streams import node, feed

    instance = node({'mode': 'pieces'})

    def reject(*args):
        raise RuntimeError('audio sink rejected the stream')

    monkeypatch.setattr(instance, '_feed_pieces', reject)
    feed(instance, media)
    with pytest.raises(RuntimeError, match='audio sink rejected'):
        instance.closing()
    assert not instance.instance.texts and not instance.instance.answers


def test_piece_order_stays_chronological_after_four_digits(tmp_path, monkeypatch):
    """File numbering must not reorder very long recordings at piece 10000."""
    module = importlib.import_module(NODE + '.media')
    for name in ('piece9999.wav', 'piece10000.wav', 'piece0000.wav'):
        (tmp_path / name).write_bytes(b'wav')
    monkeypatch.setattr(module, 'run_ffmpeg', lambda args: None)
    monkeypatch.setattr(module, 'probe', lambda path: {'duration_ms': 1000})
    pieces = module.split_audio(tmp_path / 'source.wav', tmp_path, 10)
    assert [piece['path'].name for piece in pieces] == ['piece0000.wav', 'piece9999.wav', 'piece10000.wav']
    assert [piece['offset_ms'] for piece in pieces] == [0, 1000, 2000]


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


@pytest.mark.parametrize('starts', [[100, 100], [200, 100], [100, 200, 100]])
def test_equal_or_decreasing_word_starts_never_overlap(starts):
    """Discard intervals that cannot be shortened to a positive duration."""
    from media_speech.align import sanitize_words

    result = sanitize_words(
        [{'word': str(i), 'start_ms': start, 'end_ms': 500, 'probability': 1} for i, start in enumerate(starts)]
    )
    assert result
    assert all(word['end_ms'] > word['start_ms'] for word in result)
    assert all(a['end_ms'] <= b['start_ms'] for a, b in zip(result, result[1:]))
    assert result[-1]['word'] == str(len(starts) - 1)
