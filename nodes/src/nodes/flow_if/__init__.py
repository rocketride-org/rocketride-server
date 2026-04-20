# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""flow_if — single-gate conditional filter built on flow_base.

Phase 1 MVP: evaluates a user expression on each incoming chunk. If
the expression is truthy, the chunk is forwarded on the output lane;
otherwise `preventDefault()` drops it.

The two-target branching UX (one node, two output handles) is a
future phase gated on the engine's invoke-by-id semantics — see
docs/nodes/conditional-node-action-plan.md.
"""

from .IGlobal import IGlobal
from .IInstance import IInstance
from .driver import IfDriver

__all__ = ['IGlobal', 'IInstance', 'IfDriver']
