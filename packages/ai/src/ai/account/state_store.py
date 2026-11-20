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
StateStore: the server's half of a node's ``self.state`` (plan 5.7).

A node keeps state that must survive a call here (a rolling window, a
session, a counter), never on its IGlobal: the balancer sends one control's
calls to different replicas and the idle sweep forgets globals, so in-engine
state is wrong by construction. The node names only its own key; the server
builds the PHYSICAL key from the control that owns the binding (``state_key``:
org, owner, address, then the node's key, each escaped), so a node can never
reach another owner's rows.

One primitive, two backends, as the file store has disk and S3:

- ``MemoryStateStore``: an in-process dict with expiry, the OSS backend and
  the default. Bounded by ``CONST_STATE_MAX_ENTRIES``.
- A shared backend for a multi-replica deployment (Redis in SaaS) installs
  itself with ``install_state_store`` at startup; values and locks then live
  where every replica sees them.

Values are JSON, encoded once at ``put`` and capped at
``CONST_STATE_MAX_VALUE_BYTES``; every read returns a fresh copy. Locks are
leases: ``try_lock`` never blocks (the caller retries), and a holder that
dies loses the key when the lease runs out.
"""

import json
import threading
import time
from abc import ABC, abstractmethod
from typing import Any, Dict, Optional, Tuple
from urllib.parse import quote

from ai.constants import CONST_STATE_MAX_ENTRIES, CONST_STATE_MAX_KEY_LENGTH, CONST_STATE_MAX_VALUE_BYTES

# ==== Errors =====================================================================


class StateError(ValueError):
    """A state request the store refuses: a bad key, a value that is not JSON or too large, a full store."""


# ==== Keys and values ============================================================


def state_key(org_id: str, owner_id: str, address: str, key: str) -> str:
    """
    The physical key of a node's key, owned by (org, owner, address).

    Every segment is percent-escaped, so a ``/`` inside one can never forge
    another owner's prefix.

    Args:
        org_id: The control's organization.
        owner_id: The user or team that owns the control.
        address: The control's address.
        key: The node's own key.

    Returns:
        ``org/owner/address/key``, each segment escaped.

    Raises:
        StateError: The node's key is empty or longer than ``CONST_STATE_MAX_KEY_LENGTH``.
    """
    if not isinstance(key, str) or not key:
        raise StateError('a state key is a non-empty string')
    if len(key) > CONST_STATE_MAX_KEY_LENGTH:
        raise StateError(f'a state key is at most {CONST_STATE_MAX_KEY_LENGTH} characters')
    return '/'.join(quote(str(part or ''), safe='') for part in (org_id, owner_id, address, key))


def encode_value(value: Any) -> str:
    """
    Encode a value for storage, enforcing the cap.

    Args:
        value: Any JSON value.

    Returns:
        Its JSON text.

    Raises:
        StateError: Not JSON, or larger than ``CONST_STATE_MAX_VALUE_BYTES`` encoded.
    """
    try:
        text = json.dumps(value, separators=(',', ':'), allow_nan=False)
    except (TypeError, ValueError) as e:
        raise StateError(f'a state value is a JSON value: {e}') from None
    if len(text.encode('utf-8')) > CONST_STATE_MAX_VALUE_BYTES:
        raise StateError(f'a state value is at most {CONST_STATE_MAX_VALUE_BYTES} bytes as JSON')
    return text


# ==== The interface ==============================================================


class StateStore(ABC):
    """
    Where ``self.state`` lives. Keys are physical (``state_key``); values are JSON text.

    ``ttl`` is in seconds; None or 0 means the value does not expire.

    A write made under a lock names the lock's ``token`` and is FENCED: it
    commits only while that token holds a live lease on the key, so a holder
    whose lease lapsed (and may have been reassigned) can never overwrite the
    next holder's work; it gets a ``StateError`` instead.
    """

    @abstractmethod
    async def get(self, key: str) -> Optional[str]:
        """Return the JSON text stored under ``key``, or None when absent or expired."""

    @abstractmethod
    async def put(self, key: str, text: str, ttl: Optional[float], token: Optional[str] = None) -> None:
        """Store ``text`` under ``key``, replacing any value (fenced by ``token`` when given)."""

    @abstractmethod
    async def delete(self, key: str, token: Optional[str] = None) -> bool:
        """Remove ``key``; True when a live value was there (fenced by ``token`` when given)."""

    @abstractmethod
    async def incr(self, key: str, amount: int, ttl: Optional[float], token: Optional[str] = None) -> int:
        """Add ``amount`` to the integer under ``key`` (absent counts as 0) atomically; return the new value."""

    @abstractmethod
    async def try_lock(self, key: str, token: str, lease: float) -> bool:
        """Take the lock on ``key`` for ``lease`` seconds unless another token holds it; True when taken."""

    @abstractmethod
    async def unlock(self, key: str, token: str) -> bool:
        """Release the lock on ``key`` when ``token`` holds it; True when released."""


# ==== The in-process backend =====================================================


class MemoryStateStore(StateStore):
    """
    The OSS backend: an in-process dict with expiry, shared by every engine of this server.

    Bounded by ``max_entries``, values and locks alike: expired entries are
    dropped first, and a store still full refuses the next new key rather
    than evicting a live value or a live lease.
    """

    def __init__(self, max_entries: int = CONST_STATE_MAX_ENTRIES):
        """
        Start empty.

        Args:
            max_entries: The most live values kept.
        """
        self._lock = threading.Lock()
        self._values: Dict[str, Tuple[str, Optional[float]]] = {}
        self._locks: Dict[str, Tuple[str, float]] = {}
        self._max_entries = max_entries

    # ---- Internals ---------------------------------------------------------

    @staticmethod
    def _expiry(ttl: Optional[float]) -> Optional[float]:
        """The monotonic deadline of a ttl; None for a value that never expires."""
        return time.monotonic() + float(ttl) if ttl else None

    def _live(self, key: str) -> Optional[Tuple[str, Optional[float]]]:
        """Return the live entry of ``key``, dropping it when expired. Caller holds the lock."""
        entry = self._values.get(key)
        if entry is not None and entry[1] is not None and entry[1] <= time.monotonic():
            del self._values[key]
            return None
        return entry

    def _room_for(self, key: str) -> None:
        """Make room for a NEW key, or refuse. Caller holds the lock."""
        if key in self._values or len(self._values) < self._max_entries:
            return
        now = time.monotonic()
        for stale in [k for k, (_, deadline) in self._values.items() if deadline is not None and deadline <= now]:
            del self._values[stale]
        if len(self._values) >= self._max_entries:
            raise StateError(f'the state store holds its maximum of {self._max_entries} values')

    def _fence(self, key: str, token: Optional[str]) -> None:
        """Refuse a write under a lock whose lease ``token`` no longer holds. Caller holds the lock."""
        if token is None:
            return
        held = self._locks.get(key)
        if held is None or held[0] != token or held[1] <= time.monotonic():
            raise StateError('the lock on this key was lost (its lease lapsed); the write was refused')

    # ---- StateStore ----------------------------------------------------------

    async def get(self, key: str) -> Optional[str]:
        """Return the JSON text under ``key``, or None."""
        with self._lock:
            entry = self._live(key)
            return entry[0] if entry is not None else None

    async def put(self, key: str, text: str, ttl: Optional[float], token: Optional[str] = None) -> None:
        """Store ``text`` under ``key``."""
        with self._lock:
            self._fence(key, token)
            self._live(key)
            self._room_for(key)
            self._values[key] = (text, self._expiry(ttl))

    async def delete(self, key: str, token: Optional[str] = None) -> bool:
        """Remove ``key``."""
        with self._lock:
            self._fence(key, token)
            return self._live(key) is not None and self._values.pop(key, None) is not None

    async def incr(self, key: str, amount: int, ttl: Optional[float], token: Optional[str] = None) -> int:
        """Add ``amount`` to the integer under ``key``."""
        with self._lock:
            self._fence(key, token)
            entry = self._live(key)
            current = 0
            if entry is not None:
                current = json.loads(entry[0])
                if not isinstance(current, int) or isinstance(current, bool):
                    raise StateError(f'state.incr: the value under the key is not an integer: {entry[0][:64]}')
            self._room_for(key)
            value = current + int(amount)
            # Like a put, an increment restarts the value's expiry
            self._values[key] = (json.dumps(value), self._expiry(ttl))
            return value

    async def try_lock(self, key: str, token: str, lease: float) -> bool:
        """Take the lock on ``key`` unless a live lease of another token holds it."""
        with self._lock:
            now = time.monotonic()
            held = self._locks.get(key)
            if held is not None and held[0] != token and held[1] > now:
                return False
            # A NEW key needs room: leases nobody released (a crashed holder,
            # a lost unlock) are reclaimed first; a live lease is never evicted
            if held is None and len(self._locks) >= self._max_entries:
                for stale in [k for k, (_, deadline) in self._locks.items() if deadline <= now]:
                    del self._locks[stale]
                if len(self._locks) >= self._max_entries:
                    raise StateError(f'the state store holds its maximum of {self._max_entries} locks')
            self._locks[key] = (token, now + float(lease))
            return True

    async def unlock(self, key: str, token: str) -> bool:
        """Release the lock on ``key`` held by ``token``."""
        with self._lock:
            held = self._locks.get(key)
            if held is None or held[0] != token:
                return False
            del self._locks[key]
            return True


# ==== The process store ==========================================================

_instance: Optional[StateStore] = None
_instance_lock = threading.Lock()


def state_store() -> StateStore:
    """
    The server's state store: the installed backend, else the in-process one.

    Returns:
        StateStore: One per server process.
    """
    global _instance
    if _instance is None:
        with _instance_lock:
            if _instance is None:
                _instance = MemoryStateStore()
    return _instance


def install_state_store(store: Optional[StateStore]) -> None:
    """
    Make ``store`` the server's state store (a shared backend for a multi-replica deployment).

    Called once at startup, before any engine runs; None returns to the
    in-process backend on next use.

    Args:
        store: The backend.
    """
    global _instance
    with _instance_lock:
        _instance = store
