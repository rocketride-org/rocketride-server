# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Structured audit logging for Trust Boundary authorization decisions."""

import logging
from datetime import datetime, timezone
from typing import List, Optional

logger = logging.getLogger("rocketride.trust_boundary.audit")


class AuditLogger:
    """Emits structured audit log entries for authorization decisions and run-level policy.

    All entries are emitted at INFO level so they are not suppressed by default config.
    Respects the audit_log toggle — emits nothing when disabled.
    """

    def __init__(self, enabled: bool = True):
        self.enabled = enabled

    def log_auth_decision(
        self,
        tool_name: str,
        agent_id: str,
        scope_id: str,
        allowed: bool,
        reason: str,
        evaluated_at: float,
    ) -> None:
        """Log an authorization decision for a tool call."""
        if not self.enabled:
            return

        ts = datetime.fromtimestamp(evaluated_at, tz=timezone.utc).isoformat()
        # Truncate reason to 500 chars
        truncated_reason = reason[:500] if reason else ""

        logger.info(
            "AUTH_DECISION | tool=%s | agent=%s | scope=%s | allowed=%s | reason=%s | at=%s",
            tool_name,
            agent_id,
            scope_id,
            allowed,
            truncated_reason,
            ts,
        )

    def log_run_policy(
        self,
        outcome: str,
        stripped_keys: Optional[List[str]] = None,
        evaluated_at: float = 0.0,
    ) -> None:
        """Log a run-level policy enforcement result.

        Args:
            outcome: "accepted", "modified", or "rejected"
            stripped_keys: Keys removed during sanitization
            evaluated_at: Timestamp of evaluation
        """
        if not self.enabled:
            return

        ts = datetime.fromtimestamp(evaluated_at, tz=timezone.utc).isoformat() if evaluated_at else "N/A"
        keys_str = ", ".join(stripped_keys) if stripped_keys else "none"

        logger.info(
            "RUN_POLICY | outcome=%s | stripped_keys=%s | at=%s",
            outcome,
            keys_str,
            ts,
        )

    def log_passthrough(self, payload_id: str = "") -> None:
        """Log a passthrough event in degraded mode."""
        if not self.enabled:
            return

        ts = datetime.now(tz=timezone.utc).isoformat()
        logger.info(
            "PASSTHROUGH | payload_id=%s | at=%s",
            payload_id or "unknown",
            ts,
        )
