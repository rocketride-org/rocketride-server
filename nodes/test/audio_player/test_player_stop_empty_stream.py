# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""Regression test for issue #2027: Player.stop() hung forever when a stream
carried no data. Its drain loop waits on _playback_finished, which only the
sounddevice hardware callback thread ever sets (after dequeuing the None
sentinel onData enqueues) - and onData is never called at all if write() was
never called (see reader.py: with no cache and no stdin data, _start_decoder
never runs, so the ffmpeg data thread that would call onData never exists).

Reachable in a real pipeline: EmbeddedContentExtractor.java sends BEGIN,
loops zero times when stream.read() returns -1 on the first call (a
zero-byte embedded or standalone audio/video stream), then sends END
unconditionally.
"""

from __future__ import annotations

import sys
import threading
import types
from pathlib import Path

import numpy as np
import pytest

_NODE_DIR = Path(__file__).resolve().parent.parent.parent / 'src' / 'nodes' / 'audio_player'
_AI_SRC = Path(__file__).resolve().parent.parent.parent.parent / 'packages' / 'ai' / 'src'

# Names this file's stubbing installs into sys.modules. A prior test (or a
# real install) leaving one of these cached would let player.py bind a real
# sounddevice, a real OutputStream, or reuse a stale audio_player submodule.
_MANAGED_PREFIXES = ('sounddevice', 'audio_player')


def _is_managed(name):
    return name in _MANAGED_PREFIXES or any(name.startswith(p + '.') for p in _MANAGED_PREFIXES)


@pytest.fixture(autouse=True)
def _isolated_sys_modules(monkeypatch):
    """
    Snapshot sys.modules entries this file's stubbing touches (including
    their absence), evict them, run the test against a clean slate, then
    restore exactly what was there before - so a fake installed here can
    never leak into, or be masked by a leftover from, whatever runs next.
    Also prepends _AI_SRC via monkeypatch, which reverts sys.path on
    teardown the same way - otherwise the path entry would survive the test
    and a later test could resolve rocketlib only because this one ran first.
    """
    monkeypatch.syspath_prepend(str(_AI_SRC))
    saved = {name: mod for name, mod in sys.modules.items() if _is_managed(name)}
    for name in saved:
        del sys.modules[name]
    try:
        yield
    finally:
        for name in [n for n in sys.modules if _is_managed(n)]:
            del sys.modules[name]
        sys.modules.update(saved)


def _install_stubs():
    """Fake only the hardware dep Player needs at import time (real PortAudio
    hardware isn't available here); Player and AVIReader run unmodified.
    Always installs fresh - never reuses whatever sys.modules already has.
    sys.path is handled by the _isolated_sys_modules fixture, not here.
    """
    sd = types.ModuleType('sounddevice')
    # Recorded so tests can assert teardown actually ran, not just that it
    # didn't hang - a no-op fake can't otherwise be observed either way.
    sd.stream_calls = []

    class _FakeOutputStream:
        def __init__(self, **kwargs):
            pass

        def start(self):
            pass

        def stop(self):
            sd.stream_calls.append('stop')

        def close(self):
            sd.stream_calls.append('close')

    class _CallbackStop(Exception):
        pass

    sd.OutputStream = _FakeOutputStream
    sd.CallbackStop = _CallbackStop
    sys.modules['sounddevice'] = sd

    for name in [n for n in sys.modules if n == 'audio_player' or n.startswith('audio_player.')]:
        del sys.modules[name]

    pkg = types.ModuleType('audio_player')
    pkg.__path__ = [str(_NODE_DIR)]
    sys.modules['audio_player'] = pkg


def _new_player():
    _install_stubs()
    from audio_player.player import Player

    return Player(lock=threading.Lock())


def test_begin_end_with_no_write_returns_promptly():
    """
    Pre-fix, this hangs forever: END with no prior WRITE means onData is
    never called (not even with None), _playback_finished never flips, and
    stop()'s drain loop spins on time.sleep(0.1) forever. Bounded thread with
    a join timeout so a regression shows up as a failing assertion, never as
    a hung suite.
    """
    from rocketlib import AVI_ACTION

    player = _new_player()
    results = []
    errors = []

    def _drive():
        try:
            player.writeAVI(AVI_ACTION.BEGIN, 'audio/wav', b'')
            player.writeAVI(AVI_ACTION.END, 'audio/wav', b'')
            results.append('completed')
        except Exception as e:  # noqa: BLE001 - capturing whatever stop() raises, if anything
            errors.append(e)

    t = threading.Thread(target=_drive, daemon=True)
    t.start()
    t.join(timeout=5)

    assert not t.is_alive(), (
        'BEGIN then END with no WRITE did not return within 5s - issue #2027 '
        '(nothing can ever set _playback_finished when no data was written), '
        'not a slow test'
    )
    assert results == ['completed'], f'expected a clean stop, got results={results} errors={errors}'
    # The drain is skipped on this path (that's the fix), but teardown must
    # still run - this is the assertion that actually proves it did.
    assert sys.modules['sounddevice'].stream_calls == ['stop', 'close']


def test_repeated_end_after_empty_stream_is_safe():
    """
    A stray duplicate END (no new BEGIN/WRITE in between) must stay a no-op,
    not hang or raise - writeAVI's END branch always calls stop()
    unconditionally, so this exercises the empty-stream skip running twice
    in a row.
    """
    from rocketlib import AVI_ACTION

    player = _new_player()
    results = []
    errors = []

    def _drive():
        try:
            player.writeAVI(AVI_ACTION.BEGIN, 'audio/wav', b'')
            player.writeAVI(AVI_ACTION.END, 'audio/wav', b'')
            player.writeAVI(AVI_ACTION.END, 'audio/wav', b'')  # stray duplicate END
            results.append('completed')
        except Exception as e:  # noqa: BLE001
            errors.append(e)

    t = threading.Thread(target=_drive, daemon=True)
    t.start()
    t.join(timeout=5)

    assert not t.is_alive(), 'a duplicate END after an empty stream must not hang'
    assert results == ['completed'], f'results={results} errors={errors}'


def test_begin_write_end_still_drains_normally():
    """
    The fix must only skip the wait when nothing was ever written - real
    queued audio must still drain exactly as before. _start_decoder is
    stubbed at the instance level (a real ffmpeg subprocess isn't needed to
    prove Player's own queue/flag bookkeeping) and the sounddevice hardware
    callback thread is simulated manually, since our fake OutputStream never
    calls it on its own.
    """
    from rocketlib import AVI_ACTION

    class _FakeProcess:
        def wait(self, timeout=None):
            return 0

    player = _new_player()
    # Reference whatever this test actually installed, not a fresh import
    # that may resolve to a different (or absent) real sounddevice.
    callback_stop = sys.modules['sounddevice'].CallbackStop
    player._start_decoder = lambda: setattr(player, '_ffmpeg_process', _FakeProcess())

    player.writeAVI(AVI_ACTION.BEGIN, 'audio/wav', b'')
    player.writeAVI(AVI_ACTION.WRITE, 'audio/wav', b'0123456789ABCDEF')  # >=16 bytes: real cache-file write
    assert player._wrote_any_data is True, 'write() must mark that real data reached the player'

    # Simulate what the real ffmpeg data thread would deliver via onData.
    player.onData(b'\x00' * 4096)
    player.onData(None)

    stop_hw = threading.Event()
    callback_errors = []

    def _drain_like_real_hardware():
        outdata = np.zeros((256, player.CHANNELS), dtype=np.int16)
        while not stop_hw.is_set():
            try:
                player._audio_callback(outdata, 256, None, None)
            except callback_stop:
                break  # normal termination: playback finished
            except Exception as e:  # noqa: BLE001 - recorded, not swallowed; asserted on below
                callback_errors.append(e)
                break

    hw = threading.Thread(target=_drain_like_real_hardware, daemon=True)
    hw.start()

    t = threading.Thread(target=lambda: player.writeAVI(AVI_ACTION.END, 'audio/wav', b''), daemon=True)
    t.start()
    t.join(timeout=5)
    stop_hw.set()
    hw.join(timeout=2)

    assert not callback_errors, f'callback thread raised unexpectedly: {callback_errors!r}'
    assert not t.is_alive(), 'stop() did not return once real queued audio finished draining'
    assert player._playback_finished is True, 'the wait must not have been skipped for real data'
    assert player._play_queue.empty()
    assert len(player._play_callback_buffer) == 0
    # Teardown is unchanged on the populated path too - same explicit check.
    assert sys.modules['sounddevice'].stream_calls == ['stop', 'close']
