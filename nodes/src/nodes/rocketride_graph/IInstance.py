# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

from ai.common.graph import GraphInstanceBase
from .IGlobal import IGlobal


class IInstance(GraphInstanceBase):
    """RocketRide cloud graph instance.

    All tool methods (get_data, get_schema, get_query, execute, dialect) and
    lane handlers are inherited from GraphInstanceBase; the Cypher->AGE
    translation lives entirely behind IGlobal's query hooks. The tool surface
    speaks Cypher to callers, so _query_language stays the base default.
    """

    IGlobal: IGlobal

    def _db_display_name(self) -> str:
        return 'RocketRide Graph'

    def _db_dialect(self) -> str:
        return 'age'
