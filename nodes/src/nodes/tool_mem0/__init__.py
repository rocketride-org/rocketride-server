# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Mem0 node for RocketRide Engine.

Exposes long-term, shared agent memory (remember / recall) backed by the
hosted Mem0 Platform REST API, surfaced as @tool_function decorators on
IInstance.
"""

from .IGlobal import IGlobal as IGlobal
from .IInstance import IInstance as IInstance

__all__ = ['IGlobal', 'IInstance']
