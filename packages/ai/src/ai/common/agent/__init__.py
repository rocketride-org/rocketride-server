"""
Agent framework base abstractions.

Public surface:
- AgentBase: the base class for agent framework drivers.
- AgentContext: per-call run scaffolding threaded through `_run`,
  `call_llm`, `call_tool`, and `sendSSE`.

Schemas and contracts remain importable from `ai.common.agent.types`.
"""

from .agent import AgentBase
from ._internal.host import AgentContext
from ._internal.utils import extract_text, safe_str

__all__ = ['AgentBase', 'AgentContext', 'extract_text', 'safe_str']
