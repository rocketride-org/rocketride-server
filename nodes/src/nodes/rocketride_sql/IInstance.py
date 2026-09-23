# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

from ai.common.database import DatabaseInstanceBase
from .IGlobal import IGlobal


class IInstance(DatabaseInstanceBase):
    """RocketRide cloud SQL instance.

    All tool methods and lane handlers — including the raw EXECUTE path — are
    inherited from DatabaseInstanceBase. The only per-driver knowledge is the
    display name and dialect (the tenant database is PostgreSQL).
    """

    IGlobal: IGlobal

    def _db_display_name(self) -> str:
        return 'RocketRide SQL'

    def _db_dialect(self) -> str:
        return 'postgres'
