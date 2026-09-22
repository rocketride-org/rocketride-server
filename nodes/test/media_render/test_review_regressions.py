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


def test_audio_only_programme_does_not_generate_thumbnail(tmp_path, monkeypatch):
    """An audio export must remain valid when a caller requests a thumbnail."""
    module = importlib.import_module(NODE + '._support.media')
    source = tmp_path / 'audio.wav'
    module.run_ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '2', '-y', str(source)])
    spec = {
        'kind': 'media_render_spec',
        'pipeline': 'programme',
        'source': source.name,
        'keep': [[0, 1500]],
        'thumbnail': True,
        'media': {'has_video': False, 'has_audio': True},
        'outputs': [{'key': 'audio', 'file': 'render.wav', 'container': 'wav'}],
        'audio': {'master': False},
        'subtitles': {'enabled': False, 'sidecars': False},
    }
    instance = node({'mode': 'render', 'spec': spec})
    monkeypatch.setattr(instance, '_write_thumbnail', lambda *args: pytest.fail('Audio attempted thumbnail'))
    feed(instance, source, lane='audio')
    instance.closing()
    assert 'thumbnail' not in instance.instance.answers[-1]['files']


@pytest.mark.parametrize('enabled', [False, True])
def test_short_render_respects_speaker_colour_setting(media, monkeypatch, enabled):
    """Apply speaker colours to short renders only when the style enables them."""
    module = importlib.import_module(NODE + '.IInstance')
    observed = []
    original = module.build_ass

    def build(*args, **kwargs):
        observed.append(kwargs.get('speaker_colors'))
        return original(*args, **kwargs)

    monkeypatch.setattr(module, 'build_ass', build)
    colours = {'s1': '#FF0000'}
    spec = {
        'kind': 'media_render_spec',
        'keep': [[0, 1500]],
        'thumbnail': False,
        'outputs': [{'key': 'wide', 'file': 'render.mp4', 'aspect': '16:9', 'width': 320, 'height': 180}],
        'audio': {'master': False},
        'subtitles': {
            'words': [{'w': 'Hello', 's': 100, 'e': 500, 'speaker': 's1'}],
            'style': {'speaker_colors': enabled},
            'speaker_colors': colours,
            'sidecars': False,
        },
    }
    instance = node({'mode': 'render', 'spec': spec})
    feed(instance, media)
    instance.closing()
    assert observed == [colours if enabled else None]


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


@pytest.mark.parametrize(
    'operation,args',
    [
        ('measure_loudness', ('in.wav',)),
        ('rms_level', ('in.wav', 0)),
        ('detect_silences', ('in.wav',)),
        ('detect_scenes', ('in.mp4',)),
    ],
)
def test_render_analysis_processes_have_timeouts(monkeypatch, operation, args):
    """Analysis passes must obey the same configured bound as encodes."""
    from media_render import render_lib

    module = importlib.import_module(NODE + '._support.media')
    monkeypatch.setenv('ROCKETRIDE_MEDIA_FFMPEG_TIMEOUT', '3')

    def timeout(cmd, **kwargs):
        assert kwargs['timeout'] == 3
        raise subprocess.TimeoutExpired(cmd, 3)

    monkeypatch.setattr(module.subprocess, 'run', timeout)
    with pytest.raises(RuntimeError, match='timed out after 3'):
        getattr(render_lib, operation)(*args)


def test_layout_render_uses_probed_dimensions_when_plan_omits_them(tmp_path, monkeypatch):
    """A valid framing plan need not repeat the supplied source dimensions."""
    from media_render import render_lib

    captured = []
    monkeypatch.setattr(
        render_lib,
        'build_layout_graph',
        lambda pieces, layout, width, height, *a, **kw: captured.append((width, height)) or 'graph',
    )
    monkeypatch.setattr(render_lib, 'run_ffmpeg', lambda args: None)
    args = ('in.mp4', 0, 1000, [(0, 1000)], {'segments': []}, 'in.wav', tmp_path / 'out.mp4', tmp_path)
    render_lib.render_layout_video(*args, source={'width': 640, 'height': 360})
    assert captured == [(640, 360)]
    with pytest.raises(ValueError, match='framing plan does not say'):
        render_lib.render_layout_video(*args)


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


@pytest.mark.parametrize('pipeline', ['clip', 'programme'])
@pytest.mark.parametrize(
    'container,video',
    [
        ('mp4', True),
        ('mov', True),
        ('mkv', True),
        ('webm', True),
        ('mp3', False),
        ('wav', False),
        ('m4a', False),
        ('aac', False),
        ('flac', False),
    ],
)
def test_all_declared_containers_render_without_system_mime_table(
    media, tmp_path, monkeypatch, pipeline, container, video
):
    """Every accepted container must encode and stream on its intended lane."""
    from .test_streams import node, feed

    module = importlib.import_module(NODE + '._support.instance')
    monkeypatch.setattr(module.mimetypes, 'guess_type', lambda name: (None, None))
    filename = 'result.' + container
    spec = {
        'kind': 'media_render_spec',
        'pipeline': pipeline,
        'keep': [[0, 1000]],
        'audio': {'master': False},
        'thumbnail': False,
        'subtitles': {'enabled': False, 'sidecars': False},
        'outputs': [{'key': 'result', 'file': filename, 'container': container, 'width': 160, 'height': 90}],
    }
    instance = node({'mode': 'render', 'spec': spec})
    feed(instance, media)
    instance.closing()
    assert filename in instance.instance.files
    output = tmp_path / filename
    output.write_bytes(instance.instance.files[filename])
    measured = importlib.import_module(NODE + '._support.media').probe(output)
    assert measured['has_audio'] and measured['has_video'] == video
    artifact = next(a for a in instance.instance.answers[0]['artifacts'] if a['name'] == filename)
    assert artifact['mime'].startswith('video/' if video else 'audio/')
    assert 'text' not in artifact
