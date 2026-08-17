# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""Regression test for issue #1966: audio_player deadlocked when a single
object carried both an audio and a video stream, because both lanes drove the
same Player through one non-reentrant lock.
"""

from __future__ import annotations

import sys
import threading
import types
from pathlib import Path

_NODE_DIR = Path(__file__).resolve().parent.parent.parent / 'src' / 'nodes' / 'audio_player'
_AI_SRC = Path(__file__).resolve().parent.parent.parent.parent / 'packages' / 'ai' / 'src'


def _install_stubs():
    """Fake only the hardware/binary deps audio_player needs at import time
    (real PortAudio hardware isn't available here); the real IGlobal,
    IInstance, Player, and AVIReader lock/lane logic run unmodified.
    """
    if 'sounddevice' not in sys.modules:
        sd = types.ModuleType('sounddevice')

        class _FakeOutputStream:
            def __init__(self, **kwargs):
                pass

            def start(self):
                pass

            def stop(self):
                pass

            def close(self):
                pass

        class _CallbackStop(Exception):
            pass

        sd.OutputStream = _FakeOutputStream
        sd.CallbackStop = _CallbackStop
        sys.modules['sounddevice'] = sd

    ai_src = str(_AI_SRC)
    if ai_src not in sys.path:
        sys.path.insert(0, ai_src)

    if 'audio_player' not in sys.modules:
        pkg = types.ModuleType('audio_player')
        pkg.__path__ = [str(_NODE_DIR)]
        sys.modules['audio_player'] = pkg


def _fresh_instance():
    """A real audio_player IInstance wired to a real threading.Lock, built the
    way IGlobal.beginGlobal wires it (IGlobal.py:34) without running
    beginGlobal itself (which would try to install requirements.txt).
    """
    _install_stubs()
    from audio_player.IGlobal import IGlobal
    from audio_player.IInstance import IInstance

    inst = IInstance()
    g = IGlobal()
    g.lock = threading.Lock()
    inst.IGlobal = g
    inst.beginInstance()
    return inst


def _drive_conflicting_begins(inst, results, errors):
    from rocketlib import AVI_ACTION

    try:
        inst.writeAudio(AVI_ACTION.BEGIN, 'audio/wav', b'')
        inst.writeVideo(AVI_ACTION.BEGIN, 'video/mp4', b'')
        results.append('completed')
    except Exception as e:  # noqa: BLE001 - capturing whatever the guard raises
        errors.append(e)


def test_second_lane_begin_is_rejected_not_deadlocked():
    """
    Pre-fix, this sequence hangs: writeVideo(BEGIN) re-enters the Player's
    non-reentrant lock from the thread that already holds it (reader.py
    _lock/writeAVI). Run on a background thread with a bounded join so a
    regression shows up as a failing assertion, never as a hung suite.
    """
    inst = _fresh_instance()
    from audio_player.IInstance import LaneConflictError

    results = []
    errors = []

    t = threading.Thread(target=_drive_conflicting_begins, args=(inst, results, errors), daemon=True)
    t.start()
    t.join(timeout=5)

    assert not t.is_alive(), (
        'writeVideo(BEGIN) did not return within 5s while the audio lane was active - '
        'this is the issue #1966 deadlock (non-reentrant Player lock re-entered from the '
        'same thread), not a slow test'
    )
    assert not results, f'expected the conflicting BEGIN to be rejected, but it completed: {results}'
    assert len(errors) == 1, f'expected exactly one LaneConflictError, got: {errors}'
    assert isinstance(errors[0], LaneConflictError), f'wrong error type: {errors[0]!r}'
    assert 'audio' in str(errors[0]) and 'video' in str(errors[0])

    # The audio lane's Player was BEGIN'd but never WRITE/END'd (by design: this
    # test only proves the conflicting BEGIN is rejected, not a full stream).
    # Player.stop() waits for _playback_finished, which only a WRITE-triggered
    # ffmpeg thread ever sets - calling it here would hang on something
    # unrelated to issue #1966, in player.py, which this fix must not touch.
    # Mark it finished so the Player's own __del__/stop() can't hang later.
    inst._audio._playback_finished = True


def test_own_lane_end_then_begin_is_not_rejected():
    """
    Ending the active lane frees the node for a fresh stream on either lane -
    the guard tracks 'currently active', not 'ever used'.

    This drives the guard/commit pair directly rather than through
    writeAudio/writeVideo: a real END with no prior WRITE hangs in
    Player.stop() (see the note in the test above), which is unrelated to the
    guard being tested here and out of scope for this fix.
    """
    from rocketlib import AVI_ACTION

    inst = _fresh_instance()

    inst._guard_lane('audio', AVI_ACTION.BEGIN)
    inst._commit_lane('audio', AVI_ACTION.BEGIN)
    inst._guard_lane('audio', AVI_ACTION.END)
    inst._commit_lane('audio', AVI_ACTION.END)
    inst._guard_lane('video', AVI_ACTION.BEGIN)  # must not raise
    inst._commit_lane('video', AVI_ACTION.BEGIN)
    assert inst._active_lane == 'video'


def test_failed_begin_does_not_wedge_the_other_lane():
    """
    If writeAVI(BEGIN) itself raises (e.g. Player.start()'s bare
    'already started' RuntimeError), the lane must not be left marked active
    with no END coming - otherwise every later BEGIN on either lane is
    permanently rejected.
    """
    import pytest
    from rocketlib import AVI_ACTION
    from audio_player.IInstance import LaneConflictError

    inst = _fresh_instance()

    def _boom(action, mimeType, buffer):
        raise RuntimeError('simulated start failure')

    inst._audio.writeAVI = _boom

    with pytest.raises(RuntimeError, match='simulated start failure'):
        inst.writeAudio(AVI_ACTION.BEGIN, 'audio/wav', b'')
    assert inst._active_lane is None, 'a failed BEGIN must not leave the lane marked active'

    # Video's BEGIN must reach the real call (and fail for the same stubbed
    # reason) instead of being rejected as a stale conflict left by the
    # failed audio BEGIN.
    with pytest.raises(RuntimeError) as excinfo:
        inst.writeVideo(AVI_ACTION.BEGIN, 'video/mp4', b'')
    assert not isinstance(excinfo.value, LaneConflictError), 'video was wrongly rejected as a lane conflict'
    assert 'simulated start failure' in str(excinfo.value)


def _drive_repeated_begin(inst, lane, results, errors):
    from rocketlib import AVI_ACTION

    write = inst.writeAudio if lane == 'audio' else inst.writeVideo
    mime = 'audio/wav' if lane == 'audio' else 'video/mp4'

    try:
        write(AVI_ACTION.BEGIN, mime, b'')
        write(AVI_ACTION.BEGIN, mime, b'')
        results.append('completed')
    except Exception as e:  # noqa: BLE001 - capturing whatever the guard raises
        errors.append(e)


def _assert_repeated_begin_is_rejected_not_deadlocked(lane):
    """
    A second BEGIN on the SAME lane re-enters the Player's non-reentrant lock
    exactly like a different lane would (CodeRabbit catch on #1966: the guard
    only compared lanes, so audio-then-audio slipped through to writeAVI while
    the Player still held the lock). Same bounded-thread technique as the
    cross-lane test: a regression must show up as a failing assertion, never
    as a hung suite.
    """
    inst = _fresh_instance()
    from audio_player.IInstance import LaneConflictError

    results = []
    errors = []

    t = threading.Thread(target=_drive_repeated_begin, args=(inst, lane, results, errors), daemon=True)
    t.start()
    t.join(timeout=5)

    assert not t.is_alive(), (
        f'repeated {lane} BEGIN did not return within 5s - same-lane lock re-entry, not a slow test'
    )
    assert not results, f'expected the repeated BEGIN to be rejected, but it completed: {results}'
    assert len(errors) == 1, f'expected exactly one LaneConflictError, got: {errors}'
    assert isinstance(errors[0], LaneConflictError), f'wrong error type: {errors[0]!r}'

    # Same teardown reasoning as test_second_lane_begin_is_rejected_not_deadlocked above.
    inst._audio._playback_finished = True


def test_repeated_audio_begin_is_rejected_not_deadlocked():
    _assert_repeated_begin_is_rejected_not_deadlocked('audio')


def test_repeated_video_begin_is_rejected_not_deadlocked():
    _assert_repeated_begin_is_rejected_not_deadlocked('video')
