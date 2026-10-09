# =============================================================================
# MIT License
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

"""Regression cases for reviewed configuration and process-lifetime fixes."""

import importlib
import subprocess
from types import SimpleNamespace

import pytest
from rocketlib import AVI_ACTION
from .test_streams import NODE, SPEC, node, feed, deliver, descriptor, requires_ffmpeg, media as media_fixture

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
    """Propagate timeouts with the bound in the message and the command on the error, for encodes and probes."""
    module = importlib.import_module(NODE + '._support.media')
    monkeypatch.setenv('ROCKETRIDE_MEDIA_FFMPEG_TIMEOUT', '12.5')
    monkeypatch.setattr(module, 'ffmpeg_exe', lambda: 'ffmpeg')

    def timeout(cmd, **kwargs):
        assert kwargs['timeout'] == 12.5
        raise subprocess.TimeoutExpired(cmd, kwargs['timeout'])

    monkeypatch.setattr(module.subprocess, 'run', timeout)
    with pytest.raises(RuntimeError, match='timed out after 12.5') as caught:
        getattr(module, operation)([] if operation == 'run_ffmpeg' else 'input.mp4')
    assert caught.value.command[:3] == ['ffmpeg', '-hide_banner', '-nostdin']


@pytest.mark.parametrize('value', ['nan', 'inf', '-1', '0', 'bad', '86401'])
def test_timeout_configuration_rejects_unbounded_values(monkeypatch, value):
    """Never turn an invalid timeout override into an unbounded process."""
    module = importlib.import_module(NODE + '._support.media')
    monkeypatch.setenv('ROCKETRIDE_MEDIA_FFMPEG_TIMEOUT', value)
    with pytest.raises(ValueError):
        module.ffmpeg_timeout()


@requires_ffmpeg
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


@requires_ffmpeg
def test_video_source_with_audio_only_outputs_skips_thumbnail(media, monkeypatch):
    """A clip rendered to audio-only deliverables takes no poster: there is no picture to take one from."""
    spec = {
        'kind': 'media_render_spec',
        'keep': [[0, 1500]],
        'outputs': [{'key': 'audio', 'file': 'render.wav', 'container': 'wav'}],
        'audio': {'master': False},
        'subtitles': {'enabled': False, 'sidecars': False},
    }
    # no image sink either: the object must be admitted without one
    instance = node({'mode': 'render', 'spec': spec}, listeners=lambda lane: lane != 'image')
    monkeypatch.setattr(
        instance, '_write_thumbnail', lambda *args: pytest.fail('Audio deliverable attempted thumbnail')
    )
    feed(instance, media)
    instance.closing()
    files = instance.instance.answers[-1]['files']
    assert 'thumbnail' not in files
    assert files['audio'] == 'render.wav'


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
    source = tmp_path / 'input.mp4'
    source.write_bytes(b'media')
    instance = node({'range': None, 'sample_rate': None, 'spec': SPEC})
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
    instance = node(config={'max_input_bytes': 6})
    root = instance._workspace.root
    try:
        deliver(instance, 'video', AVI_ACTION.BEGIN, descriptor('source.mp4'))
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
    instance = node(config={'max_input_bytes': 6})
    try:
        with pytest.raises(ValueError, match='max_input_mb'):
            deliver(instance, 'video', AVI_ACTION.BEGIN, descriptor('source.mp4', 7))
        assert not list(instance._workspace.root.iterdir())
    finally:
        instance.close()


def test_input_budget_is_cumulative_across_streams():
    """Separate assets cannot each consume the entire per-object budget."""
    instance = node(config={'max_input_bytes': 6})
    try:
        deliver(instance, 'video', AVI_ACTION.BEGIN, descriptor('source.mp4', 4))
        deliver(instance, 'video', AVI_ACTION.WRITE, b'1234')
        deliver(instance, 'video', AVI_ACTION.END)
        deliver(instance, 'audio', AVI_ACTION.BEGIN, descriptor('music.wav', lane='audio'))
        with pytest.raises(ValueError, match='max_input_mb'):
            deliver(instance, 'audio', AVI_ACTION.WRITE, b'abc')
        assert instance._active['audio']['file'].tell() == 0
    finally:
        instance.close()


def test_input_budget_resets_for_next_object(tmp_path):
    """Reused instances receive a fresh input allowance for each object."""
    instance = node({'spec': SPEC}, config={'max_input_bytes': 6})
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


@pytest.mark.parametrize('layout,width,height', [('4:5', 160, 200), ('1:1', 160, 160)])
def test_programme_preserves_explicit_caption_layout(media, monkeypatch, layout, width, height):
    """Exercise the programme caller and actual ASS builder on feed-shaped outputs."""
    module = importlib.import_module(NODE + '.IInstance')
    from media_render.captions import CAPTION_LAYOUTS

    original = module.build_ass
    scripts = []

    def capture(groups, selected, **kwargs):
        assert selected == layout
        text = original(groups, selected, **kwargs)
        scripts.append(text)
        return text

    monkeypatch.setattr(module, 'build_ass', capture)
    spec = {
        'pipeline': 'programme',
        'keep': [[0, 1500]],
        'audio': {'master': False},
        'thumbnail': False,
        'outputs': [{'key': 'feed', 'file': 'feed.mp4', 'width': width, 'height': height, 'caption_layout': layout}],
        'subtitles': {'words': [{'w': 'Hello', 's': 100, 'e': 800}], 'sidecars': False},
    }
    instance = node({'mode': 'render', 'spec': spec})
    feed(instance, media)
    instance.closing()
    assert scripts
    play_w, play_h, *_ = CAPTION_LAYOUTS[layout]
    assert all(f'PlayResX: {play_w}' in script and f'PlayResY: {play_h}' in script for script in scripts)
    assert instance.instance.files['feed.mp4']


@pytest.mark.parametrize('force_reencode', [False, True])
def test_concat_parts_accepts_apostrophes_in_temporary_paths(media, tmp_path, monkeypatch, force_reencode):
    """Both concat attempts consume the same correctly quoted real input paths."""
    from media_render import render_lib
    from media_render._support.media import probe

    folder = tmp_path / "user's workspace"
    folder.mkdir()
    source = folder / "part's video.mp4"
    source.write_bytes(media.read_bytes())
    original = render_lib.run_ffmpeg
    attempts = []

    def run(args):
        attempts.append(args)
        if force_reencode and len(attempts) == 1:
            raise RuntimeError('force stream-copy failure')
        return original(args)

    monkeypatch.setattr(render_lib, 'run_ffmpeg', run)
    out = render_lib.concat_parts([source, source], folder / 'joined.mp4', folder)
    measured = probe(out)
    assert measured['has_video'] and measured['has_audio']
    assert 3900 <= measured['duration_ms'] <= 4200
    assert len(attempts) == (2 if force_reencode else 1)


def test_audio_first_output_still_reports_and_measures_primary_video(media, monkeypatch):
    """Output ordering must not make a valid audiovisual render look audio-only."""
    module = importlib.import_module(NODE + '.IInstance')
    original = module.measure_loudness
    measured = []

    def capture(path, *args, **kwargs):
        measured.append(path.suffix)
        return original(path, *args, **kwargs)

    monkeypatch.setattr(module, 'measure_loudness', capture)
    spec = {
        'keep': [[0, 1500]],
        'audio': {'master': False},
        'thumbnail': True,
        'subtitles': {'enabled': False, 'sidecars': False},
        'outputs': [
            {'key': 'audio', 'file': 'sound.wav', 'container': 'wav'},
            {'key': 'picture', 'file': 'video.mp4', 'width': 160, 'height': 90},
        ],
    }
    instance = node({'mode': 'render', 'spec': spec})
    feed(instance, media)
    instance.closing()
    report = instance.instance.answers[-1]
    assert report['has_video'] and report['has_audio']
    assert (report['width'], report['height']) == (160, 90)
    assert measured == ['.mp4']
    assert 'picture' in report['measurements']
    assert 'thumbnail' in report['files']


@pytest.mark.parametrize('field', ['source', 'overlays', 'concat', 'music'])
@pytest.mark.parametrize('filename', ["user's [take];1=ok.mp4", '../escape.mp4', '/root.mp4', 'C:/video.mp4'])
def test_input_path_validation_matches_received_names(field, filename):
    """Accept literal stream names while still refusing workspace escapes."""
    from media_render import plan

    spec = {**SPEC, 'source': 'source.mp4', 'write_to': 'outputs'}
    if field == 'source':
        spec[field] = filename
    elif field == 'music':
        spec[field] = {'source': filename}
    else:
        spec[field] = [{'path': filename}]
    if filename.startswith('user'):
        plan.validate_spec(spec)
    else:
        with pytest.raises(plan.SpecError):
            plan.validate_spec(spec)


def test_render_accepts_a_literal_stream_name_with_filter_characters(media, tmp_path):
    """The streamed filename is copied to a safe local decode path before FFmpeg."""
    source = tmp_path / "user's [take];1=ok.mp4"
    source.write_bytes(media.read_bytes())
    instance = node({'mode': 'render', 'spec': {**SPEC, 'source': source.name}})
    feed(instance, source)
    instance.closing()
    assert instance.instance.files['wide.mp4']


@pytest.mark.parametrize('decoder', [None, SimpleNamespace()])
def test_probe_falls_back_when_pyav_decoder_cannot_be_imported(media, monkeypatch, decoder):
    """An absent or partially installed optional decoder still permits FFmpeg probing."""
    import sys
    from media_render._support.media import probe

    monkeypatch.setitem(sys.modules, 'av', decoder)
    result = probe(media)
    assert result['has_video'] and result['has_audio']
    assert (result['width'], result['height']) == (320, 180)
    assert 1900 <= result['duration_ms'] <= 2100


@pytest.mark.parametrize('explicit', [None, [500, 1900]])
def test_late_clip_only_decodes_required_source_window(media, monkeypatch, explicit):
    """Avoid decoding the prefix of a long recording, preserving explicit bounds."""
    module = importlib.import_module(NODE + '.IInstance')
    original = module.slice_audio
    decoded = []

    def capture(source, start, end, *args, **kwargs):
        decoded.append((start, end))
        return original(source, start, end, *args, **kwargs)

    monkeypatch.setattr(module, 'slice_audio', capture)
    spec = {**SPEC, 'keep': [[1000, 1800]], 'audio': {'master': False}}
    if explicit:
        spec['source_range'] = explicit
    instance = node({'spec': spec})
    feed(instance, media)
    instance.closing()
    assert decoded[0] == tuple(explicit or [1000, 1800])
    assert instance.instance.answers[-1]['output_duration_ms'] == 800


@pytest.mark.parametrize('pipeline', ['clip', 'programme'])
def test_resized_panels_and_caption_seam_use_output_coordinates(media, tmp_path, monkeypatch, pipeline):
    """Real renders preserve a one-quarter/three-quarter split after canvas resize."""
    import copy
    from media_render._support.media import run_ffmpeg, probe
    from media_render import IInstance

    module = importlib.import_module(NODE + '.IInstance')
    plan = {
        'canvas': {'width': 640, 'height': 640},
        'source': {'width': 320, 'height': 180},
        'segments': [
            {
                'start_ms': 0,
                'end_ms': 1500,
                'layout': 'stacked_two',
                'subjects': ['a', 'b'],
                'panels': [
                    {'subject': 'a', 'x': 0, 'y': 0, 'w': 640, 'h': 160},
                    {'subject': 'b', 'x': 0, 'y': 160, 'w': 640, 'h': 480},
                ],
            }
        ],
        'paths': [
            {
                'segment': 0,
                'subject': subject,
                'panel': subject,
                'w': 160,
                'h': 180,
                'keyframes': [[0, x, 0], [1500, x, 0]],
            }
            for subject, x in [('a', 0), ('b', 160)]
        ],
    }
    before = copy.deepcopy(plan)
    source = tmp_path / 'red-blue.mp4'
    run_ffmpeg(
        [
            '-f',
            'lavfi',
            '-i',
            'color=red:size=320x180:rate=30,drawbox=x=160:y=0:w=160:h=180:color=blue:t=fill',
            '-f',
            'lavfi',
            '-i',
            'sine=frequency=440:sample_rate=48000',
            '-t',
            '1.5',
            '-c:v',
            'libx264',
            '-pix_fmt',
            'yuv420p',
            '-c:a',
            'aac',
            '-y',
            str(source),
        ]
    )
    original = module.build_ass
    placements = []

    def capture(groups, layout, **kwargs):
        placements.append(kwargs['placement'](500))
        return original(groups, layout, **kwargs)

    monkeypatch.setattr(module, 'build_ass', capture)
    spec = {
        'pipeline': pipeline,
        'keep': [[0, 1500]],
        'framing_plan': plan,
        'audio': {'master': False},
        'thumbnail': False,
        'subtitles': {'words': [{'w': 'Hello', 's': 100, 'e': 700}], 'sidecars': False},
        'outputs': [
            {
                'key': 'square',
                'file': 'square.mp4',
                'width': 160,
                'height': 160,
                'caption_layout': '1:1',
                'framing': True,
            }
        ],
    }
    instance = node({'spec': spec})
    feed(instance, source)
    instance.closing()
    output = tmp_path / (pipeline + '.mp4')
    output.write_bytes(instance.instance.files['square.mp4'])
    assert (probe(output)['width'], probe(output)['height']) == (160, 160)
    # Read a frame after the caption has disappeared, so text cannot mask geometry.
    frame = tmp_path / 'frame.rgb'
    run_ffmpeg(
        ['-ss', '1', '-i', str(output), '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-y', str(frame)]
    )
    pixels = frame.read_bytes()

    def pixel(x, y):
        return pixels[(y * 160 + x) * 3 : (y * 160 + x) * 3 + 3]

    red, green, blue = pixel(80, 20)
    assert red > 180 and blue < 60
    red, green, blue = pixel(80, 60)
    assert blue > 180 and red < 60
    assert placements and set(placements) == {'seam:0.2500'}
    shaped = module.resize_layout(plan, 160, 160)
    assert shaped['paths'] == plan['paths']
    assert IInstance._seam_placement(shaped, [(0, 1500)], 160)(500) == 'seam:0.2500'
    assert plan == before  # Resizing must never alter crop coordinates or the caller's plan.


@pytest.mark.parametrize('keep', [[[0, 1000], [500, 1500]], [[1000, 500]], []])
def test_invalid_static_edit_fails_before_input(monkeypatch, keep):
    """Pipeline startup rejects an edit every uploaded object would fail to render."""
    import depends
    import json
    from media_render.IGlobal import IGlobal, DEFAULTS

    module = importlib.import_module(NODE + '.IGlobal')
    monkeypatch.setattr(depends, 'load_depends', lambda *_: None)
    request = {'spec': {**SPEC, 'keep': keep}}
    monkeypatch.setattr(module, 'load_node_config', lambda *_: {**DEFAULTS, 'request': json.dumps(request)})
    state = IGlobal()
    state.IEndpoint = SimpleNamespace(endpoint=SimpleNamespace(openMode=None))
    with pytest.raises(ValueError):
        state.beginGlobal()


@pytest.mark.parametrize('pipeline', ['clip', 'programme'])
@pytest.mark.parametrize('audio_only', [False, True])
def test_video_without_audio_gets_a_synchronized_silent_track(media, tmp_path, pipeline, audio_only):
    """A missing source track can still produce video or audio-only deliverables."""
    from media_render._support.media import probe, run_ffmpeg

    source = tmp_path / 'silent-source.mp4'
    run_ffmpeg(['-i', str(media), '-an', '-c:v', 'copy', '-y', str(source)])
    filename = 'audio.wav' if audio_only else 'video.mp4'
    output = {
        'key': 'result',
        'file': filename,
        'container': 'wav' if audio_only else 'mp4',
        'width': 160,
        'height': 90,
    }
    spec = {
        'pipeline': pipeline,
        'keep': [[500, 1000], [1200, 1800]],
        'thumbnail': False,
        'outputs': [output],
        'subtitles': {'enabled': False, 'sidecars': False},
    }
    instance = node({'spec': spec})
    feed(instance, source)
    instance.closing()
    target = tmp_path / filename
    target.write_bytes(instance.instance.files[filename])
    info = probe(target)
    assert info['has_audio'] and info['has_video'] is not audio_only
    assert abs(info['duration_ms'] - 1100) <= 34
    assert any('silent' in warning.lower() for warning in instance.instance.answers[-1]['warnings'])


@pytest.mark.parametrize('bleep', [(650, 850), (0, 100), (1900, 1950)])
def test_missing_audio_keeps_programme_bleeps_on_the_edited_clock(media, tmp_path, bleep):
    """The silent source still passes through edit effects after its window is shifted."""
    import array
    import wave
    from media_render._support.media import run_ffmpeg

    source = tmp_path / 'silent.mp4'
    run_ffmpeg(['-i', str(media), '-an', '-c:v', 'copy', '-y', str(source)])
    spec = {
        'pipeline': 'programme',
        'keep': [[500, 1000], [1200, 1800]],
        'bleeps': [bleep],
        'audio': {'master': False},
        'thumbnail': False,
        'outputs': [{'key': 'sound', 'file': 'sound.wav', 'container': 'wav'}],
    }
    instance = node({'spec': spec})
    feed(instance, source)
    instance.closing()
    target = tmp_path / 'sound.wav'
    target.write_bytes(instance.instance.files['sound.wav'])
    with wave.open(str(target), 'rb') as wav:
        assert wav.getsampwidth() == 2

        def peak(at):
            wav.setpos(int(at * wav.getframerate()))
            data = array.array('h', wav.readframes(int(0.05 * wav.getframerate())))
            if __import__('sys').byteorder != 'little':
                data.byteswap()
            return max(abs(value) for value in data)

        if bleep == (650, 850):
            assert peak(0.22) > 300  # source 720 ms -> output 220 ms
        else:
            assert peak(0.22) < 10  # Effects outside the kept source window are discarded.
        assert peak(0.8) < 10  # outside the bleep, the generated source is silent


@pytest.mark.parametrize('keep', [[[0, 700]], [[700, 1700]]])
def test_keep_cannot_extend_beyond_explicit_source_range(keep):
    """The decoder window must contain every interval actually rendered."""
    from media_render.plan import resolve_keep, SpecError

    with pytest.raises(SpecError, match='inside source_range'):
        resolve_keep({'keep': keep, 'source_range': [500, 1500]})
    assert resolve_keep({'keep': [[600, 1400]], 'source_range': [500, 1500]})['keep'] == [(600, 1400)]
    # A preview window may select a valid subset of a larger edit plan.
    assert resolve_keep({'keep': [[0, 2000]], 'window': [500, 1500], 'source_range': [500, 1500]})['keep'] == [
        (500, 1500)
    ]


@pytest.mark.parametrize(
    'overrides',
    [
        {'meta': []},
        {'status_meta': 'bad'},
        {'warnings': 'bad'},
        {'framing_plan': []},
        {'framing_plan': {'segments': 'bad'}},
        {'framing_plan': {'segments': [None]}},
        {'framing_plan': {'segments': [{'layout': 1, 'start_ms': 0, 'end_ms': 1000}]}},
        {'framing_plan': {'segments': [{'layout': 'stacked_two', 'start_ms': 0.5, 'end_ms': 1000}]}},
        {'framing_plan': {'segments': [{'layout': 'stacked_two', 'start_ms': False, 'end_ms': 1000}]}},
    ],
)
def test_malformed_metadata_and_framing_fail_validation(overrides):
    """Reject invalid shapes before a stream is uploaded, with the offending field named."""
    from media_render.plan import validate_spec, SpecError

    with pytest.raises(SpecError, match=next(iter(overrides))):
        validate_spec({**SPEC, 'source': 'in.mp4', 'write_to': 'outputs', **overrides})


def test_concat_timeout_does_not_launch_a_second_encode(tmp_path, monkeypatch):
    """A timed-out copy has spent its budget; only format failures may re-encode."""
    from media_render import render_lib
    from media_render._support.media import FFmpegError

    calls = []

    def timed_out(args):
        calls.append(args)
        try:
            raise subprocess.TimeoutExpired('ffmpeg', 1)
        except subprocess.TimeoutExpired as exc:
            raise FFmpegError('ffmpeg timed out after 1 seconds', ['ffmpeg']) from exc

    monkeypatch.setattr(render_lib, 'run_ffmpeg', timed_out)
    with pytest.raises(FFmpegError, match='timed out'):
        render_lib.concat_parts(['a.mp4', 'b.mp4'], tmp_path / 'out.mp4', tmp_path)
    assert len(calls) == 1


@pytest.mark.parametrize('explicit', [False, True])
def test_secondary_programme_video_reports_its_inherited_render(media, explicit):
    """Never claim independently applied captions/framing on a programme transcode."""
    secondary = {'key': 'square', 'file': 'square.mp4', 'width': 160, 'height': 160}
    if explicit:
        secondary['from'] = 'wide'
    spec = {
        **SPEC,
        'pipeline': 'programme',
        'audio': {'master': False},
        'outputs': [{'key': 'wide', 'file': 'wide.mp4', 'width': 160, 'height': 90}, secondary],
    }
    instance = node({'spec': spec})
    feed(instance, media)
    instance.closing()
    assert {'wide.mp4', 'square.mp4'} <= instance.instance.files.keys()
    notes = [w for w in instance.instance.answers[-1]['warnings'] if 'independent framing and captions' in w]
    assert bool(notes) is not explicit
