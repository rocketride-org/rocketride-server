# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""Shared base for `flow_*` conditional routers.

Two-branch routing built on a single abstract `checkCondition(condition, **kwargs)`
hook. Concrete subclasses (`flow.pyeval`, `flow.llm`, ...) implement the
hook with their own evaluation strategy. The base owns:

- Per-lane explicit writeXxx overrides (text, table, image, audio, video,
  questions, answers, documents, classifications).
- Streaming-aware buffering for the multi-call lanes (image, audio, video).
- Branch dispatch via `peer = self.instance.getInstance(nodeId)` plus
  `peer.writeXxx(...)` — no state on the C++ binder, no AutoGatingMixin
  magic.
"""

from .IInstance import IInstance, FlowBaseIInstance

__all__ = ['IInstance', 'FlowBaseIInstance']
