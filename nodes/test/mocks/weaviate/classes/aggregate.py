# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Mock Weaviate aggregate classes.
"""

from dataclasses import dataclass
from typing import Optional


@dataclass
class GroupByAggregate:
    """Group an aggregate by a property (``weaviate.classes.aggregate.GroupByAggregate``)."""

    prop: str
    limit: Optional[int] = None


__all__ = ['GroupByAggregate']
