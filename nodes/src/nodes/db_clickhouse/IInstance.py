# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

from ai.common.database import DatabaseInstanceBase
from .IGlobal import IGlobal


class IInstance(DatabaseInstanceBase):
    """ClickHouse-specific instance.

    All tool methods and lane handlers are inherited from DatabaseInstanceBase.
    """

    IGlobal: IGlobal

    def _db_display_name(self) -> str:
        """Return the human-readable database name used in tool descriptions."""
        return 'ClickHouse'

    def _db_dialect(self) -> str:
        """Return the machine-readable dialect identifier surfaced by the `dialect` tool function."""
        return 'clickhouse'

    def _sessionsAreTransactions(self) -> bool:
        """Return False: a ClickHouse session reserves a connection but holds no transaction.

        clickhouse-sqlalchemy's native connector makes `commit` and `rollback`
        no-ops, and ClickHouse has no savepoints, so every statement sent on a
        session is executed when it is sent and nothing can undo it.
        """
        return False
