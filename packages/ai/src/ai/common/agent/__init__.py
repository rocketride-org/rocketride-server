"""
Agent framework base abstractions.

Public surface:
- AgentBase: the base class for agent framework drivers.

Schemas and contracts remain importable from `ai.common.agent.types`.
"""

from .agent import AgentBase

__all__ = ['AgentBase']
