# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Per-run state for the RocketRide Wave.

One driver object serves every run of its node, and runs can overlap: the engine
gives each concurrent request its own pipe, and every pipe calls the same driver.
Anything a run remembers therefore lives here, created at the start of the run,
never on the driver.

Memory has the same problem one level down. A memory node can serve more than one
agent (a parent and the child it calls as a tool both write ``wave-0.r0``), and two
overlapping runs can share one. ``RunMemory`` gives a run its own key space on the
shared store, so the keys the model sees stay short and the runs cannot overwrite
each other's results.
"""

from __future__ import annotations

import threading
from concurrent.futures import Future
from dataclasses import dataclass, field
from typing import Any, Dict, Optional, Set, Tuple

from rocketlib import error


class BackgroundCalls:
    """Tool calls a run gave up on that are still running.

    Python cannot stop a thread, so a call that timed out keeps running inside the
    engine's invoke, and returns into the pipeline's state. The engine tears a
    pipeline down only after every request in it has ended, so the run waits for
    every one of these calls before it ends (see ``RocketRideDriver._run``).
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        # Notified once a returned call is counted, which happens after the future's own
        # waiters wake, so wait() waits for the count rather than for the future.
        self._counted = threading.Condition(self._lock)
        self._futures: Set[Future] = set()
        self._returned = 0

    def add(self, future: Future) -> None:
        with self._lock:
            self._futures.add(future)
        # Runs at once if the call has already returned.
        future.add_done_callback(self._discard)

    def _discard(self, future: Future) -> None:
        with self._counted:
            self._futures.discard(future)
            self._returned += 1
            self._counted.notify_all()

    def running(self) -> int:
        """How many of these calls are still running."""
        with self._lock:
            return len(self._futures)

    def snapshot(self) -> Tuple[int, int]:
        """How many of these calls are running, and how many have returned, read together.

        A call that has returned may have changed the work (a write that landed late)
        after a check that ran while it was out. Two separate reads could miss a call
        that returns between them: counted neither as running nor as returned.
        """
        with self._lock:
            return len(self._futures), self._returned

    def wait(self, timeout: Optional[float]) -> int:
        """Wait up to *timeout* seconds (None: as long as it takes) for every call to return.

        Returns:
            How many calls are still running when the wait ends.
        """
        with self._counted:
            self._counted.wait_for(lambda: not self._futures, timeout=timeout)
            return len(self._futures)


@dataclass
class RunState:
    """What one Wave run remembers between waves.

    Attributes:
        seen_results: Fingerprint of each stored result mapped to the key holding it,
            so a later identical result can name the earlier one.
        seen_calls: Fingerprint of each call (tool plus arguments) mapped to the key of
            its first result, so a repeated call can be pointed out.
        removed: Keys the model removed (once the removal is applied), so a repeat
            of a removed call says so.
        background: Calls the run gave up on that are still running.
    """

    seen_results: Dict[str, str] = field(default_factory=dict)
    seen_calls: Dict[str, str] = field(default_factory=dict)
    removed: Set[str] = field(default_factory=set)
    background: BackgroundCalls = field(default_factory=BackgroundCalls)

    def forget(self, keys) -> None:
        """Drop the result fingerprints that point at *keys*.

        Called as soon as a reply asks to remove *keys*, before its calls run, so no
        duplicate note made in that wave names a key that may disappear. Not called
        for a reply that asks to finish: if it is sent back it keeps its keys, so their
        fingerprints stay too. Call
        fingerprints stay: reading something again after removing it is the
        read-remove-read loop worth pointing out. *removed* is updated separately,
        only when the removal is actually applied.
        """
        gone = set(keys)
        self.seen_results = {f: k for f, k in self.seen_results.items() if k not in gone}


class RunMemory:
    """The memory channel, seen through one run's private key space.

    Every key is stored as ``<run_id>/<key>``. The run sees and uses plain keys such
    as ``wave-0.r0``. :meth:`close` clears what the run stored and refuses later
    writes, so a tool that times out and finishes after the run cannot leave its
    result behind.

    The lock guards only this object's own bookkeeping, never a call to the store,
    so a write that hangs never blocks a read, a hide or a removal during the run.
    :meth:`close` is different: it deletes from the store, and it waits for the
    store however long that takes, since the run must not end while a call into
    the engine is still running.

    Being stored and being readable are kept apart. A key is hidden while the wave
    decides whether to keep the result written under it (:meth:`hold`, then
    :meth:`publish`), so a result the wave gave up on is never read, even if the
    store wrote it before it hung. A key the model removes is hidden at once and
    deleted from the store when the run ends: deleting it during the run could
    wait behind a write that hangs, in a store that takes one call at a time.
    """

    def __init__(self, memory: Any, run_id: str):
        self._memory = memory
        self._prefix = f'{run_id}/'
        self._keys: Set[str] = set()
        self._hidden: Set[str] = set()
        self._closed = False
        self._lock = threading.Lock()

    @staticmethod
    def _norm(key: Any) -> Any:
        """*key* as the store files it: the store trims spaces, so ``k `` and ``k`` are one key.

        Every method normalizes first, so a key written with a trailing space cannot
        read a result that is hidden or removed under the plain key.
        """
        return key.strip() if isinstance(key, str) else key

    def put(self, key: str, value: Any) -> Dict[str, Any]:
        key = self._norm(key)
        # The key is recorded before the write, so close() clears it even if the
        # write fails half way or is still in progress.
        with self._lock:
            if self._closed:
                return {'ok': False, 'error': 'the run has finished'}
            self._keys.add(key)
        result = self._memory.put(self._prefix + key, value)
        with self._lock:
            closed = self._closed
        if closed:
            # The run ended while this write was in progress, and close() may have
            # cleared the key before the value landed. Clear it again.
            self._clear_quietly(key)
            return {'ok': False, 'error': 'the run has finished'}
        return result

    def hold(self, key: str) -> None:
        """Hide *key* until :meth:`publish`: the wave has not decided to keep it yet."""
        with self._lock:
            self._hidden.add(self._norm(key))

    def publish(self, key: str) -> None:
        """Make *key* readable: the wave kept the result stored under it."""
        with self._lock:
            self._hidden.discard(self._norm(key))

    def get(self, key: str) -> Dict[str, Any]:
        key = self._norm(key)
        with self._lock:
            hidden = key in self._hidden
        if hidden:
            return {'ok': False, 'error': f'key {key!r} not found'}
        return self._memory.get(self._prefix + key)

    def list(self) -> Dict[str, Any]:
        with self._lock:
            return {'ok': True, 'keys': sorted(self._keys - self._hidden)}

    def clear(self, key: Optional[str] = None) -> Dict[str, Any]:
        if not key:
            # "Clear everything" means everything this run stored, never the whole store.
            # One key that fails to clear must not leave the others behind.
            with self._lock:
                keys, self._keys, self._hidden = sorted(self._keys), set(), set()
            failed = [k for k in keys if not self._clear_quietly(k)]
            if failed:
                return {'ok': False, 'cleared': [k for k in keys if k not in failed], 'failed': failed}
            return {'ok': True, 'cleared': keys}
        # One key: hidden now, deleted from the store when the run ends (close()).
        with self._lock:
            self._hidden.add(self._norm(key))
        return {'ok': True}

    def close(self) -> bool:
        """Clear the run's keys and refuse any later write. Never raises.

        It runs as the run ends, after the answer is ready (or after the error that
        ended the run). A key that cannot be cleared only costs memory, so it is
        logged; it must not replace the answer or the error. It does not give up
        on a slow store: each clear is a call into the engine, and the run must
        not end while one is still running (see ``RocketRideDriver._run``).

        Returns:
            True when every key was cleared.
        """
        with self._lock:
            self._closed = True
        return bool(self.clear().get('ok'))

    def _clear_quietly(self, key: str) -> bool:
        """Clear one of the run's keys from the store; log a failure instead of raising."""
        try:
            self._memory.clear(self._prefix + key)
            return True
        except Exception as exc:
            error(f'rocketride wave could not clear memory key={key!r}: {type(exc).__name__}: {exc}')
            return False
