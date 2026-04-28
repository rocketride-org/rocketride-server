# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""flow_if_else_llm — two-branch conditional router whose decision is made by an LLM.

Same routing scaffolding as ``flow_if_else`` (per-chunk gate, branch
fan-out, streaming-aware buffering of writeImage/writeAudio/writeVideo
sequences via ``AutoGatingMixin``), but the condition is a
**natural-language yes/no question** evaluated by a wired LLM instead of
a sandboxed Python expression.

Use cases the sandbox can't cover:

- *"Is this image a screenshot of code?"* — semantic image classification.
- *"Is this text an invoice?"* — semantic text classification beyond
  keyword matching.
- *"Does this audio transcript discuss pricing?"* — content-aware
  routing where regex / keywords aren't enough.

Trade-offs vs. ``flow_if_else``:

- Latency: sub-millisecond → seconds (network + inference).
- Cost: free → tokens billed per chunk.
- Determinism: 100% reproducible → probabilistic.

Pick this node only when the routing decision genuinely requires
language understanding. For format checks, size thresholds, regex,
keyword presence, etc., ``flow_if_else`` is the right tool.
"""

from .IGlobal import IGlobal
from .IInstance import IInstance
from .driver import IfElseLLMDriver

__all__ = ['IGlobal', 'IInstance', 'IfElseLLMDriver']
