# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
RocketRide Wave node for RocketRide Engine.

Exposes:
- IGlobal: dependency bootstrap and configuration
- IInstance: pipeline adapter implementing the agent run loop
"""

from .IGlobal import IGlobal as IGlobal
from .IInstance import IInstance as IInstance

__all__ = ['IGlobal', 'IInstance']
