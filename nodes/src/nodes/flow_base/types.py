# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""Shared types for the flow_base module.

`FlowResult` is the contract returned by `FlowDriverBase.run()` and
interpreted by the owning IInstance to decide whether to pass a chunk
through, preventDefault, or emit a different payload.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Optional


class FlowAction(str, Enum):
    """What the driver decided should happen to the chunk."""

    EMIT = 'emit'  # forward `payload` on the output lane
    SKIP = 'skip'  # preventDefault — drop the chunk


class Decision(str, Enum):
    """Binary branch decision shared by if/while/filter-style nodes."""

    THEN = 'then'
    ELSE = 'else'


@dataclass
class FlowResult:
    """Outcome of a single invocation of a flow driver on one chunk."""

    action: FlowAction
    payload: Any = None
    decision: Optional[Decision] = None
    metadata: dict = field(default_factory=dict)

    @classmethod
    def emit(cls, payload: Any, decision: Optional[Decision] = None) -> 'FlowResult':
        return cls(action=FlowAction.EMIT, payload=payload, decision=decision)

    @classmethod
    def skip(cls, decision: Optional[Decision] = None) -> 'FlowResult':
        return cls(action=FlowAction.SKIP, decision=decision)


@dataclass
class FlowContext:
    """Per-invocation context handed to every driver method.

    One `FlowContext` exists per `FlowDriverBase.run(chunk)` call and
    is discarded when `run()` returns. Carries the fresh `PerChunkState`
    so `evaluate`/`dispatch`/`emit` share a common scope.
    """

    chunk: Any
    state: 'PerChunkState'  # noqa: F821 — avoid circular import at type-check time
    invoker: 'AsyncInvoker'  # noqa: F821
    bounds: 'Bounds'  # noqa: F821
    trace: 'FlowTrace'  # noqa: F821
    node_id: str = ''
