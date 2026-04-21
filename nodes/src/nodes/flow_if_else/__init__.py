# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""flow_if_else — two-branch conditional router built on flow_base.

Evaluates a user expression on each incoming chunk and forwards the
chunk to one of two downstream target lists:

- THEN targets when the expression is truthy.
- ELSE targets when the expression is falsy (or errors / times out).

Routing is done by asking the engine's binder to filter its fanout
down to a single node ID at a time (see `IInstance._gate`). The
feature is type-agnostic — every `writeXxx` override delegates to the
same gate, so text, image, audio, video, table, documents, questions,
answers, and classifications all route the same way.

Design doc: `docs/nodes/flow-if-else-design.md`
"""

from .IGlobal import IGlobal
from .IInstance import IInstance
from .driver import IfElseDriver

__all__ = ['IGlobal', 'IInstance', 'IfElseDriver']
