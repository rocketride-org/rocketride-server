# Copyright 2026 Aparavi Software AG. MIT License.
"""Per-account rate limits for /mcp.

Two counters, both per signed-in account and per engine process:

* every MCP request (``MCP_RATE_LIMIT_REQUESTS_PER_MINUTE``, default 600),
  checked in ``handle_mcp`` right after sign-in; a refusal is HTTP 429;
* every ``tools/call`` (``MCP_RATE_LIMIT_CALLS_PER_MINUTE``, default 120),
  checked in the call handler; a refusal is the ``RateLimited`` tool result.

The key is the account's ``userId``, so every API key and OAuth token of one
user draws on one budget. Hosts such as ChatGPT send many users from a few
addresses, which is why the key is never the client address. On a loopback
bind both defaults are 0 (off): that engine is the caller's own machine.

The counters live in process memory and do no I/O. They are not thread-safe:
they are only called from the event loop, with no ``await`` in between.
"""

import hashlib
import logging
import math
import os
import time
from collections import deque
from dataclasses import dataclass
from typing import Any, Callable, Deque, Dict, Optional

logger = logging.getLogger(__name__)

ENV_REQUESTS_PER_MINUTE = 'MCP_RATE_LIMIT_REQUESTS_PER_MINUTE'
ENV_CALLS_PER_MINUTE = 'MCP_RATE_LIMIT_CALLS_PER_MINUTE'
DEFAULT_REQUESTS_PER_MINUTE = 600
DEFAULT_CALLS_PER_MINUTE = 120


@dataclass(frozen=True)
class Limits:
    """How many requests and tool calls one account may make per minute. 0 is no limit."""

    requests_per_minute: int
    calls_per_minute: int


def _read_limit(name: str, default: int) -> int:
    """Read one limit from the environment, falling back to ``default``.

    A value that is not a whole number of 0 or more logs one warning that
    names the variable, never the value, and the default applies.
    """
    raw = (os.environ.get(name) or '').strip()
    if not raw:
        return default
    if not (raw.isascii() and raw.isdigit()):
        logger.warning('%s must be a whole number of 0 or more; using the default, %d', name, default)
        return default
    return int(raw)


def limits_from_env(local_engine: bool) -> Limits:
    """Read both limits. The only place the two settings are read.

    Args:
        local_engine: True on a loopback bind, where both defaults are 0. A
            value set in the environment still applies there.
    """
    requests_default = DEFAULT_REQUESTS_PER_MINUTE
    calls_default = DEFAULT_CALLS_PER_MINUTE
    if local_engine:
        requests_default = 0
        calls_default = 0
    return Limits(
        requests_per_minute=_read_limit(ENV_REQUESTS_PER_MINUTE, requests_default),
        calls_per_minute=_read_limit(ENV_CALLS_PER_MINUTE, calls_default),
    )


class SlidingWindow:
    """Allow at most ``limit`` events per key in any ``window_seconds`` span.

    Each key keeps the times of its counted events. A refused event is not
    counted, so a client that keeps calling does not push its own wait out.
    The table holds at most ``max_keys`` keys. When a new key comes in, the
    least recently checked keys go if their newest event has left the window,
    and the least recently checked key goes if the table is full.
    """

    def __init__(
        self,
        limit: int,
        window_seconds: float = 60.0,
        max_keys: int = 10000,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.limit = limit
        self.window_seconds = window_seconds
        self.max_keys = max_keys
        self._clock = clock
        # Insertion order is check order: check() moves its key to the end.
        self._events: Dict[str, Deque[float]] = {}

    def check(self, key: str) -> Optional[int]:
        """Count one event for ``key``.

        Returns:
            None when the event is allowed (and counted). Otherwise the whole
            seconds, at least 1, until the oldest counted event leaves the
            window. A limit of 0 or less always allows.
        """
        if self.limit <= 0:
            return None
        now = self._clock()
        events = self._events.pop(key, None)
        if events is None:
            self._make_room(now)
            events = deque()
        self._events[key] = events
        cutoff = now - self.window_seconds
        while events and events[0] <= cutoff:
            events.popleft()
        if len(events) >= self.limit:
            return max(1, math.ceil(events[0] + self.window_seconds - now))
        events.append(now)
        return None

    def _make_room(self, now: float) -> None:
        """Drop keys from the least recently checked end before a new key is added.

        A key goes when its newest event has left the window, or while the
        table is full. Each key is dropped at most once, so this stays cheap.
        """
        cutoff = now - self.window_seconds
        while self._events:
            oldest = next(iter(self._events))
            events = self._events[oldest]
            stale = not events or events[-1] <= cutoff
            if not stale and len(self._events) < self.max_keys:
                return
            del self._events[oldest]


def account_key(scope: Any) -> Optional[str]:
    """Return the key one account's requests are counted under, or None.

    The signed-in account's ``userId`` when there is one. Otherwise, when a
    credential was presented, a hash of it (a sign-in that produced no account
    object). None when neither is there (the loopback no-auth mode), and
    nothing is limited.
    """
    state = scope.get('state') if isinstance(scope, dict) else None
    if not isinstance(state, dict):
        return None
    # AccountInfo is a model, not a dict, so read the attribute.
    user_id = getattr(state.get('account'), 'userId', '')
    if isinstance(user_id, str) and user_id:
        return f'user:{user_id}'
    credential = state.get('mcp_credential')
    if isinstance(credential, str) and credential:
        return 'credential:' + hashlib.sha256(credential.encode()).hexdigest()
    return None


def plural(count: int, noun: str) -> str:
    """'1 second', '2 seconds': the noun takes an s for any count but 1."""
    if count == 1:
        return f'{count} {noun}'
    return f'{count} {noun}s'
