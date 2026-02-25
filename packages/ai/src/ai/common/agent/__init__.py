"""
Agent framework base abstractions.

Public surface:
- Agent: the base class for agent framework drivers.

Schemas/types remain importable from `ai.common.agent.types`
"""

from .agent import Agent

__all__ = ['Agent']
