# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""Shared async-first infrastructure for `flow_*` nodes.

Exposes the public API consumed by concrete flow drivers (`flow_if`,
`flow_for`, `flow_while`, ...) and by user code running inside the
sandbox (`rocketride.flow.cond`, `state`, `invoke`, `emit`).

See docs/nodes/conditional-node-action-plan.md for the architectural
rationale: async-first + per-chunk state as foundational invariants.
"""

from .types import Decision, FlowAction, FlowContext, FlowResult
from .state import PerChunkState
from .bounds import Bounds, BoundsError
from .trace import FlowTrace
from .invoker import AsyncInvoker
from .sandbox import SandboxError, evaluate_expression
from .driver import FlowDriverBase
from . import cond

__all__ = [
    'Decision',
    'FlowAction',
    'FlowContext',
    'FlowResult',
    'PerChunkState',
    'Bounds',
    'BoundsError',
    'FlowTrace',
    'AsyncInvoker',
    'SandboxError',
    'evaluate_expression',
    'FlowDriverBase',
    'cond',
]
