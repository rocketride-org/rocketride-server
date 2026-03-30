# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Thread-safe shared blackboard for multi-agent communication.

The blackboard is a key-value store that all agents can read and write.
Every write is attributed to the agent that performed it and timestamped,
providing a full audit trail of how the shared state evolved during
orchestration.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional


@dataclass
class BlackboardEntry:
    """A single write event on the blackboard.

    Attributes:
        agent_name: The agent that wrote this entry.
        key: The blackboard key that was written.
        value: The value that was stored.
        timestamp: Epoch time of the write (seconds).
    """

    agent_name: str
    key: str
    value: Any
    timestamp: float


class SharedBlackboard:
    """Thread-safe shared state for multi-agent orchestration.

    All public methods acquire the internal lock before touching state,
    making concurrent writes from parallel agent threads safe.
    """

    def __init__(self) -> None:  # noqa: D107
        self._lock = threading.Lock()
        self._store: Dict[str, Any] = {}
        self._history: List[BlackboardEntry] = []

    # ------------------------------------------------------------------
    # Write
    # ------------------------------------------------------------------

    def write(self, agent_name: str, key: str, value: Any) -> None:
        """Write a value to the blackboard with attribution.

        Args:
            agent_name: Name of the agent performing the write.
            key: Key to store the value under.
            value: Arbitrary value.
        """
        with self._lock:
            self._store[key] = value
            self._history.append(
                BlackboardEntry(
                    agent_name=agent_name,
                    key=key,
                    value=value,
                    timestamp=time.time(),
                )
            )

    # ------------------------------------------------------------------
    # Read
    # ------------------------------------------------------------------

    def read(self, key: str) -> Optional[Any]:
        """Read a single value by key.  Returns ``None`` if absent."""
        with self._lock:
            return self._store.get(key)

    def read_all(self) -> Dict[str, Any]:
        """Return a shallow copy of the full blackboard state."""
        with self._lock:
            return dict(self._store)

    # ------------------------------------------------------------------
    # History / introspection
    # ------------------------------------------------------------------

    def get_history(self) -> List[BlackboardEntry]:
        """Return the ordered list of all write events (oldest first)."""
        with self._lock:
            return list(self._history)

    def clear(self) -> None:
        """Reset all state and history."""
        with self._lock:
            self._store.clear()
            self._history.clear()
