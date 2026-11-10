"""Tests for the thread-start stuck marker of rr_test_stack_dumps."""

import importlib.util
import os
import sys
import threading
import time

_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'rr_test_stack_dumps.py')
_spec = importlib.util.spec_from_file_location('rr_test_stack_dumps_under_test', _PATH)
dumps = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(dumps)

_MARKER = '=== thread start stuck'


class _NeverStarted(threading.Thread):
    """A thread whose bootstrap blocks without setting ``_started``, so ``start()`` never returns."""

    def __init__(self, release: threading.Event) -> None:
        """
        Create the thread.

        Args:
            release (threading.Event): Set to let the bootstrap finish.
        """
        super().__init__(daemon=True)
        self._release = release
        self.finished = threading.Event()

    def _bootstrap(self) -> None:
        """
        Block until released without announcing the start, then run the normal bootstrap.

        Returns:
            None
        """
        self._release.wait(30)
        super()._bootstrap()
        self.finished.set()


def _dumper(tmp_path, recheck: float = 0.3):
    """
    Build a dumper that writes to a temp file, with a short recheck delay.

    Args:
        tmp_path (pathlib.Path): Directory for the dump file.
        recheck (float): Seconds between the two samples.

    Returns:
        tuple[_Dumper, pathlib.Path]: The dumper and its file path.
    """
    path = tmp_path / 'stacks.txt'
    dumper = dumps._Dumper(open(path, 'w', encoding='utf-8'), 30, time.monotonic(), 'task')
    dumper._recheck = recheck
    return dumper, path


def _in_start(ident) -> bool:
    """
    Tell whether a thread currently waits in ``Thread.start()``.

    Args:
        ident (int | None): The thread ident.

    Returns:
        bool: True when the detector finds a ``start`` wait on that thread.
    """
    return dumps._find_start_wait(sys._current_frames().get(ident)) is not None


def _wait_until(predicate, timeout: float = 5.0) -> bool:
    """
    Poll a predicate.

    Args:
        predicate (Callable[[], bool]): The condition.
        timeout (float): Seconds to wait.

    Returns:
        bool: True when the condition became true in time.
    """
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if predicate():
            return True
        time.sleep(0.01)
    return False


def _release(worker, release, helper, dumper) -> None:
    """
    Let the stuck thread and its starter finish, then close the dumper.

    Args:
        worker (_NeverStarted): The thread that never announces its start.
        release (threading.Event): The event its bootstrap waits on.
        helper (threading.Thread): The thread that called ``worker.start()``.
        dumper (_Dumper): The dumper to close.
    """
    release.set()
    helper.join(5)
    worker.finished.wait(5)
    worker.join(5)
    dumper.close()
    assert not helper.is_alive()


def test_stuck_start_is_reported_once(tmp_path):
    """A thread parked in Thread.start() across both samples gets one marker; it is not repeated."""
    release = threading.Event()
    worker = _NeverStarted(release)
    helper = threading.Thread(target=worker.start, daemon=True)
    dumper, path = _dumper(tmp_path)
    try:
        helper.start()
        assert _wait_until(lambda: _in_start(helper.ident))
        dumper._dump()
        text = path.read_text(encoding='utf-8')
        assert f'{_MARKER} thread=0x{helper.ident:016x} seconds=0.3\n\n' in text
        dumper._dump()
        assert path.read_text(encoding='utf-8').count(_MARKER) == 1
    finally:
        _release(worker, release, helper, dumper)


def test_user_event_wait_and_quick_start_give_no_marker(tmp_path):
    """A user-code Event.wait() and a normal Thread.start() are not stuck starts."""
    gate = threading.Event()
    waiter = threading.Thread(target=threading.Event().wait, args=(30,), daemon=True)
    quick = threading.Thread(target=gate.wait, args=(30,), daemon=True)
    dumper, path = _dumper(tmp_path, 0.2)
    try:
        waiter.start()
        quick.start()
        dumper._dump()
        assert _MARKER not in path.read_text(encoding='utf-8')
    finally:
        gate.set()
        dumper.close()


def test_start_that_returns_between_samples_gives_no_marker(tmp_path):
    """A thread that leaves its start() call before the second sample is not reported."""
    release = threading.Event()
    worker = _NeverStarted(release)
    helper = threading.Thread(target=worker.start, daemon=True)
    dumper, path = _dumper(tmp_path, 0.5)
    try:
        helper.start()
        assert _wait_until(lambda: _in_start(helper.ident))
        timer = threading.Timer(0.15, worker._started.set)
        timer.start()
        dumper._dump()
        timer.join(5)
        assert _MARKER not in path.read_text(encoding='utf-8')
    finally:
        _release(worker, release, helper, dumper)


def test_stopped_dumper_skips_recheck(tmp_path):
    """When the dumper is stopped, the recheck wait ends at once and nothing is written."""
    release = threading.Event()
    worker = _NeverStarted(release)
    helper = threading.Thread(target=worker.start, daemon=True)
    dumper, path = _dumper(tmp_path, 30)
    try:
        helper.start()
        assert _wait_until(lambda: _in_start(helper.ident))
        dumper._stop.set()
        began = time.monotonic()
        dumper._dump()
        assert time.monotonic() - began < 5
        assert _MARKER not in path.read_text(encoding='utf-8')
    finally:
        _release(worker, release, helper, dumper)


def test_new_start_call_between_samples_gives_no_marker(tmp_path):
    """A thread that finishes one start() and enters another between samples is not the same stuck call."""
    release = threading.Event()
    first = _NeverStarted(release)
    second = _NeverStarted(release)
    second_entered = threading.Event()

    def starter() -> None:
        """
        Call ``first.start()``, then ``second.start()`` once the first returns.

        Returns:
            None
        """
        first.start()
        second_entered.set()
        second.start()

    helper = threading.Thread(target=starter, daemon=True)
    dumper, path = _dumper(tmp_path, 0.6)
    try:
        helper.start()
        assert _wait_until(lambda: _in_start(helper.ident))
        timer = threading.Timer(0.15, first._started.set)
        timer.start()
        dumper._dump()
        timer.join(5)
        assert second_entered.wait(5)
        assert _MARKER not in path.read_text(encoding='utf-8')
    finally:
        second._started.set()
        _release(first, release, helper, dumper)
        second.finished.wait(5)
        second.join(5)
