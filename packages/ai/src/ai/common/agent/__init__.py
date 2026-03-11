"""
Agent framework base abstractions.

Public surface:
- AgentBase: the base class for agent framework drivers.

Schemas and contracts remain importable from `ai.common.agent.types`.
"""

from .agent import AgentBase
from ._internal.utils import extract_text, safe_str

__all__ = ['AgentBase', 'extract_text', 'safe_str']
