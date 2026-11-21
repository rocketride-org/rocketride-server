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
builds the PHYSICAL key from the control that owns the binding and the node's
component id (``state_key``: org, owner, address, node id, then the node's
key, each escaped), so a node can never reach another owner's rows and two
nodes of one pipeline that choose the same key name keep separate values.

Three rules hold in every backend:

- A key belongs to one node: the first four segments are the node's SCOPE
  (``state_scope``), and nothing outside the scope is reachable from it.
- Every value expires. A write names a ``ttl`` in
  ``(0, CONST_STATE_MAX_TTL_SECONDS]`` seconds and restarts the value's
  expiry; no value is stored without one. A value still in use is kept alive
  by writing it.
- A scope holds at most ``max_keys`` live values (the server passes
  ``CONST_STATE_MAX_KEYS_PER_NODE``). A write that would add one more is
  refused; nothing is evicted to make room. A write to a key that already
  holds a live value always fits. Expired values and lock leases are not
  counted.

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
import math
import threading
import time
from abc import ABC, abstractmethod
from typing import Any, Dict, Optional, Set, Tuple
from urllib.parse import quote

from ai.constants import (
    CONST_STATE_MAX_ENTRIES,
    CONST_STATE_MAX_KEY_LENGTH,
    CONST_STATE_MAX_TTL_SECONDS,
    CONST_STATE_MAX_VALUE_BYTES,
)

# ==== Errors =====================================================================


class StateError(ValueError):
    """A state request the store refuses: a bad key, ttl or value, a node at its key limit, a full store."""


# ==== Keys and values ============================================================


def state_scope(org_id: str, owner_id: str, address: str, node_id: str) -> str:
    """
    The scope of one node's keys: the prefix every physical key of the node starts with.

    Every segment is percent-escaped, so a ``/`` inside one can never forge
    another owner's or another node's prefix. The per-node key limit is
    counted per scope.

    Args:
        org_id: The control's organization.
        owner_id: The user or team that owns the control.
        address: The control's address.
        node_id: The node's component id in the pipeline.

    Returns:
        ``org/owner/address/nodeId``, each segment escaped (three ``/``).

    Raises:
        StateError: The node id is not a non-empty string.
    """
    if not isinstance(node_id, str) or not node_id:
        raise StateError('a node id is a non-empty string')
    return '/'.join(quote(str(part or ''), safe='') for part in (org_id, owner_id, address, node_id))


def state_key(org_id: str, owner_id: str, address: str, node_id: str, key: str) -> str:
    """
    The physical key of a node's key, owned by (org, owner, address) and the node.

    Args:
        org_id: The control's organization.
        owner_id: The user or team that owns the control.
        address: The control's address.
        node_id: The node's component id in the pipeline.
        key: The node's own key.

    Returns:
        ``state_scope(org_id, owner_id, address, node_id) + '/' + key``, the
        key escaped like the scope's segments (four ``/`` in all).

    Raises:
        StateError: The node id is not a non-empty string, or the node's key
            is empty or longer than ``CONST_STATE_MAX_KEY_LENGTH``.
    """
    if not isinstance(key, str) or not key:
        raise StateError('a state key is a non-empty string')
    if len(key) > CONST_STATE_MAX_KEY_LENGTH:
        raise StateError(f'a state key is at most {CONST_STATE_MAX_KEY_LENGTH} characters')
    return state_scope(org_id, owner_id, address, node_id) + '/' + quote(key, safe='')


def check_write(scope: str, key: str, ttl: float, max_keys: int) -> float:
    """
    Validate what every write (``put``, ``incr``) is given; each backend calls it first.

    Args:
        scope: The node's scope (``state_scope``).
        key: The physical key (``state_key``).
        ttl: Seconds until the value expires.
        max_keys: The most live values the scope may hold.

    Returns:
        ``ttl`` as a float.

    Raises:
        StateError: ``key`` is not a key of ``scope``, ``ttl`` is not a number
            in ``(0, CONST_STATE_MAX_TTL_SECONDS]``, or ``max_keys`` is not a
            positive integer.
    """
    if not scope or not key.startswith(scope + '/'):
        raise StateError('a state key belongs to the scope it is written in')
    if (
        isinstance(ttl, bool)
        or not isinstance(ttl, (int, float))
        or not math.isfinite(ttl)
        or not 0 < ttl <= CONST_STATE_MAX_TTL_SECONDS
    ):
        raise StateError(f'a state value expires: ttl is a number of seconds in (0, {CONST_STATE_MAX_TTL_SECONDS}]')
    if isinstance(max_keys, bool) or not isinstance(max_keys, int) or max_keys < 1:
        raise StateError('max_keys is a positive integer')
    return float(ttl)


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
    Where ``self.state`` lives. Values are JSON text; the caller built every key and scope.

    The arguments every method shares:

    - ``key`` is always the PHYSICAL key, ``state_key(org, owner, address,
      node_id, key)``. It is opaque to a backend apart from one fact:
      it starts with its scope followed by ``/``.
    - ``scope`` is ``state_scope(org, owner, address, node_id)``, the node the
      key belongs to. The methods that add or remove a value take it so the
      backend can keep the scope's count of live values without parsing keys.
    - ``ttl`` is seconds until the value expires, a number in
      ``(0, CONST_STATE_MAX_TTL_SECONDS]``. It is required: None, 0, a
      negative number and a longer one are refused. Every write restarts the
      value's expiry, so no value is ever stored without one.
    - ``max_keys`` is the most LIVE values the scope may hold, a positive
      integer chosen by the caller (``CONST_STATE_MAX_KEYS_PER_NODE``).
    - ``token`` names the lock lease a write is made under.

    A write (``put``, ``incr``) calls ``check_write(scope, key, ttl,
    max_keys)`` first, then decides and commits in ONE atomic step, in this
    order:

    1. The fence: with a ``token``, the write commits only while that token
       holds a live lease on ``key``; a holder whose lease lapsed (and may
       have been reassigned) gets a ``StateError`` and writes nothing.
    2. The limit: when ``key`` holds no live value, the write would add one
       to the scope. If the scope already holds ``max_keys`` live values the
       write is refused with a ``StateError`` whose message names the limit,
       and nothing is stored or evicted. A key that holds a live value is
       always written, whatever the count. An expired value is absent: it is
       not counted and writing its key adds a value. Lock leases are never
       counted. Two concurrent writes of two new keys into a scope with one
       free slot must not both succeed.
    3. The write: the value is stored with its new expiry.

    A value that expires or is deleted leaves the scope's count at once, or
    is discounted before the limit is next checked.
    """

    @abstractmethod
    async def get(self, key: str) -> Optional[str]:
        """
        Read a value.

        Args:
            key: The physical key.

        Returns:
            The JSON text stored under ``key``, or None when absent or expired.
        """

    @abstractmethod
    async def put(
        self, scope: str, key: str, text: str, ttl: float, max_keys: int, token: Optional[str] = None
    ) -> None:
        """
        Store ``text`` under ``key``, replacing any value and restarting its expiry.

        Args:
            scope: The scope ``key`` belongs to.
            key: The physical key.
            text: The JSON text (already encoded and capped by ``encode_value``).
            ttl: Seconds until the value expires; required.
            max_keys: The most live values ``scope`` may hold.
            token: The lease the write is fenced by, or None for an unfenced write.

        Raises:
            StateError: A bad ``ttl`` or ``max_keys`` (``check_write``); the
                lease ``token`` names was lost; ``key`` is new and ``scope``
                already holds ``max_keys`` live values; the store is full.
        """

    @abstractmethod
    async def delete(self, scope: str, key: str, token: Optional[str] = None) -> bool:
        """
        Remove the value under ``key``; its slot in ``scope`` is free at once.

        Args:
            scope: The scope ``key`` belongs to.
            key: The physical key.
            token: The lease the delete is fenced by, or None for an unfenced delete.

        Returns:
            True when a live value was there.

        Raises:
            StateError: The lease ``token`` names was lost.
        """

    @abstractmethod
    async def incr(
        self, scope: str, key: str, amount: int, ttl: float, max_keys: int, token: Optional[str] = None
    ) -> int:
        """
        Add ``amount`` to the integer under ``key`` atomically, restarting its expiry.

        An absent or expired key counts from 0 and the write adds a value to
        ``scope``, under the same limit as ``put``.

        Args:
            scope: The scope ``key`` belongs to.
            key: The physical key.
            amount: The increment (negative to decrement).
            ttl: Seconds until the value expires; required.
            max_keys: The most live values ``scope`` may hold.
            token: The lease the write is fenced by, or None for an unfenced write.

        Returns:
            The new value.

        Raises:
            StateError: A bad ``ttl`` or ``max_keys`` (``check_write``); the
                lease ``token`` names was lost; the live value is not an
                integer; ``key`` is new and ``scope`` already holds
                ``max_keys`` live values; the store is full.
        """

    @abstractmethod
    async def try_lock(self, key: str, token: str, lease: float) -> bool:
        """
        Take the lock on ``key`` for ``lease`` seconds, never waiting.

        A lock is a lease beside the value, not a value: it needs no value
        under ``key``, is not counted in any scope and does not expire with
        the value. The token that holds it may take it again to renew it.

        Args:
            key: The physical key.
            token: The caller's token for this lease.
            lease: Seconds the lease lasts unless released.

        Returns:
            True when taken; False while a live lease of another token holds it.

        Raises:
            StateError: The store cannot hold another lease.
        """

    @abstractmethod
    async def unlock(self, key: str, token: str) -> bool:
        """
        Release the lock on ``key``.

        Args:
            key: The physical key.
            token: The token the lease was taken with.

        Returns:
            True when ``token`` held the lease and it was released.
        """


# ==== The in-process backend =====================================================


class MemoryStateStore(StateStore):
    """
    The OSS backend: an in-process dict with expiry, shared by every engine of this server.

    Bounded by ``max_entries``, values and locks alike: expired entries are
    dropped first, and a store still full refuses the next new key rather
    than evicting a live value or a live lease. Each scope's keys are also
    kept in a set of their own, so the per-node limit is checked against that
    scope's few keys and never by a scan of the store.
    """

    def __init__(self, max_entries: int = CONST_STATE_MAX_ENTRIES):
        """
        Start empty.

        Args:
            max_entries: The most live values kept.
        """
        self._lock = threading.Lock()
        # key -> (text, monotonic deadline, scope)
        self._values: Dict[str, Tuple[str, float, str]] = {}
        # scope -> the keys of _values in it; a scope with no key has no entry
        self._scopes: Dict[str, Set[str]] = {}
        self._locks: Dict[str, Tuple[str, float]] = {}
        self._max_entries = max_entries

    # ---- Internals ---------------------------------------------------------

    def _drop(self, key: str) -> None:
        """Forget ``key`` and its place in its scope. Caller holds the lock."""
        entry = self._values.pop(key, None)
        if entry is None:
            return
        keys = self._scopes.get(entry[2])
        if keys is not None:
            keys.discard(key)
            if not keys:
                del self._scopes[entry[2]]

    def _live(self, key: str) -> Optional[Tuple[str, float, str]]:
        """Return the live entry of ``key``, dropping it when expired. Caller holds the lock."""
        entry = self._values.get(key)
        if entry is not None and entry[1] <= time.monotonic():
            self._drop(key)
            return None
        return entry

    def _room_for(self, scope: str, key: str, max_keys: int) -> None:
        """
        Make room for ``key`` in its scope and in the store, or refuse. Caller holds the lock.

        A key that holds a value needs no room. The caller has already
        dropped ``key`` itself when it was expired.

        Raises:
            StateError: The scope holds ``max_keys`` live values, or the store is full.
        """
        if key in self._values:
            return
        now = time.monotonic()
        keys = self._scopes.get(scope, ())
        if len(keys) >= max_keys:
            # Expired values of this scope do not count: drop them, then look again
            for stale in [k for k in keys if self._values[k][1] <= now]:
                self._drop(stale)
            if len(self._scopes.get(scope, ())) >= max_keys:
                raise StateError(
                    f'a node keeps at most {max_keys} state keys and this one holds {max_keys}; '
                    'delete a key or let one expire before adding another'
                )
        if len(self._values) >= self._max_entries:
            for stale in [k for k, entry in self._values.items() if entry[1] <= now]:
                self._drop(stale)
            if len(self._values) >= self._max_entries:
                raise StateError(f'the state store holds its maximum of {self._max_entries} values')

    def _store(self, scope: str, key: str, text: str, ttl: float) -> None:
        """Write ``key`` with a new expiry, keeping its scope's set in step. Caller holds the lock."""
        self._values[key] = (text, time.monotonic() + ttl, scope)
        self._scopes.setdefault(scope, set()).add(key)

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

    async def put(
        self, scope: str, key: str, text: str, ttl: float, max_keys: int, token: Optional[str] = None
    ) -> None:
        """Store ``text`` under ``key``, within its scope's limit."""
        ttl = check_write(scope, key, ttl, max_keys)
        with self._lock:
            self._fence(key, token)
            self._live(key)
            self._room_for(scope, key, max_keys)
            self._store(scope, key, text, ttl)

    async def delete(self, scope: str, key: str, token: Optional[str] = None) -> bool:
        """Remove ``key``; the scope's set is kept from the stored entry, so ``scope`` is not read here."""
        with self._lock:
            self._fence(key, token)
            if self._live(key) is None:
                return False
            self._drop(key)
            return True

    async def incr(
        self, scope: str, key: str, amount: int, ttl: float, max_keys: int, token: Optional[str] = None
    ) -> int:
        """Add ``amount`` to the integer under ``key``, within its scope's limit."""
        ttl = check_write(scope, key, ttl, max_keys)
        with self._lock:
            self._fence(key, token)
            entry = self._live(key)
            current = 0
            if entry is not None:
                current = json.loads(entry[0])
                if not isinstance(current, int) or isinstance(current, bool):
                    raise StateError(f'state.incr: the value under the key is not an integer: {entry[0][:64]}')
            self._room_for(scope, key, max_keys)
            value = current + int(amount)
            # Like a put, an increment restarts the value's expiry
            self._store(scope, key, json.dumps(value), ttl)
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
