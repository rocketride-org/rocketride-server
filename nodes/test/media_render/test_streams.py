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

"""Stream lifecycle, isolation and real FFmpeg regressions without account storage."""

import ast
import builtins
import importlib
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from rocketlib import AVI_ACTION, APERR, Ec, OPEN_MODE

from media_render import IInstance
from media_render.IGlobal import DEFAULTS, IGlobal
from media_render._support.workspace import Workspace
from media_render._support.media import run_ffmpeg, probe

NODE = 'media_render'


class Output:
    """Capture typed outputs and verify declared stream lengths."""

    def __init__(self):
        self.answers = []
        self.texts = []
        self.files = {}
        self.active = {}

    def hasListener(self, lane):
        """Expose all output lanes to the processor under test."""
        return True

    def writeAnswers(self, answer):
        """Capture the JSON answer delivered by the node."""
        self.answers.append(answer.getJson())

    def writeText(self, text):
        """Capture each text-lane write in order."""
        self.texts.append(text)

    def media(self, lane, action, mime, data):
        """Collect one typed media stream and verify its final byte count."""
        if action == AVI_ACTION.BEGIN:
            descriptor = json.loads(bytes(data))
            self.active[lane] = descriptor
            self.files[descriptor['name']] = bytearray()
        elif action == AVI_ACTION.WRITE:
            self.files[self.active[lane]['name']].extend(data)
        else:
            descriptor = self.active.pop(lane)
            assert len(self.files[descriptor['name']]) == descriptor['size']

    def writeVideo(self, *args):
        """Capture video lane actions."""
        self.media('video', *args)

    def writeAudio(self, *args):
        """Capture audio lane actions."""
        self.media('audio', *args)

    def writeImage(self, *args):
        """Capture image lane actions."""
        self.media('image', *args)


def node(request=None, config=None):
    """Create an isolated node instance with a JSON request."""
    instance = IInstance()
    instance.IGlobal = SimpleNamespace(
        config={**DEFAULTS, 'chunk_bytes': 65536, 'request': json.dumps(request or {}), **(config or {})}
    )
    instance.instance = Output()
    instance.open(SimpleNamespace(name='source.mp4'))
    return instance


def deliver(instance, lane, action, data=b''):
    """Deliver one lane action while handling the engine consumption signal."""
    try:
        getattr(instance, 'write' + lane.title())(action, 'video/mp4' if lane == 'video' else 'audio/wav', data)
    except APERR as exc:
        if exc.ec != Ec.PreventDefault:
            raise


def feed(instance, path, name=None, lane='video'):
    """Send a local fixture with an exact length descriptor in uneven chunks."""
    deliver(
        instance, lane, AVI_ACTION.BEGIN, json.dumps({'name': name or path.name, 'size': path.stat().st_size}).encode()
    )
    with path.open('rb') as stream:
        while chunk := stream.read(7919):
            deliver(instance, lane, AVI_ACTION.WRITE, chunk)
    deliver(instance, lane, AVI_ACTION.END)


@pytest.fixture(scope='module')
def media(tmp_path_factory):
    """Generate a short audiovisual fixture using real FFmpeg."""
    path = tmp_path_factory.mktemp(NODE) / 'source.mp4'
    run_ffmpeg(
        [
            '-f',
            'lavfi',
            '-i',
            'testsrc2=size=320x180:rate=24',
            '-f',
            'lavfi',
            '-i',
            'sine=frequency=440:sample_rate=48000',
            '-t',
            '2',
            '-c:v',
            'libx264',
            '-pix_fmt',
            'yuv420p',
            '-c:a',
            'aac',
            '-y',
            str(path),
        ]
    )
    return path


@pytest.fixture(autouse=True)
def forbid_account_storage(monkeypatch):
    """Fail if custom processing imports account-storage or former shared helpers."""
    original = builtins.__import__

    def guarded(name, *args, **kwargs):
        """Guarded."""
        if name.startswith('ai.account') or name.startswith('ai.common.media'):
            raise AssertionError('Custom media node attempted account/shared-media access')
        return original(name, *args, **kwargs)

    monkeypatch.setattr(builtins, '__import__', guarded)


def test_no_storage_or_cross_node_dependency():
    """Verify no storage or cross node dependency."""
    package = Path(importlib.import_module(NODE).__file__).parent
    for path in package.rglob('*.py'):
        text = path.read_text(encoding='utf-8')
        assert 'ai.account' not in text and 'engine_file_store' not in text and 'ai.common.media' not in text
        other_nodes = {'media_inspect', 'media_speech', 'media_render'} - {NODE}
        for statement in ast.walk(ast.parse(text, filename=str(path))):
            imports = []
            if isinstance(statement, ast.Import):
                imports = [alias.name for alias in statement.names]
            elif isinstance(statement, ast.ImportFrom) and statement.level == 0:
                imports = [statement.module or '']
                if statement.module == 'nodes':
                    imports.extend(alias.name for alias in statement.names)
            for name in imports:
                assert not other_nodes.intersection(name.split('.')), (path, name)


@pytest.mark.parametrize('path', ['../x', '/x', 'x/../y', 'x//y', 'x\\y', 'https://a/b', './x', 'x\x00'])
def test_scratch_path_escape_is_rejected(path):
    """Verify scratch path escape is rejected."""
    workspace = Workspace()
    try:
        with pytest.raises(ValueError):
            workspace.resolve(path)
    finally:
        workspace.close()


def test_workspace_isolated_and_cleaned():
    """Verify workspace isolated and cleaned."""
    a, b = Workspace(), Workspace()
    paths = [a.root, b.root]
    try:
        a.resolve('same').write_bytes(b'a')
        b.resolve('same').write_bytes(b'b')
        assert a.resolve('same').read_bytes() != b.resolve('same').read_bytes()
    finally:
        a.close()
        b.close()
    assert all(not path.exists() for path in paths)


@pytest.mark.parametrize('action', [AVI_ACTION.WRITE, AVI_ACTION.END])
def test_requires_begin(action):
    """Verify requires begin."""
    instance = node()
    try:
        with pytest.raises(ValueError, match='without BEGIN'):
            deliver(instance, 'video', action, b'x')
    finally:
        instance.close()


@pytest.mark.parametrize('declared,actual', [(4, b'abc'), (2, b'abc'), (0, b'')])
def test_rejects_truncated_or_overrun_stream(declared, actual):
    """Verify rejects truncated or overrun stream."""
    instance = node()
    root = instance._workspace.root
    try:
        deliver(instance, 'video', AVI_ACTION.BEGIN, json.dumps({'name': 'x', 'size': declared}).encode())
        if len(actual) > declared:
            with pytest.raises(ValueError, match='exceeded'):
                deliver(instance, 'video', AVI_ACTION.WRITE, actual)
        else:
            deliver(instance, 'video', AVI_ACTION.WRITE, actual)
            with pytest.raises(ValueError, match='Empty or truncated'):
                deliver(instance, 'video', AVI_ACTION.END)
    finally:
        instance.close()
    assert not root.exists()


def test_unfinished_stream_cleans_on_closing():
    """Verify unfinished stream cleans on closing."""
    instance = node()
    root = instance._workspace.root
    deliver(instance, 'video', AVI_ACTION.BEGIN, b'{"size": 10, "name": "x"}')
    with pytest.raises(ValueError, match='did not finish'):
        instance.closing()
    assert not root.exists()


def test_reopen_cleans_previous_object():
    """Verify reopen cleans previous object."""
    instance = node()
    old = instance._workspace.root
    deliver(instance, 'video', AVI_ACTION.BEGIN, b'{"size": 10, "name": "x"}')
    instance.open(SimpleNamespace(name='new.mp4'))
    try:
        assert not old.exists()
        assert not instance._inputs and not instance._active
    finally:
        instance.close()


@pytest.mark.parametrize('name', ['../x', '/x', 'outputs/x', 'x\\y'])
def test_descriptor_cannot_escape_or_overwrite_outputs(name):
    """Verify descriptor cannot escape or overwrite outputs."""
    instance = node()
    try:
        with pytest.raises(ValueError):
            deliver(instance, 'video', AVI_ACTION.BEGIN, json.dumps({'name': name, 'size': 3}).encode())
    finally:
        instance.close()


def test_duplicate_stream_names_rejected(media):
    """Verify duplicate stream names rejected."""
    instance = node()
    try:
        feed(instance, media)
        with pytest.raises(ValueError, match='Duplicate'):
            feed(instance, media)
    finally:
        instance.close()


@pytest.mark.parametrize('invalid_request', [{'write_to': 'saved/result'}, {'mode': 'layout'}, []])
def test_invalid_request_fails_and_cleans(media, invalid_request):
    """Verify invalid request fails and cleans."""
    instance = node()
    instance.IGlobal.config['request'] = json.dumps(invalid_request)
    root = instance._workspace.root
    feed(instance, media)
    with pytest.raises(ValueError):
        instance.closing()
    assert not root.exists()


def test_editor_validation_has_no_dependency_side_effects(monkeypatch):
    """Verify editor validation has no dependency side effects."""
    import depends

    monkeypatch.setattr(depends, 'load_depends', lambda *_: pytest.fail('Dependencies loaded in CONFIG mode'))
    state = IGlobal()
    state.IEndpoint = SimpleNamespace(endpoint=SimpleNamespace(openMode=OPEN_MODE.CONFIG))
    state.beginGlobal()
    assert not hasattr(state, 'store')


def test_dependency_errors_propagate(monkeypatch):
    """Verify dependency errors propagate."""
    import depends

    def fail(*_):
        """Fail."""
        raise RuntimeError('dependency unavailable')

    monkeypatch.setattr(depends, 'load_depends', fail)
    state = IGlobal()
    state.IEndpoint = SimpleNamespace(endpoint=SimpleNamespace(openMode=None))
    with pytest.raises(RuntimeError, match='dependency unavailable'):
        state.beginGlobal()


def test_operation_outputs(media, tmp_path, monkeypatch):
    """Verify operation outputs."""
    if NODE == 'media_inspect':
        for request in (
            {'mode': 'probe'},
            {'mode': 'levels', 'scan_scenes': 'no'},
            {
                'mode': 'stills',
                'stills': [{'id': 'poster', 't_ms': 500, 'width': 160}, {'id': '../invalid', 't_ms': 500}],
            },
        ):
            instance = node(request)
            feed(instance, media)
            instance.closing()
            answer = instance.instance.answers[-1]
            assert answer['mode'] == request['mode']
            if request['mode'] == 'probe':
                assert answer['width'] == 320 and 1900 <= answer['duration_ms'] <= 2100
            if request['mode'] == 'stills':
                assert answer['streamed'] == ['poster'] and answer['failed'] == ['../invalid']
                assert instance.instance.files['poster.jpg'][:2] == b'\xff\xd8'
    elif NODE == 'media_speech':
        instance = node({'mode': 'pieces', 'piece_seconds': '1', 'max_pieces': '2'})
        feed(instance, media)
        instance.closing()
        assert len(instance.instance.files) == 2
        for i, data in enumerate(instance.instance.files.values()):
            path = tmp_path / f'{i}.wav'
            path.write_bytes(data)
            assert probe(path)['has_audio']
        module = importlib.import_module(NODE + '.IInstance')

        def align(path, *args, **kwargs):
            """Align."""
            info = probe(Path(path))
            assert info['audio_sample_rate'] == 16000
            return {
                'words': [{'word': 'hello', 'start_ms': 0, 'end_ms': 200, 'probability': 1}],
                'text': 'hello',
                'language': 'en',
            }

        monkeypatch.setattr(module, 'align_words', align)
        instance = node({'mode': 'words', 'range': '500-1500'})
        feed(instance, media)
        instance.closing()
        assert instance.instance.answers[-1]['words'][0]['s'] == 500
    else:
        spec = {
            'schema_version': 1,
            'kind': 'media_render_spec',
            'mode': 'preview',
            'source': media.name,
            'media': {
                'width': 320,
                'height': 180,
                'fps': 24,
                'duration_ms': 2000,
                'has_video': True,
                'has_audio': True,
            },
            'keep': [[0, 1800]],
            'audio': {'master': False},
            'captions': False,
            'thumbnail': False,
            'outputs': [{'key': 'original', 'file': 'result.mp4', 'aspect': '16:9', 'width': 320, 'height': 180}],
        }
        instance = node({'mode': 'render', 'spec': spec})
        feed(instance, media)
        instance.closing()
        answer = instance.instance.answers[-1]
        assert answer['storage'] == 'downstream'
        assert all(not name.startswith('outputs/') for name in answer['files'].values())
        videos = [data for name, data in instance.instance.files.items() if name.endswith('.mp4')]
        assert len(videos) == 1
        path = tmp_path / 'render.mp4'
        path.write_bytes(videos[0])
        info = probe(path)
        assert info['has_video'] and info['has_audio'] and 1600 <= info['duration_ms'] <= 2000


def test_multiple_named_assets_and_sidecars(media, tmp_path):
    """Verify multiple named assets and sidecars."""
    logo = tmp_path / 'logo.png'
    music = tmp_path / 'music.wav'
    run_ffmpeg(['-f', 'lavfi', '-i', 'color=red:s=32x32', '-frames:v', '1', '-y', str(logo)])
    run_ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000', '-t', '2', '-y', str(music)])
    spec = {
        'kind': 'media_render_spec',
        'mode': 'export',
        'source': media.name,
        'keep': [[0, 800], [1100, 1800]],
        'thumbnail': False,
        'media': {'width': 320, 'height': 180, 'has_video': True, 'has_audio': True},
        'music': {'source': music.name, 'gain_db': -24},
        'overlays': [{'image': logo.name, 'corner': 'tr', 'height': 0.15}],
        'audio': {'master': True, 'channels': 2},
        'outputs': [
            {'key': 'wide', 'file': 'wide.mp4', 'aspect': '16:9', 'width': 320, 'height': 180},
            {'key': 'audio', 'file': 'sound.wav', 'container': 'wav'},
        ],
        'subtitles': {'words': [{'w': 'Test', 's': 100, 'e': 500}], 'sidecars': True},
    }
    instance = node({'mode': 'render', 'spec': spec})
    root = instance._workspace.root
    # Assets can precede the main source, and retain independent lane state.
    feed(instance, logo, lane='image')
    feed(instance, music, lane='audio')
    feed(instance, media)
    instance.closing()
    answer = instance.instance.answers[-1]
    assert not root.exists()
    assert answer['music'] and not answer.get('error')
    assert len(instance.instance.files) >= 2
    sidecars = {item['name']: item for item in answer['artifacts'] if 'text' in item}
    assert any(name.endswith('.srt') and 'Test' in item['text'] for name, item in sidecars.items())
    assert any(name.endswith('.vtt') and item['text'].startswith('WEBVTT') for name, item in sidecars.items())


def test_missing_output_listener_is_an_error(media):
    """Verify missing output listener is an error."""
    spec = {
        'kind': 'media_render_spec',
        'keep': [[0, 1000]],
        'thumbnail': False,
        'outputs': [{'key': 'wide', 'file': 'output.mp4', 'aspect': '16:9', 'width': 320, 'height': 180}],
        'audio': {'master': False},
        'subtitles': {'enabled': False, 'sidecars': False},
    }
    instance = node({'mode': 'render', 'spec': spec})
    instance.instance.hasListener = lambda lane: lane != 'video'
    feed(instance, media)
    with pytest.raises(ValueError, match='Connect a video sink'):
        instance.closing()


def test_progress_failure_does_not_fail_processing(monkeypatch):
    """Verify progress failure does not fail processing."""
    module = importlib.import_module(NODE + '._support.instance')
    instance = node()
    instance.instance.pipeId = 'test'

    def fail(*args):
        """Fail."""
        raise RuntimeError('monitor disconnected')

    monkeypatch.setattr(module, 'monitorSSE', fail)
    try:
        instance._status(None, None, 'rendering')
    finally:
        instance.close()
