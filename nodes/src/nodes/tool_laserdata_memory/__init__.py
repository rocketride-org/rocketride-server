# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
LaserData memory node for RocketRide Engine.

Exposes durable, shared agent memory (remember / recall / improve / forget)
backed by LaserData (Apache Iggy) via the async Laser SDK, surfaced as
@tool_function decorators on IInstance.
"""

from .IGlobal import IGlobal as IGlobal
from .IInstance import IInstance as IInstance

__all__ = ['IGlobal', 'IInstance']
