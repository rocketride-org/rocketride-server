# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Buffer timestamps audio_transcribe hands downstream must be stream-absolute.

Every Whisper buffer after the first used to be stamped 0: AudioReader's
getTimestamp() divided a counter nothing incremented, so documents-lane
consumers saw each 60s chunk restart at 0-60s. The reader-side fix lives in
packages/ai (see tests/ai/common/avi/test_audio_timestamp.py); this file
guards the node's half of the contract: Transcribe must capture the stream
position when a buffer STARTS and offset every segment it emits by it.

Same stub harness as test_decode_params.py: transcribe.py is loaded from
source behind stubs, the fake AudioReader reproduces the fixed getTimestamp()
semantics (position of the chunk being delivered), no server, no model.
"""

from __future__ import annotations

import importlib.util
import os
import sys
import types

_HERE = os.path.dirname(os.path.abspath(__file__))
_NODE_DIR = os.path.join(_HERE, '..', '..', 'src', 'nodes', 'audio_transcribe')

SAMPLE_RATE = 16000
ONE_SECOND = b'\x00\x01' * SAMPLE_RATE  # int16 mono


def _load_transcribe():
    """Load transcribe.py behind stubs (mirrors test_decode_params._load_transcribe)."""
    saved = {}
    pkg_name = '_audio_transcribe_ts_pkg'

    class FakeAudioReader:
        """Emulates the fixed AudioReader: getTimestamp() returns the stream
        position of the chunk currently being delivered to onData().
        """

        def __init__(self, **kwargs):
            self._bytes_fed = 0

        def start(self):
            self._bytes_fed = 0

        def getTimestamp(self):
            return self._bytes_fed / 2 / SAMPLE_RATE

        def feed(self, chunk: bytes):
            self.onData(chunk)
            self._bytes_fed += len(chunk)

    pkg = types.ModuleType(pkg_name)
    pkg.__path__ = [_NODE_DIR]
    iglobal_stub = types.ModuleType(f'{pkg_name}.IGlobal')
    iglobal_stub.IGlobal = object

    stubs = {
        pkg_name: pkg,
        f'{pkg_name}.IGlobal': iglobal_stub,
        'ai': types.ModuleType('ai'),
        'ai.common': types.ModuleType('ai.common'),
        'ai.common.avi': types.ModuleType('ai.common.avi'),
        'ai.common.avi.audio': types.ModuleType('ai.common.avi.audio'),
        'rocketlib': types.ModuleType('rocketlib'),
    }
    stubs['ai.common.avi.audio'].AudioReader = FakeAudioReader
    stubs['rocketlib'].debug = lambda *a, **kw: None

    for name, stub in stubs.items():
        saved[name] = sys.modules.get(name)
        sys.modules[name] = stub

    mod_name = f'{pkg_name}.transcribe'
    try:
        spec = importlib.util.spec_from_file_location(mod_name, os.path.join(_NODE_DIR, 'transcribe.py'))
        mod = importlib.util.module_from_spec(spec)
        sys.modules[mod_name] = mod
        spec.loader.exec_module(mod)
        return mod.Transcribe
    finally:
        sys.modules.pop(mod_name, None)
        for name in stubs:
            if saved[name] is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = saved[name]


def _make_node(chunk_duration=2):
    """Transcribe whose fake decoder emits one segment 0.5s into each buffer."""
    Transcribe = _load_transcribe()
    emitted = []

    node = Transcribe(
        segment_callback=emitted.extend,
        transcribe=lambda audio: [types.SimpleNamespace(text='Hello.', start=0.5, end=1.0)],
        chunk_duration=chunk_duration,
    )
    node.start()
    return node, emitted


def test_each_buffer_is_stamped_with_its_stream_position():
    node, emitted = _make_node(chunk_duration=2)

    for _ in range(4):  # two full 2s buffers
        node.feed(ONE_SECOND)

    assert [ts for ts, _ in emitted] == [0.5, 2.5]


def test_final_flush_keeps_the_absolute_position():
    node, emitted = _make_node(chunk_duration=2)

    for _ in range(5):
        node.feed(ONE_SECOND)
    node.onData(None)  # end of stream flushes the 1s remainder

    assert [ts for ts, _ in emitted] == [0.5, 2.5, 4.5]


def test_timestamp_is_captured_at_buffer_start_not_flush():
    """The base must come from the buffer's FIRST chunk; reading it at flush
    time would stamp the buffer with its end position.
    """
    node, emitted = _make_node(chunk_duration=3)

    for _ in range(3):
        node.feed(ONE_SECOND)

    assert emitted[0][0] == 0.5  # not 2.5 or 3.5
