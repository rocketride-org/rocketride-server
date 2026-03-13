# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Memory (Internal) tool node — global (per-pipe) state.
"""

from __future__ import annotations

from rocketlib import IGlobalBase


class IGlobal(IGlobalBase):
    """Global state for memory_internal — nothing to hold at the pipe level."""
