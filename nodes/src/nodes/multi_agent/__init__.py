# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Multi-Agent orchestration node for RocketRide Engine.

Exposes:
- IGlobal: per-pipe orchestrator creation and configuration
- IInstance: per-request agent orchestration loop
"""

from .IGlobal import IGlobal as IGlobal
from .IInstance import IInstance as IInstance

__all__ = ['IGlobal', 'IInstance']
