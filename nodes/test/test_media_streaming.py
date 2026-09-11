"""Media flows as it is produced: producers emit chunks, response spools them.
Three sides of one behaviour — audio_tts, video_composer, response.
"""

import base64
import os
import re
import subprocess
import sys

import numpy as np
import pytest
from rocketlib import AVI_ACTION

from ai.account import live_media
from nodes.audio_tts.IGlobal import MP3_MIME, IGlobal as TtsGlobal
from nodes.audio_tts.IInstance import IInstance as TtsNode
from nodes.response.IInstance import IInstance as ResponseNode
from nodes.video_composer.IInstance import IInstance as ComposerNode

CLIENT = 'user-1'


@pytest.fixture(autouse=True)
def spool_dir(tmp_path, monkeypatch):
    monkeypatch.setenv('ROCKETRIDE_LIVE_MEDIA_DIR', str(tmp_path))
    monkeypatch.setattr('ai.account.sfu.ensure_managed_sfu', lambda: None)  # no managed SFU boot in unit tests
    yield tmp_path


class _Recorder:
    """Captures the AVI calls a node makes, and the SSE events it emits."""

    def __init__(self, obj=None):
        self.calls: list[tuple] = []
        self.sse: list[tuple[str, dict]] = []
        self.currentObject = obj

    def sendSSE(self, event, **data):
        self.sse.append((event, data))

    def _record(self, action, mime, data=b''):
        self.calls.append((action, mime, bytes(data)))

    writeAudio = writeVideo = _record

    def actions(self):
        return [action for action, _, _ in self.calls]

    def payload(self):
        return b''.join(data for action, _, data in self.calls if action == AVI_ACTION.WRITE)


# ===========================================================================
# response — announces on BEGIN, spools each WRITE, persists on END
# ===========================================================================


class _Store:
    """Records what the node persisted, chunk by chunk."""

    def __init__(self, fail: bool = False):
        self.fail = fail
        self.written: dict[str, bytearray] = {}
        self._open: dict[str, str] = {}

    async def open_write(self, path):
        self.written[path] = bytearray()
        self._open['h'] = path
        return 'h'

    async def write_chunk(self, handle, data):
        if self.fail:
            raise RuntimeError('store is down')
        self.written[self._open[handle]] += data
        return len(data)

    async def close_write(self, handle):
        self._open.pop(handle, None)


class _ResponseGlobal:
    laneName = None
    lanes = None
    client_id = CLIENT

    def __init__(self, store=None, transmit=True):
        self.file_store = store
        self.transmit_media = transmit


class _Entry:
    hasName = True
    name = 'clip.mp4'
    hasMetadata = False
    hasPath = False

    def __init__(self):
        self.response = {}


def _response(store=None, transmit=True) -> ResponseNode:
    node = ResponseNode.__new__(ResponseNode)
    node._media = {}
    node._media_descriptors = {}
    node.IGlobal = _ResponseGlobal(store, transmit)
    node.instance = _Recorder(_Entry())
    return node


def _stream(node, lane, mime, chunks):
    write = getattr(node, f'write{lane.capitalize()}')
    write(AVI_ACTION.BEGIN, mime, b'')
    for chunk in chunks:
        write(AVI_ACTION.WRITE, mime, chunk)
    write(AVI_ACTION.END, mime, b'')


def test_response_announces_on_begin_before_any_bytes_exist():
    node = _response(store=_Store())
    node.writeVideo(AVI_ACTION.BEGIN, 'video/mp4', b'')

    event, data = node.instance.sse[0]
    assert event == 'artifact_path'
    assert data['streaming'] is True
    assert data['path'].startswith('outputs/video/clip-')
    assert data['url'] is None and data['live'] is False, 'no SFU configured => no live url'

    part, _ = live_media.spool_paths(CLIENT, data['path'])
    assert os.path.getsize(part) == 0

    node.writeVideo(AVI_ACTION.END, 'video/mp4', b'')


def test_response_hands_a_whep_url_when_an_sfu_is_configured(monkeypatch):
    """With an SFU set, the announce carries a WHEP url and each write is pushed live."""
    monkeypatch.setenv('ROCKETRIDE_MEDIA_SFU', 'sfu.local')
    fed = []

    class _FakePublisher:
        def __init__(self, host, stream_id, mime, rtsp_host=None):
            self.whep_url = f'http://{host}:8889/{stream_id}/whep'
            self.failed = False

        def begin(self):
            return True

        def feed(self, data):
            fed.append(data)

        def finish(self):
            fed.append('finish')

    monkeypatch.setattr(sys.modules[ResponseNode.__module__], 'MediaPublisher', _FakePublisher)

    node = _response(store=_Store())
    _stream(node, 'video', 'video/mp4', [b'aa', b'bb'])

    data = next(d for e, d in node.instance.sse if e == 'artifact_path')
    assert data['live'] is True
    assert data['url'].startswith('http://sfu.local:8889/user1-') and data['url'].endswith('/whep')
    assert fed == [b'aa', b'bb', 'finish'], 'streamed live as it arrived, then closed'

    # observability: the push surfaces to the monitor as proof it went over WebRTC
    mp = next(d for e, d in node.instance.sse if e == 'media_publish')
    assert mp['transport'] == 'RTSP->WHEP'
    assert mp['whep_url'].endswith('/whep') and mp['sfu'] == 'sfu.local'


def test_media_delivered_as_a_file_when_no_sfu(monkeypatch):
    """With no SFU configured the video is NOT lost: it degrades to a normal whole-file
    artifact (announced non-live), and no live push is attempted.
    """
    monkeypatch.delenv('ROCKETRIDE_MEDIA_SFU', raising=False)  # off-by-default
    node = _response(store=_Store())
    _stream(node, 'video', 'video/mp4', [b'aa', b'bb'])

    data = next(d for e, d in node.instance.sse if e == 'artifact_path')
    assert data['live'] is False  # delivered, just not live-streamed
    assert not any(e == 'media_publish' for e, _ in node.instance.sse)  # no live push attempted


def test_stream_id_is_an_unguessable_capability():
    # The WHEP url is a bearer capability: url-safe, per-client prefixed, and unguessable, so
    # one client can't reach another's live stream by guessing the id.
    node = _response()
    sid = node._stream_id()
    assert re.fullmatch(r'user1-[0-9a-f]{32}', sid)  # tenant prefix (slug of 'user-1') + 128-bit token
    assert node._stream_id() != node._stream_id()  # fresh randomness each call
    assert ' ' not in sid and '/' not in sid


def test_response_spools_each_write_before_end():
    """Another process can read the bytes as they arrive, not at END."""
    node = _response(store=_Store())
    node.writeAudio(AVI_ACTION.BEGIN, 'audio/mpeg', b'')
    part, _ = live_media.spool_paths(CLIENT, node.instance.sse[0][1]['path'])

    node.writeAudio(AVI_ACTION.WRITE, 'audio/mpeg', b'aaa')
    assert os.path.getsize(part) == 3
    node.writeAudio(AVI_ACTION.WRITE, 'audio/mpeg', b'bb')
    assert os.path.getsize(part) == 5

    node.writeAudio(AVI_ACTION.END, 'audio/mpeg', b'')


def test_response_persists_the_spool_and_returns_a_path():
    store = _Store()
    node = _response(store=store)
    _stream(node, 'video', 'video/mp4', [b'chunk-1', b'chunk-2'])

    entry = node.instance.currentObject.response['video'][0]
    assert entry == {'mime_type': 'video/mp4', 'path': entry['path']}
    assert bytes(store.written[entry['path']]) == b'chunk-1chunk-2'
    assert not live_media.is_live(CLIENT, entry['path']), 'the spool is reclaimed once persisted'


@pytest.mark.parametrize('store', [None, _Store(fail=True)])
def test_response_falls_back_to_base64_without_a_working_store(store):
    node = _response(store=store)
    _stream(node, 'audio', 'audio/mpeg', [b'RIFF', b'rest'])

    entry = node.instance.currentObject.response['audio'][0]
    assert base64.b64decode(entry['audio']) == b'RIFFrest'
    assert 'path' not in entry


def test_response_transmit_media_off_persists_but_never_announces():
    store = _Store()
    node = _response(store=store, transmit=False)
    _stream(node, 'video', 'video/mp4', [b'data'])

    assert node.instance.sse == []
    entry = node.instance.currentObject.response['video'][0]
    assert bytes(store.written[entry['path']]) == b'data'


def test_response_keeps_concurrent_lanes_in_separate_spools():
    store = _Store()
    node = _response(store=store)
    node.writeAudio(AVI_ACTION.BEGIN, 'audio/mpeg', b'')
    node.writeVideo(AVI_ACTION.BEGIN, 'video/mp4', b'')
    node.writeAudio(AVI_ACTION.WRITE, 'audio/mpeg', b'AAA')
    node.writeVideo(AVI_ACTION.WRITE, 'video/mp4', b'VVVV')
    node.writeAudio(AVI_ACTION.END, 'audio/mpeg', b'')
    node.writeVideo(AVI_ACTION.END, 'video/mp4', b'')

    audio = node.instance.currentObject.response['audio'][0]
    video = node.instance.currentObject.response['video'][0]
    assert bytes(store.written[audio['path']]) == b'AAA'
    assert bytes(store.written[video['path']]) == b'VVVV'


# ===========================================================================
# audio_tts — MP3 frames as Kokoro produces them
# ===========================================================================


def _tone(samples: int) -> np.ndarray:
    """Audible float32 samples — silence encodes to almost nothing."""
    t = np.arange(samples, dtype=np.float32) / 24000.0
    return 0.5 * np.sin(2 * np.pi * 440.0 * t)


class _Kokoro:
    """Stands in for KPipeline: a generator of (gs, ps, audio)."""

    def __init__(self, chunks):
        self.chunks = chunks

    def __call__(self, text, voice=None, speed=1):
        for chunk in self.chunks:
            yield None, None, chunk


def _tts(chunks) -> TtsNode:
    # Scope the LAME requirement to the TTS tests only — at module level it skipped the whole
    # file, including the response-spool and video_composer tests that don't need the encoder.
    pytest.importorskip('lameenc', reason='audio_tts needs the LAME encoder to stream MP3')
    glob = TtsGlobal.__new__(TtsGlobal)
    glob._pipeline = _Kokoro(chunks)
    glob._remote_client = None
    glob._voice = 'af_heart'

    node = TtsNode.__new__(TtsNode)
    node.IGlobal = glob
    node.instance = _Recorder()
    return node


def test_tts_emits_each_model_chunk_as_it_is_produced():
    """Many WRITEs, not one with the whole utterance."""
    node = _tts([_tone(24000)] * 3)
    node.writeText('hello')

    actions = node.instance.actions()
    assert actions[0] == AVI_ACTION.BEGIN
    assert actions[-1] == AVI_ACTION.END
    assert actions.count(AVI_ACTION.WRITE) > 1, 'audio must flow while it is synthesised'


def test_tts_emits_begin_before_the_model_runs():
    """A consumer opens the artifact before a single sample exists."""
    calls_at_first_run = []

    class _Watching(_Kokoro):
        def __call__(self, text, voice=None, speed=1):
            calls_at_first_run.append(len(node.instance.calls))
            return super().__call__(text, voice, speed)

    node = _tts([])
    node.IGlobal._pipeline = _Watching([_tone(2400)])
    node.writeText('hi')

    assert calls_at_first_run == [1]
    assert node.instance.calls[0][0] == AVI_ACTION.BEGIN


def test_tts_streams_mp3_not_wav():
    node = _tts([_tone(24000)])
    node.writeText('hello')

    assert all(mime == MP3_MIME for _, mime, _ in node.instance.calls)
    stream = node.instance.payload()
    # MP3 frame sync is eleven set bits; the encoder may lead with an ID3 tag.
    assert stream.startswith(b'ID3') or (stream[0] == 0xFF and stream[1] & 0xE0 == 0xE0)
    assert not stream.startswith(b'RIFF')


def test_tts_emits_end_even_when_synthesis_fails():
    """A failed utterance must not leave the downstream stream open forever."""

    class _Broken:
        def __call__(self, text, voice=None, speed=1):
            raise RuntimeError('model exploded')
            yield  # pragma: no cover

    node = _tts([])
    node.IGlobal._pipeline = _Broken()

    with pytest.raises(RuntimeError, match='model exploded'):
        node.writeText('hello')

    assert node.instance.actions() == [AVI_ACTION.BEGIN, AVI_ACTION.END]


# ===========================================================================
# video_composer — fragments as ffmpeg produces them
# ===========================================================================


class _FakeStdin:
    def __init__(self, broken=False):
        self.written = []
        self.closed = False
        self.broken = broken

    def write(self, data):
        if self.broken:
            raise BrokenPipeError('encoder gone')
        self.written.append(bytes(data))

    def flush(self):
        pass

    def close(self):
        self.closed = True


class _EmptyPipe:
    def read(self, *args):
        return b''


class _FakeFfmpeg:
    """Stands in for ffmpeg. Output is pushed by the test, not by a real encoder."""

    def __init__(self, broken_stdin=False):
        self.stdin = _FakeStdin(broken_stdin)
        self.stdout = _EmptyPipe()
        self.stderr = _EmptyPipe()
        self.returncode = 0
        self.killed = False

    def poll(self):
        return self.returncode

    def wait(self, timeout=None):
        return self.returncode

    def kill(self):
        self.killed = True

    # imageio_ffmpeg also reaches for subprocess.Popen, as a context manager.
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def communicate(self, *args, **kwargs):
        return b'', b''


class _ComposerGlobal:
    config = {'fps': 1.0, 'crf': 23, 'codec': 'libx264'}


def _composer(proc=None) -> ComposerNode:
    node = ComposerNode.__new__(ComposerNode)
    node.IGlobal = _ComposerGlobal()
    node.instance = _Recorder(_Entry())
    node.beginInstance()
    node.open(_Entry())
    if proc is not None:
        node._proc = proc
        node._start_encode = lambda: True
    return node


def _frame(node, data: bytes):
    node.writeImage(AVI_ACTION.BEGIN, 'image/png', b'')
    node.writeImage(AVI_ACTION.WRITE, 'image/png', data)
    node.writeImage(AVI_ACTION.END, 'image/png', b'')


def test_composer_starts_the_encoder_on_the_first_frame_not_at_close(monkeypatch):
    proc = _FakeFfmpeg()
    node = _composer()
    monkeypatch.setattr(node, '_start_encode', lambda: bool(setattr(node, '_proc', proc)) or True)

    assert node._proc is None
    _frame(node, b'PNG-1')
    assert proc.stdin.written == [b'PNG-1'], 'ffmpeg runs before the second frame arrives'


def test_composer_pipes_each_frame_through_without_accumulating():
    proc = _FakeFfmpeg()
    node = _composer(proc)

    for data in (b'f1', b'f2', b'f3'):
        _frame(node, data)

    assert proc.stdin.written == [b'f1', b'f2', b'f3']
    assert not hasattr(node, '_frames'), 'the frame set must not be held in memory'


def test_composer_forwards_fragments_as_the_encoder_produces_them():
    proc = _FakeFfmpeg()
    node = _composer(proc)

    node._stdout_queue.put(b'moof-1')
    _frame(node, b'f1')
    assert node.instance.actions() == [AVI_ACTION.BEGIN, AVI_ACTION.WRITE]

    node._stdout_queue.put(b'moof-2')
    _frame(node, b'f2')
    assert node.instance.payload() == b'moof-1moof-2'
    assert node.instance.actions().count(AVI_ACTION.BEGIN) == 1, 'the stream opens once'


def test_composer_defers_begin_until_the_first_fragment_exists():
    """No bytes, no stream: an encode that produces nothing opens nothing."""
    node = _composer(_FakeFfmpeg())
    _frame(node, b'f1')
    assert node.instance.calls == []


def test_composer_close_drains_the_tail_and_ends_the_stream():
    proc = _FakeFfmpeg()
    node = _composer(proc)
    node._stdout_queue.put(b'moof')
    _frame(node, b'f1')

    node._stdout_queue.put(b'mdat-tail')
    node.close()

    assert proc.stdin.closed, 'the encoder must be told there are no more frames'
    assert node.instance.payload() == b'moofmdat-tail'
    assert node.instance.actions()[-1] == AVI_ACTION.END


def test_composer_a_broken_encoder_ends_the_stream_instead_of_raising():
    proc = _FakeFfmpeg(broken_stdin=True)
    node = _composer(proc)
    node._stdout_queue.put(b'moof')
    _frame(node, b'f1')

    assert proc.stdin.closed
    node.close()
    assert node.instance.actions()[-1] == AVI_ACTION.END


def test_composer_close_kills_an_encoder_that_will_not_exit(monkeypatch):
    proc = _FakeFfmpeg()
    node = _composer(proc)
    node._stdout_queue.put(b'moof')
    _frame(node, b'f1')

    def _hang(timeout=None):
        # A real wait() blocks until the timeout, then raises; after kill() it returns.
        if timeout is not None and not proc.killed:
            raise subprocess.TimeoutExpired('ffmpeg', timeout)
        return -9

    monkeypatch.setattr(proc, 'wait', _hang)
    node.close()

    assert proc.killed
    assert node.instance.actions()[-1] == AVI_ACTION.END


def test_composer_emits_mse_compatible_fragments(monkeypatch):
    """Without default_base_moof, ffmpeg writes a tfhd base-data-offset.
    MediaSource rejects that outright, so the video never plays in a browser.
    """
    captured = {}

    def _popen(cmd, **kwargs):
        captured['cmd'] = cmd
        return _FakeFfmpeg()

    monkeypatch.setattr(subprocess, 'Popen', _popen)
    node = _composer()
    assert node._start_encode()

    movflags = captured['cmd'][captured['cmd'].index('-movflags') + 1]
    assert 'default_base_moof' in movflags, 'MSE requires movie-fragment-relative addressing'
    assert 'empty_moov' in movflags and 'frag_keyframe' in movflags
