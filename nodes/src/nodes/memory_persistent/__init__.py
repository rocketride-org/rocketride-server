# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Persistent Memory pipeline node for RocketRide Engine.

Exposes:
- IGlobal: creates the PersistentMemoryStore on pipe open
- IInstance: attaches session context to questions, stores answers
"""

from .IGlobal import IGlobal as IGlobal
from .IInstance import IInstance as IInstance

__all__ = ['IGlobal', 'IInstance']
