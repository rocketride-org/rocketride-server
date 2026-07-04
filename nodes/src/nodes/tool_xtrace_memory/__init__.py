# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
xTrace Memory node for RocketRide Engine.

Exposes shared, persistent agent memory (remember / recall) backed by the
xTrace Memory Manager HTTP API via @tool_function decorators on IInstance.
"""

from .IGlobal import IGlobal as IGlobal
from .IInstance import IInstance as IInstance

__all__ = ['IGlobal', 'IInstance']
