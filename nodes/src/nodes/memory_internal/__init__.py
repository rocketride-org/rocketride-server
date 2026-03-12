# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Memory (Internal) tool node for RocketRide Engine.

Exposes:
- IGlobal: creates the MemoryDriver on pipe open
- IInstance: delegates tool invoke to the driver
"""

from .IGlobal import IGlobal as IGlobal
from .IInstance import IInstance as IInstance

__all__ = ['IGlobal', 'IInstance']
