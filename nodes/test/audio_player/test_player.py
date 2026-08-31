# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Unit tests for audio_player start/stop sentinel behavior.

sounddevice and AudioReader are stubbed so collection does not need PortAudio
or avi depends(). Usage: ./builder nodes:test --pytest-pattern=audio_player
"""

import contextlib
import importlib.util
import sys
import threading
import types
from pathlib import Path
from typing import Iterator
from unittest.mock import MagicMock, patch

import numpy as np
import pytest

_PKG = '_audio_player_direct'
_PKG_DIR = Path(__file__).parent.parent.parent / 'src' / 'nodes' / 'audio_player'
_STUB_NAMES = ('sounddevice', 'ai', 'ai.common', 'ai.common.avi', 'ai.common.avi.audio')


class _AudioReader:
    """Stand-in for ``ai.common.avi.audio.AudioReader`` (start/stop only)."""

    def __init__(self, **_kwargs):
        pass

    def start(self):
        pass

    def stop(self):
        pass


def _install_stubs() -> None:
    """Plant fake modules so player.py can import without PortAudio or avi deps."""
    sd = types.ModuleType('sounddevice')

    class CallbackStop(Exception):
        pass

    sd.CallbackStop = CallbackStop
    sd.OutputStream = MagicMock
    sd.query_devices = MagicMock(return_value=[])
    sys.modules['sounddevice'] = sd

    for name in ('ai', 'ai.common', 'ai.common.avi'):
        mod = types.ModuleType(name)
        mod.__path__ = []
        sys.modules[name] = mod

    audio = types.ModuleType('ai.common.avi.audio')
    audio.AudioReader = _AudioReader
    sys.modules['ai.common.avi.audio'] = audio


@contextlib.contextmanager
def _scoped_stubs() -> Iterator[None]:
    """Install stub modules for the block, restoring sys.modules on exit."""
    snapshot = {name: sys.modules.get(name) for name in _STUB_NAMES}
    _install_stubs()
    try:
        yield
    finally:
        for name, mod in snapshot.items():
            if mod is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = mod


def _load_player():
    """Load player.py as a package member so its relative IGlobal import resolves."""
    with _scoped_stubs():
        pkg = types.ModuleType(_PKG)
        pkg.__path__ = [str(_PKG_DIR)]
        sys.modules[_PKG] = pkg

        spec_g = importlib.util.spec_from_file_location(f'{_PKG}.IGlobal', _PKG_DIR / 'IGlobal.py')
        mod_g = importlib.util.module_from_spec(spec_g)
        sys.modules[f'{_PKG}.IGlobal'] = mod_g
        spec_g.loader.exec_module(mod_g)

        spec = importlib.util.spec_from_file_location(f'{_PKG}.player', _PKG_DIR / 'player.py')
        mod = importlib.util.module_from_spec(spec)
        sys.modules[f'{_PKG}.player'] = mod
        spec.loader.exec_module(mod)
        return mod


player_mod = _load_player()
Player = player_mod.Player


def _advancing_clock(start=0.0, step=None):
    """Return a monotonic() stand-in that advances on every call.

    Default step is past STOP_TIMEOUT so the wait loop trips regardless of
    how many monotonic() reads stop() makes.
    """
    if step is None:
        step = Player.STOP_TIMEOUT + 1.0
    now = start

    def _clock():
        nonlocal now
        current = now
        now += step
        return current

    return _clock


@pytest.fixture
def player_instance():
    return Player(lock=threading.Lock())


@patch.object(player_mod.sd, 'OutputStream')
@patch.object(player_mod.sd, 'query_devices')
def test_start_success(mock_query, mock_stream, player_instance):
    """Test start() succeeds if there is a valid output device."""
    mock_query.return_value = [{'max_output_channels': 2}]

    with patch.object(player_mod.AudioReader, 'start') as mock_super_start:
        player_instance.start()

    mock_query.assert_called_once()
    mock_stream.assert_called_once()
    mock_super_start.assert_called_once()


@patch.object(player_mod.sd, 'query_devices')
def test_start_no_hardware(mock_query, player_instance):
    """Test start() raises RuntimeError if no devices have max_output_channels > 0."""
    mock_query.return_value = [{'max_output_channels': 0}]

    with pytest.raises(RuntimeError, match='No audio output hardware detected'):
        player_instance.start()


@patch.object(player_mod.sd, 'query_devices')
def test_start_library_error(mock_query, player_instance):
    """Test start() raises generic library RuntimeError if query_devices() fails."""
    mock_query.side_effect = Exception('PortAudio broken')

    with pytest.raises(RuntimeError, match='library encountered an error checking for audio hardware'):
        player_instance.start()


def test_stop_normal(player_instance):
    """Test stop() normal behavior with no hangs."""
    stream = MagicMock()
    player_instance._stream = stream
    # Simulate normal playback finished state
    player_instance._playback_finished = True

    with patch.object(player_mod.AudioReader, 'stop') as mock_super_stop:
        player_instance.stop()

    mock_super_stop.assert_called_once()
    stream.stop.assert_called_once()
    stream.close.assert_called_once()
    stream.abort.assert_not_called()
    assert player_instance._stream is None


@patch.object(player_mod, 'warning')
@patch('time.sleep', return_value=None)
@patch('time.monotonic')
def test_stop_timeout(mock_monotonic, mock_sleep, mock_warning, player_instance):
    """Test stop() times out and aborts stream if callback hangs."""
    stream = MagicMock()
    player_instance._stream = stream
    # Simulate hang (playback finished never set)
    player_instance._playback_finished = False

    mock_monotonic.side_effect = _advancing_clock()

    with patch.object(player_mod.AudioReader, 'stop'):
        player_instance.stop()

    stream.abort.assert_called_once()
    stream.close.assert_called_once()
    stream.stop.assert_not_called()
    mock_warning.assert_called_once()
    assert player_instance._stream is None


@patch.object(player_mod.sd, 'OutputStream')
@patch.object(player_mod.sd, 'query_devices')
@patch.object(player_mod, 'warning')
@patch('time.sleep', return_value=None)
@patch('time.monotonic')
def test_start_after_stop_timeout_plays_audio(
    mock_monotonic, mock_sleep, mock_warning, mock_query, mock_stream, player_instance
):
    """A timed-out stop() must not leave a stale sentinel that mutes the next stream."""
    stream = MagicMock()
    player_instance._stream = stream
    player_instance._playback_finished = False
    mock_monotonic.side_effect = _advancing_clock()

    with patch.object(player_mod.AudioReader, 'stop'):
        player_instance.stop()

    stream.abort.assert_called_once()
    mock_query.return_value = [{'max_output_channels': 2}]
    with patch.object(player_mod.AudioReader, 'start'):
        player_instance.start()

    frames = 1024
    required_bytes = frames * player_instance.CHANNELS * 2
    player_instance._play_queue.put(bytes(required_bytes * 2))

    outdata = np.zeros((frames, player_instance.CHANNELS), dtype=np.int16)
    player_instance._audio_callback(outdata, frames, None, None)

    assert player_instance._playback_finished is False
    assert player_instance._play_queue.empty()
    assert len(player_instance._play_callback_buffer) == required_bytes
