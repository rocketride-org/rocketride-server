# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

from ai.common.database import DatabaseInstanceBase
from .IGlobal import IGlobal


class IInstance(DatabaseInstanceBase):
    """PostgreSQL-specific instance.

    All tool methods and lane handlers are inherited from DatabaseInstanceBase.
    """

    IGlobal: IGlobal

    def _db_display_name(self) -> str:
        return 'PostgreSQL'
