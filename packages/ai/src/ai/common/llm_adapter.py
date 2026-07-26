# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Normalized LLM provider interface: one Event shape for every provider.

ChatBase consumes Adapters and never touches provider-native content shapes.
Design: repo discussion #1679 (RFC — virtualized provider Adapter).
"""

from dataclasses import dataclass, field
from typing import Any, Iterator, Protocol, runtime_checkable


@dataclass
class Event:
    """One normalized streaming event: a display delta, or the terminal ``done``."""

    type: str  # "thinking" | "text" | "done"
    text: str = ''
    items: list[Any] = field(default_factory=list)


@runtime_checkable
class Adapter(Protocol):
    """Provider adapter: owns provider-native ``history``, streams normalized Events.

    Yields ``Event("thinking"|"text")`` deltas in order, then exactly one terminal
    ``Event("done", items=...)``. ``items`` is provider-native and OPAQUE: append it
    to ``history`` verbatim — never inspect, edit, reorder, or reserialize it.
    """

    history: list[Any]

    def stream(self, user_text: str) -> Iterator[Event]: ...
