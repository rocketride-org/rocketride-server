# Copyright 2026 Aparavi Software AG. MIT License.
"""Server-owned task registry.

The RocketRide SDK has no client-side task registry: ``use()`` returns a
bare task token, and enumerate/terminate/monitor across separate tool calls
need somewhere to keep ``{token -> metadata}``. This is a plain in-memory
dict, scoped to a single asyncio event loop (one process, one persistent
``RocketRideClient``) — it is NOT thread-safe and must not be shared across
event loops or accessed concurrently from multiple threads.
"""

from typing import Any, Dict, List, Optional

# Bound on registry size: entries leak when cleanup paths are skipped (a
# failed terminate, a client that stops mid-run and never polls monitor to
# a terminal state). The registry is advisory metadata — evicting the oldest
# entry never invalidates the engine-side task, it only drops bookkeeping —
# so a simple FIFO cap keeps a long-lived process bounded.
MAX_TASKS = 512


class TaskRegistry:
    """In-memory ``{token -> metadata}`` registry, FIFO-bounded at ``MAX_TASKS``.

    Single-event-loop use only; not thread-safe.
    """

    def __init__(self) -> None:
        self._tasks: Dict[str, Dict[str, Any]] = {}

    def add(self, token: str, **metadata: Any) -> None:
        """Register ``token`` with the given metadata, replacing any prior entry.

        At ``MAX_TASKS`` entries the oldest is evicted (dict preserves
        insertion order) so leaked tokens can't grow the process forever.
        """
        self._tasks.pop(token, None)  # re-add moves the token to newest
        while len(self._tasks) >= MAX_TASKS:
            self._tasks.pop(next(iter(self._tasks)))
        self._tasks[token] = dict(metadata)

    def remove(self, token: str) -> None:
        """Drop ``token`` from the registry. A no-op if it is not present."""
        self._tasks.pop(token, None)

    def get(self, token: str) -> Optional[Dict[str, Any]]:
        """Return ``{'token': token, **metadata}`` for ``token``, or ``None``."""
        metadata = self._tasks.get(token)
        if metadata is None:
            return None
        return {'token': token, **metadata}

    def list(self) -> List[Dict[str, Any]]:
        """Return ``[{'token': token, **metadata}, ...]`` for every registered task."""
        return [{'token': token, **metadata} for token, metadata in self._tasks.items()]
