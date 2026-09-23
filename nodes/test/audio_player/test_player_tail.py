# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""The tail of a stream must survive both hand-offs audio_player makes (see #2066).

Two places used to drop real samples at end of stream:

1. onData() enqueued only full 16K chunks, so whatever was left in the
   accumulator at EOF (always something, unless the stream is an exact multiple
   of 16K) went into the None sentinel instead of the queue. A stream shorter
   than 16K played nothing at all.
2. _audio_callback() raised CallbackStop as soon as the remaining buffer was
   smaller than one callback block, cutting off up to a block (~24 ms) of audio.
   It must now play those frames and zero-pad the rest of the block.

player.py is loaded from source behind stubs (same harness as
audio_transcribe/test_stream_timestamps.py): no sounddevice/PortAudio, no
ffmpeg, no output device, no engine.
"""

from __future__ import annotations

import importlib.util
import os
import queue
import sys
import threading
import types

import numpy as np
import pytest

_HERE = os.path.dirname(os.path.abspath(__file__))
_NODE_DIR = os.path.join(_HERE, '..', '..', 'src', 'nodes', 'audio_player')


class _CallbackStop(Exception):
    """Stand-in for sounddevice.CallbackStop."""


def _load_player():
    """Load player.py behind stubs for sounddevice / AudioReader / IGlobal."""
    saved = {}
    pkg_name = '_audio_player_tail_pkg'

    class FakeAudioReader:
        """Records the AudioReader contract player.py relies on: nothing but
        construction and start()/stop() pass-throughs.
        """

        def __init__(self, **kwargs):
            self.kwargs = kwargs

        def start(self):
            pass

        def stop(self):
            pass

    pkg = types.ModuleType(pkg_name)
    pkg.__path__ = [_NODE_DIR]
    iglobal_stub = types.ModuleType(f'{pkg_name}.IGlobal')
    iglobal_stub.IGlobal = object

    sd_stub = types.ModuleType('sounddevice')
    sd_stub.CallbackStop = _CallbackStop
    sd_stub.OutputStream = object

    stubs = {
        pkg_name: pkg,
        f'{pkg_name}.IGlobal': iglobal_stub,
        'sounddevice': sd_stub,
        'ai': types.ModuleType('ai'),
        'ai.common': types.ModuleType('ai.common'),
        'ai.common.avi': types.ModuleType('ai.common.avi'),
        'ai.common.avi.audio': types.ModuleType('ai.common.avi.audio'),
    }
    stubs['ai.common.avi.audio'].AudioReader = FakeAudioReader

    for name, stub in stubs.items():
        saved[name] = sys.modules.get(name)
        sys.modules[name] = stub

    mod_name = f'{pkg_name}.player'
    try:
        spec = importlib.util.spec_from_file_location(mod_name, os.path.join(_NODE_DIR, 'player.py'))
        mod = importlib.util.module_from_spec(spec)
        sys.modules[mod_name] = mod
        spec.loader.exec_module(mod)
        return mod.Player
    finally:
        sys.modules.pop(mod_name, None)
        for name in stubs:
            if saved[name] is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = saved[name]


@pytest.fixture
def player():
    """A Player with its buffers initialized, but no audio stream opened."""
    Player = _load_player()
    node = Player(lock=threading.Lock())
    node._chunk_accumulator = bytearray()
    node._play_callback_buffer = bytearray()
    node._playback_finished = False
    return node


def _drain(play_queue):
    """Everything queued, in order — None sentinel included."""
    items = []
    while True:
        try:
            items.append(play_queue.get_nowait())
        except queue.Empty:
            return items


def _pcm(n_frames, channels=2, start=1):
    """n_frames of distinguishable int16 stereo PCM."""
    samples = np.arange(start, start + n_frames * channels, dtype=np.int16)
    return samples.tobytes()


def _outdata(frames, channels=2):
    """Nonzero output catches callback paths that fail to fill the buffer."""
    return np.full((frames, channels), 1234, dtype=np.int16)


# =============================================================================
# onData(): the accumulator must be flushed at EOF
# =============================================================================


def test_stream_shorter_than_one_chunk_is_still_queued(player):
    """A stream under 16K never filled a chunk, so it used to play nothing."""
    data = _pcm(100)
    player.onData(data)
    player.onData(None)

    assert _drain(player._play_queue) == [data, None]


def test_tail_after_a_full_chunk_is_queued(player):
    chunk = b'\x01\x02' * (player.MAX_CHUNK_SIZE // 2)
    tail = b'\x07\x08' * 64
    player.onData(chunk + tail)
    player.onData(None)

    assert _drain(player._play_queue) == [chunk, tail, None]


def test_exact_chunk_boundary_queues_no_empty_tail(player):
    """An exact multiple of 16K leaves an empty accumulator: no stray chunk."""
    chunk = b'\x01\x02' * (player.MAX_CHUNK_SIZE // 2)
    player.onData(chunk)
    player.onData(None)

    assert _drain(player._play_queue) == [chunk, None]


def test_tail_is_queued_before_the_sentinel(player):
    """Ordering is the contract: the callback stops at None, so a tail queued
    after it would never be played.
    """
    player.onData(b'\x01\x02' * 10)
    player.onData(None)

    items = _drain(player._play_queue)
    assert items[-1] is None
    assert None not in items[:-1]
    assert player._chunk_accumulator == bytearray()


# =============================================================================
# _audio_callback(): the final partial block must be played and zero-padded
# =============================================================================


def test_partial_final_block_is_played_and_zero_padded(player):
    """300 frames at EOF used to raise CallbackStop and vanish."""
    frames = 1024
    tail_frames = 300
    tail = _pcm(tail_frames)

    player._play_queue.put(tail)
    player._play_queue.put(None)

    outdata = _outdata(frames)
    with pytest.raises(_CallbackStop):
        player._audio_callback(outdata, frames, None, None)

    expected = np.frombuffer(tail, dtype=np.int16).reshape(tail_frames, player.CHANNELS)
    assert np.array_equal(outdata[:tail_frames], expected)
    assert np.array_equal(outdata[tail_frames:], np.zeros((frames - tail_frames, player.CHANNELS), dtype=np.int16))
    assert player._playback_finished is True
    assert len(player._play_callback_buffer) == 0


def test_padded_final_block_stops_in_the_same_callback(player):
    """The callback commits the padded final block while stopping playback."""
    frames = 1024
    player._play_queue.put(_pcm(300))
    player._play_queue.put(None)

    with pytest.raises(_CallbackStop):
        player._audio_callback(_outdata(frames), frames, None, None)


def test_already_finished_callback_zero_fills_before_stopping(player):
    """Even a defensive post-finish callback must not commit stale samples."""
    player._playback_finished = True
    outdata = _outdata(1024)

    with pytest.raises(_CallbackStop):
        player._audio_callback(outdata, 1024, None, None)

    assert np.count_nonzero(outdata) == 0


def test_eof_on_a_block_boundary_zero_fills_the_terminal_callback(player):
    """The callback that consumes the EOF sentinel must not replay stale data."""
    frames = 1024
    full_block = _pcm(frames)

    player._play_queue.put(full_block)
    player._play_queue.put(None)

    outdata = _outdata(frames)
    player._audio_callback(outdata, frames, None, None)

    expected = np.frombuffer(full_block, dtype=np.int16).reshape(frames, player.CHANNELS)
    assert np.array_equal(outdata, expected)

    terminal = _outdata(frames)
    with pytest.raises(_CallbackStop):
        player._audio_callback(terminal, frames, None, None)

    assert np.count_nonzero(terminal) == 0


def test_incomplete_pcm_frame_is_cleared_before_stopping(player):
    """Bytes that cannot form one stereo frame must not keep stop() waiting."""
    player._play_queue.put(b'\x01\x02')
    player._play_queue.put(None)

    outdata = _outdata(1024)
    with pytest.raises(_CallbackStop):
        player._audio_callback(outdata, 1024, None, None)

    assert player._play_callback_buffer == bytearray()
    assert np.count_nonzero(outdata) == 0


def test_full_blocks_before_the_tail_are_played_untouched(player):
    """End to end through both hand-offs: a stream of 1.5 callback blocks fed as
    raw PCM comes back out as one full block plus a padded tail block.
    """
    frames = 1024
    stream = _pcm(frames + 512)

    player.onData(stream)
    player.onData(None)

    first = _outdata(frames)
    player._audio_callback(first, frames, None, None)
    second = _outdata(frames)
    with pytest.raises(_CallbackStop):
        player._audio_callback(second, frames, None, None)

    played = np.concatenate([first, second]).tobytes()
    assert played[: len(stream)] == stream
    assert played[len(stream) :] == b'\x00' * (len(played) - len(stream))
