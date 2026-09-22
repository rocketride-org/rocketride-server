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

"""
Regressions for the engine stream contract, early validation, portable
output names and scrubbed error text.

The engine wraps a stream's own fields under `metadata` on the BEGIN payload
(`engLib/store/core/stream_descriptor.hpp`, `buildStreamDescriptor`), and
calls `closing()` on every node before `close()` (`pipe.instance.cpp`),
with `currentObject` still set (`filter.target.cpp` clears it in `close()`).
"""

import importlib
import json
import os
import subprocess
import tempfile
from pathlib import Path, PureWindowsPath
from types import SimpleNamespace

import pytest
from rocketlib import AVI_ACTION

import media_render
from media_render.IGlobal import DEFAULTS, IGlobal
from .test_streams import NODE, SPEC, node, deliver, descriptor, feed, media as media_fixture

media = media_fixture


def stream(instance, lane, name, payload):
    """One whole engine-shaped stream on a lane."""
    deliver(instance, lane, AVI_ACTION.BEGIN, descriptor(name, len(payload), lane=lane))
    deliver(instance, lane, AVI_ACTION.WRITE, payload)
    deliver(instance, lane, AVI_ACTION.END)


# ---- 1. stream descriptors are read where the engine writes them


@pytest.mark.parametrize('lanes', [('video', 'image'), ('video', 'video')])
def test_engine_descriptors_name_two_streams_on_one_object(lanes):
    """A recording and an asset on one object land in two files, named by the descriptors."""
    instance = node()
    try:
        stream(instance, lanes[0], 'episode.mp4', b'v' * 8)
        stream(instance, lanes[1], 'logo.png', b'i' * 4)
        assert set(instance._inputs) == {'episode.mp4', 'logo.png'}
        assert instance._workspace.resolve('episode.mp4').read_bytes() == b'v' * 8
        assert instance._workspace.resolve('logo.png').read_bytes() == b'i' * 4
    finally:
        instance.close()


@pytest.mark.parametrize('field', ['input_name', 'spec.source'])
def test_requested_source_matches_the_descriptor_name(field):
    """`input_name` and `spec.source` select a stream by the name its descriptor carries."""
    spec = dict(SPEC)
    request = {'mode': 'render', 'spec': spec}
    if field == 'input_name':
        request['input_name'] = 'episode.mp4'
    else:
        spec['source'] = 'episode.mp4'
    instance = node(request)
    seen = []
    instance._process = lambda request, mode, source: seen.append(source)
    # a second audio/video stream forces the request to pick one by name
    stream(instance, 'video', 'episode.mp4', b'episode')
    stream(instance, 'audio', 'music.wav', b'music')
    instance.closing()
    assert seen == ['episode.mp4']


def test_unnamed_stream_falls_back_to_the_object_name():
    """A bare engine descriptor (no producer enrichment) names the stream after its object."""
    instance = node()
    try:
        deliver(instance, 'video', AVI_ACTION.BEGIN, descriptor(size=3))
        assert instance._active['video']['name'] == 'source.mp4'
        assert instance._active['video']['size'] == 3
    finally:
        instance.close()


def test_flat_descriptor_shape_is_still_read():
    """A producer that writes its fields flat (no `metadata`) is read the same way."""
    instance = node()
    try:
        deliver(instance, 'video', AVI_ACTION.BEGIN, b'{"name": "flat.mp4", "size": 3}')
        assert instance._active['video']['name'] == 'flat.mp4'
        assert instance._active['video']['size'] == 3
    finally:
        instance.close()


@pytest.mark.parametrize('payload', [b'', b'not json', b'\xff\xfe', b'[1, 2]', b'42'])
def test_non_descriptor_begin_payload_means_no_descriptor(payload):
    """Anything that is not a descriptor object is an absent descriptor, never a failure."""
    instance = node()
    try:
        deliver(instance, 'video', AVI_ACTION.BEGIN, payload)
        assert instance._active['video']['name'] == 'source.mp4'
        assert instance._active['video']['size'] is None
    finally:
        instance.close()


@pytest.mark.parametrize('declared,payload', [(10, b'abc'), (2, b'abc')])
def test_declared_size_mismatch_is_a_warning(declared, payload):
    """The declared size is advisory (it may be the container's); the bytes received are kept."""
    instance = node()
    try:
        deliver(instance, 'video', AVI_ACTION.BEGIN, descriptor('episode.mp4', declared))
        deliver(instance, 'video', AVI_ACTION.WRITE, payload)
        deliver(instance, 'video', AVI_ACTION.END)
        assert instance._inputs['episode.mp4']['received'] == len(payload)
        assert len(instance._warnings) == 1
        assert str(declared) in instance._warnings[0] and str(len(payload)) in instance._warnings[0]
    finally:
        instance.close()


def test_declared_size_mismatch_reaches_the_report(media):
    """The size warning is delivered with the render, in the report's own `warnings`."""
    spec = {
        'kind': 'media_render_spec',
        'keep': [[0, 1000]],
        'thumbnail': False,
        'audio': {'master': False},
        'subtitles': {'enabled': False, 'sidecars': False},
        'outputs': [{'key': 'wide', 'file': 'wide.mp4', 'width': 160, 'height': 90}],
    }
    instance = node({'mode': 'render', 'spec': spec})
    feed(instance, media, size=media.stat().st_size + 5)
    instance.closing()
    answer = instance.instance.answers[-1]
    assert 'wide.mp4' in instance.instance.files
    assert any('declared' in note for note in answer['warnings'])


@pytest.mark.parametrize('declared', [3, 3.0, '3', '3.0', '3e0'])
def test_integral_advisory_sizes_are_accepted(declared):
    instance = node()
    try:
        deliver(instance, 'video', AVI_ACTION.BEGIN, descriptor('source.mp4', declared))
        assert instance._active['video']['size'] == 3
        deliver(instance, 'video', AVI_ACTION.WRITE, b'abc')
        deliver(instance, 'video', AVI_ACTION.END)
        assert not instance._warnings
    finally:
        instance.close()


@pytest.mark.parametrize('declared', [True, False, -1, 1.5, 'bad', 'NaN', 'Infinity', [], {}])
def test_invalid_advisory_sizes_warn_without_bypassing_byte_limit(declared):
    instance = node(config={'max_input_bytes': 3})
    try:
        deliver(instance, 'video', AVI_ACTION.BEGIN, descriptor('source.mp4', declared))
        assert instance._active['video']['size'] is None
        assert any('invalid advisory size' in note for note in instance._warnings)
        deliver(instance, 'video', AVI_ACTION.WRITE, b'abc')
        with pytest.raises(ValueError, match='max_input_mb'):
            deliver(instance, 'video', AVI_ACTION.WRITE, b'd')
        assert instance._input_bytes == 3
        deliver(instance, 'video', AVI_ACTION.END)
        assert instance._inputs['source.mp4']['received'] == 3
    finally:
        instance.close()


@pytest.mark.parametrize('declared', [7, 7.0, '7', '7.0', '1e999999'])
def test_declared_size_above_budget_fails_at_begin(declared):
    """A descriptor that declares more than the remaining budget is refused before a file exists."""
    instance = node(config={'max_input_bytes': 6})
    try:
        with pytest.raises(ValueError, match='max_input_mb'):
            deliver(instance, 'video', AVI_ACTION.BEGIN, descriptor('episode.mp4', declared))
        assert not list(instance._workspace.root.iterdir())
    finally:
        instance.close()


# ---- 2. deliverable MIME types do not depend on the host's registry

SIDECARS = ['poster.jpg', 'poster.jpeg', 'poster.png', 'wide.srt', 'wide.vtt', 'chapters.txt', 'chapters.json']


def test_sidecar_and_thumbnail_mime_is_host_independent(monkeypatch):
    """The thumbnail and every sidecar keep their lane and MIME when the OS registry knows nothing."""
    module = importlib.import_module(NODE + '._support.instance')
    instance = node()
    try:
        outputs = instance._workspace.root / 'outputs'
        expected = {name: instance._output_type(outputs / name) for name in SIDECARS}
        monkeypatch.setattr(module.mimetypes, 'guess_type', lambda *args, **kwargs: (None, None))
        assert {name: instance._output_type(outputs / name) for name in SIDECARS} == expected
        assert expected['poster.jpg'] == ('image', 'image/jpeg')
        assert expected['poster.png'] == ('image', 'image/png')
        assert expected['wide.vtt'][1] == 'text/vtt'
        assert expected['chapters.json'][1] == 'application/json'
        assert all(lane not in ('video', 'audio', 'image') for lane, _ in (expected[n] for n in SIDECARS[3:]))
    finally:
        instance.close()


# ---- 3. static configuration and sinks are checked before input is taken


@pytest.mark.parametrize(
    'raw,message',
    [
        ('[]', 'request must be a JSON object'),
        ('{"write_to": "x"}', 'Storage destinations are unsupported'),
        ('{"mode": "layout"}', 'mode must be one of: render'),
        ('{"mode": "render"}', 'Render requires a spec JSON object'),
        ('{"spec": {"report_to": "x"}}', 'Render destinations are unsupported'),
        ('{"spec": ', 'Expecting value'),
    ],
)
def test_bad_request_is_refused_when_the_pipeline_starts(monkeypatch, raw, message):
    """The static request is parsed once, in beginGlobal, with the same messages closing() used."""
    import depends

    module = importlib.import_module(NODE + '.IGlobal')
    monkeypatch.setattr(depends, 'load_depends', lambda *_: None)
    monkeypatch.setattr(module, 'load_node_config', lambda *_: {**DEFAULTS, 'request': raw})
    state = IGlobal()
    state.IEndpoint = SimpleNamespace(endpoint=SimpleNamespace(openMode=None))
    with pytest.raises(ValueError, match=message):
        state.beginGlobal()


def test_parsed_request_is_shared_with_instances(monkeypatch):
    """Instances reuse the request beginGlobal parsed instead of parsing the JSON per object."""
    import depends

    module = importlib.import_module(NODE + '.IGlobal')
    monkeypatch.setattr(depends, 'load_depends', lambda *_: None)
    monkeypatch.setattr(module, 'load_node_config', lambda *_: {**DEFAULTS, 'request': json.dumps({'spec': SPEC})})
    state = IGlobal()
    state.IEndpoint = SimpleNamespace(endpoint=SimpleNamespace(openMode=None))
    state.beginGlobal()
    assert state.request == {'spec': SPEC} and state.mode == 'render'
    instance = node()
    instance.IGlobal = state
    try:
        request, mode = instance._request()
        assert request == {'spec': SPEC} and mode == 'render'
        assert request is not state.request  # a copy: an instance cannot edit the pipeline's request
    finally:
        instance.close()


def test_missing_thumbnail_sink_fails_before_any_ffmpeg_call(monkeypatch):
    """A clip renders a poster by default; without an image sink it is refused before anything runs."""
    module = importlib.import_module(NODE + '._support.media')
    monkeypatch.setattr(module.subprocess, 'run', lambda *args, **kwargs: pytest.fail('ffmpeg was run'))
    spec = {'keep': [[0, 1000]], 'outputs': [{'key': 'wide', 'file': 'wide.mp4', 'width': 320, 'height': 180}]}
    with pytest.raises(ValueError, match='image sink.*thumbnail'):
        node({'mode': 'render', 'spec': spec}, listeners=lambda lane: lane != 'image')
    # turning the poster off is the other way out
    instance = node({'mode': 'render', 'spec': {**spec, 'thumbnail': False}}, listeners=lambda lane: lane != 'image')
    instance.close()


@pytest.mark.parametrize(
    'outputs,missing,message',
    [
        ([{'key': 'audio', 'file': 'sound.wav', 'container': 'wav'}], 'audio', 'Connect an audio sink'),
        ([{'key': 'wide', 'file': 'wide.mp4'}], 'video', 'Connect a video sink'),
    ],
)
def test_missing_deliverable_sink_fails_at_open(outputs, missing, message):
    """Every lane the normalized outputs will use must have a sink when the object opens."""
    spec = {'keep': [[0, 1000]], 'thumbnail': False, 'outputs': outputs}
    with pytest.raises(ValueError, match=message):
        node({'mode': 'render', 'spec': spec}, listeners=lambda lane: lane != missing)


def test_missing_manifest_consumer_fails_at_open():
    """Without a text or answers consumer nothing can carry the result manifest."""
    with pytest.raises(ValueError, match='text or answers consumer'):
        node({'mode': 'render', 'spec': SPEC}, listeners=lambda lane: lane in ('video', 'audio', 'image'))


def test_failed_open_leaves_nothing_to_clean():
    """An object refused at open() owns no scratch directory and closes quietly."""
    instance = node()
    instance.IGlobal.config['request'] = '[]'
    with pytest.raises(ValueError):
        instance.open(SimpleNamespace(name='next.mp4'))
    assert instance._workspace is None
    instance.closing()
    instance.close()


# ---- 4. portable paths and process output


def test_emitted_names_are_posix_even_where_paths_are_not(monkeypatch):
    """`files` and `artifacts[].name` agree, with forward slashes, whatever the host's Path does."""
    module = importlib.import_module(NODE + '._support.instance')
    instance = node({'mode': 'render', 'spec': SPEC})

    def render(workspace):
        target = workspace.root / 'outputs' / 'nested' / 'wide.mp4'
        target.parent.mkdir(parents=True)
        target.write_bytes(b'mp4')
        return {'files': {'wide': 'outputs/nested/wide.mp4'}}

    instance._render = render
    stream(instance, 'video', 'episode.mp4', b'episode')
    # a Windows host's Path renders a nested name with backslashes
    monkeypatch.setattr(module, 'Path', PureWindowsPath)
    instance.closing()
    answer = instance.instance.answers[-1]
    assert answer['files'] == {'wide': 'nested/wide.mp4'}
    assert [item['name'] for item in answer['artifacts']] == ['nested/wide.mp4']


def test_ffmpeg_output_is_decoded_as_utf8_with_replacement(monkeypatch):
    """FFmpeg's text is read as UTF-8 whatever the host's code page, never raising on a stray byte."""
    module = importlib.import_module(NODE + '._support.media')
    seen = {}

    def run(cmd, **kwargs):
        seen.update(kwargs)
        return subprocess.CompletedProcess(cmd, 0, stdout='', stderr='')

    monkeypatch.setattr(module.subprocess, 'run', run)
    monkeypatch.setattr(module, 'ffmpeg_exe', lambda: 'ffmpeg')
    module.run_ffmpeg(['-version'])
    assert seen['encoding'] == 'utf-8' and seen['errors'] == 'replace'


# ---- 5. error text carries no scratch path


def test_ffmpeg_failure_message_names_no_scratch_path(monkeypatch):
    """The message a user sees keeps the stderr tail but not the temp directory; the command stays on the error."""
    module = importlib.import_module(NODE + '._support.media')
    scratch = tempfile.gettempdir()
    resolved = str(Path(scratch).resolve())
    source = os.path.join(resolved, 'rocketride-media-abc', 'source.mp4')

    def run(cmd, **kwargs):
        raise subprocess.CalledProcessError(1, cmd, output='', stderr=f'{source}: No such file or directory\n')

    monkeypatch.setattr(module.subprocess, 'run', run)
    monkeypatch.setattr(module, 'ffmpeg_exe', lambda: 'ffmpeg')
    with pytest.raises(RuntimeError) as caught:
        module.run_ffmpeg(['-i', source, 'out.mp4'])
    message = str(caught.value)
    assert message.startswith('ffmpeg failed (1): ')
    assert 'No such file or directory' in message
    assert scratch not in message and resolved not in message and '<scratch>' in message
    assert caught.value.command[:3] == ['ffmpeg', '-hide_banner', '-nostdin'] and source in caught.value.command


def test_ffmpeg_timeout_message_names_no_command(monkeypatch):
    """A timeout reports the bound and keeps the command off the message too."""
    module = importlib.import_module(NODE + '._support.media')
    monkeypatch.setenv('ROCKETRIDE_MEDIA_FFMPEG_TIMEOUT', '7')
    monkeypatch.setattr(module, 'ffmpeg_exe', lambda: 'ffmpeg')
    scratch = str(Path(tempfile.gettempdir()).resolve())

    def timeout(cmd, **kwargs):
        raise subprocess.TimeoutExpired(cmd, kwargs['timeout'])

    monkeypatch.setattr(module.subprocess, 'run', timeout)
    with pytest.raises(RuntimeError, match='timed out after 7') as caught:
        module.run_ffmpeg(['-i', os.path.join(scratch, 'x.mp4')])
    assert scratch not in str(caught.value)
    assert os.path.join(scratch, 'x.mp4') in caught.value.command


# ---- 6. a stream the producer never ended is settled before processing


def test_whole_stream_without_end_is_settled_before_processing():
    """BEGIN + every declared byte and no END renders: the base's END is delivered before closing() processes."""
    instance = node({'mode': 'render', 'spec': SPEC})
    # what the engine still exposes while closing() runs (currentEntry is cleared in close())
    instance.instance.currentObject = SimpleNamespace(objectFailed=False)
    seen = []
    instance._process = lambda request, mode, source: seen.append(source)
    deliver(instance, 'video', AVI_ACTION.BEGIN, descriptor('episode.mp4', 5))
    deliver(instance, 'video', AVI_ACTION.WRITE, b'12345')
    instance.closing()
    assert seen == ['episode.mp4']


def test_short_stream_without_end_still_fails():
    """A stream short of its declared bytes gets no synthesized END and fails the object."""
    instance = node({'mode': 'render', 'spec': SPEC})
    instance.instance.currentObject = SimpleNamespace(objectFailed=False)
    deliver(instance, 'video', AVI_ACTION.BEGIN, descriptor('episode.mp4', 5))
    deliver(instance, 'video', AVI_ACTION.WRITE, b'1234')
    with pytest.raises(ValueError, match='did not finish'):
        instance.closing()


# ---- 7. the node's defaults are the default profile


def test_defaults_match_the_default_profile():
    """DEFAULTS is the `default` profile block of services.json, key for key."""
    services = json.loads((Path(media_render.__file__).parent / 'services.json').read_text(encoding='utf-8'))
    profile = dict(services['preconfig']['profiles']['default'])
    profile.pop('title')
    assert DEFAULTS == profile
