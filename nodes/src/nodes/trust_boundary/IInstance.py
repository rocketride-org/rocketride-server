# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Per-stream instance for the Trust Boundary Evaluation Gate node."""

from rocketlib import IInstanceBase, Entry, warning
from ai.common.schema import Question

from .IGlobal import IGlobal
from .models import HookAborted, ToolCallHookContext


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    def open(self, entry: Entry):
        """Reset per-run call counters and wire the hook to this instance."""
        if self.IGlobal.auth_engine:
            self.IGlobal.auth_engine.reset_counters()
        # Wire the hook to this active instance for delegation
        hook = self.IGlobal.get_hook()
        if hook is not None:
            hook._instance = self

    def writeQuestions(self, question: Question):
        """Forward questions downstream.

        Primary filtering is done via lifecycle hooks (PRE_TOOL_CALL).
        In passthrough mode, all questions are forwarded with audit logging.
        """
        config = self.IGlobal.config
        audit_logger = self.IGlobal.audit_logger

        if self.IGlobal.passthrough_mode:
            if audit_logger:
                audit_logger.log_passthrough()
            self.instance.writeQuestions(question)
            return

        self.instance.writeQuestions(question)

    def evaluate_tool_call(self, context: ToolCallHookContext) -> None:
        """Evaluate a tool call against permission scopes.

        Called by the TrustBoundaryHook on PRE_TOOL_CALL events.
        Raises HookAborted if unauthorized and abort_on_unauthorized is true.
        """
        config = self.IGlobal.config
        auth_engine = self.IGlobal.auth_engine
        audit_logger = self.IGlobal.audit_logger

        if not config or not auth_engine:
            return

        if not config.enable_tool_interception:
            return

        if self.IGlobal.passthrough_mode:
            if audit_logger:
                audit_logger.log_passthrough(context.tool_name)
            return

        decision = auth_engine.evaluate(
            tool_name=context.tool_name,
            args=context.tool_args,
            agent_id=context.agent_id,
        )

        # Log the decision
        if audit_logger:
            audit_logger.log_auth_decision(
                tool_name=context.tool_name,
                agent_id=context.agent_id,
                scope_id=decision.scope_id,
                allowed=decision.allowed,
                reason=decision.reason,
                evaluated_at=decision.evaluated_at,
            )

        if not decision.allowed:
            if config.abort_on_unauthorized:
                exc = HookAborted(
                    reason=decision.reason,
                    source="TrustBoundaryEvaluationGate",
                )
                # Try to raise as HookAborted; wrap in RuntimeError as fallback
                try:
                    raise exc
                except HookAborted:
                    raise
            else:
                warning(
                    f"[TrustBoundary] Denied (non-blocking): {context.tool_name} "
                    f"by {context.agent_id} — {decision.reason}"
                )

    def enforce_run_policy(self, payload: dict) -> dict:
        """Enforce run-level policy on the initial execution payload.

        Called at EXECUTION_START. Returns sanitized payload.
        Raises HookAborted if payload fails validation.
        """
        import time

        config = self.IGlobal.config
        run_policy = self.IGlobal.run_level_policy
        audit_logger = self.IGlobal.audit_logger

        if not config or not run_policy:
            return payload

        evaluated_at = time.time()

        try:
            sanitized = run_policy.enforce(
                payload=payload,
                schema=config.payload_schema,
                enable_run_policy=config.enable_run_policy,
            )

            # Determine outcome for logging
            if sanitized == payload:
                outcome = "accepted"
                stripped_keys = []
            else:
                outcome = "modified"
                stripped_keys = [k for k in payload if k not in sanitized] if isinstance(payload, dict) else []

            if audit_logger:
                audit_logger.log_run_policy(
                    outcome=outcome,
                    stripped_keys=stripped_keys,
                    evaluated_at=evaluated_at,
                )

            return sanitized

        except HookAborted:
            if audit_logger:
                audit_logger.log_run_policy(
                    outcome="rejected",
                    stripped_keys=None,
                    evaluated_at=evaluated_at,
                )
            raise

    def close(self):
        """Clean up per-object state."""
        pass
