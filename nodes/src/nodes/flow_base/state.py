# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""Per-chunk state store.

Scope: one `FlowDriverBase.run(chunk)` invocation. Fresh instance at
the start, discarded at the end. Two chunks processed concurrently
get independent `PerChunkState` objects — no cross-chunk races.

If cross-chunk state is ever needed, it belongs in a separate explicit
namespace (`pipeline_state`) with locking — *not* added here.
"""

from __future__ import annotations

from typing import Any, Dict, Iterator


class PerChunkState:
    """Dict-backed mutable store scoped to a single chunk invocation."""

    __slots__ = ('_data',)

    def __init__(self) -> None:
        """Initialize an empty state store."""
        self._data: Dict[str, Any] = {}

    def get(self, key: str, default: Any = None) -> Any:
        return self._data.get(key, default)

    def set(self, key: str, value: Any) -> None:
        self._data[key] = value

    def setdefault(self, key: str, default: Any) -> Any:
        return self._data.setdefault(key, default)

    def update(self, mapping: Dict[str, Any]) -> None:
        self._data.update(mapping)

    def pop(self, key: str, default: Any = None) -> Any:
        return self._data.pop(key, default)

    def clear(self) -> None:
        self._data.clear()

    def keys(self) -> Iterator[str]:
        return iter(self._data.keys())

    def __contains__(self, key: str) -> bool:
        """Return True if `key` is present."""
        return key in self._data

    def __len__(self) -> int:
        """Return the number of stored entries."""
        return len(self._data)

    def __repr__(self) -> str:
        """Return a debug-friendly representation."""
        return f'PerChunkState({self._data!r})'
