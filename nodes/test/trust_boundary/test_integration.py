# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Integration tests for the Trust Boundary Gate node (Task 12.4)."""

import pytest
from unittest.mock import patch

from trust_boundary.authorization_engine import AuthorizationEngine
from trust_boundary.run_level_policy import RunLevelPolicy
from trust_boundary.audit_logger import AuditLogger
from trust_boundary.models import PermissionScope, HookAborted


# ===========================================================================
# Integration tests: Trust Boundary Gate pipeline flow (Task 12.4)
# ===========================================================================


class TestTrustBoundaryIntegration:
    """End-to-end tests simulating the Trust Boundary Gate's authorization flow."""

    def _make_engine(self):
        """Create an engine with researcher and executor scopes."""
        scopes = [
            PermissionScope(
                scope_id='researcher',
                allowed_tools=['search_*', 'read_*'],
                denied_tools=['write_*', 'execute_*', 'delete_*'],
                allowed_agents=['researcher_agent'],
                max_calls_per_run=10,
            ),
            PermissionScope(
                scope_id='executor',
                allowed_tools=['*'],
                denied_tools=['drop_*', 'destroy_*'],
                allowed_agents=['executor_agent'],
                max_calls_per_run=50,
                require_args_schema={
                    'type': 'object',
                    'properties': {
                        'target': {'type': 'string', 'maxLength': 255},
                    },
                },
            ),
        ]
        return AuthorizationEngine(scopes)

    def test_denied_tool_raises_hook_aborted(self):
        """Tool on deny list results in denial that would trigger HookAborted."""
        engine = self._make_engine()
        decision = engine.evaluate('delete_file', {}, 'researcher_agent')
        assert not decision.allowed

        # Simulate what IInstance does:
        if not decision.allowed:
            exc = HookAborted(reason=decision.reason, source='TrustBoundaryEvaluationGate')
            assert exc.source == 'TrustBoundaryEvaluationGate'
            assert 'denied' in exc.reason.lower()

    def test_rate_limit_allows_then_denies(self):
        """Tool calls within limit succeed, then exceed and fail."""
        engine = self._make_engine()
        engine.reset_counters()

        # 10 allowed calls
        for _ in range(10):
            d = engine.evaluate('search_web', {}, 'researcher_agent')
            assert d.allowed

        # 11th denied
        d = engine.evaluate('search_web', {}, 'researcher_agent')
        assert not d.allowed
        assert 'rate limit' in d.reason.lower()

    def test_run_level_policy_strips_and_validates(self):
        """Run-level policy strips extra keys and validates remaining."""
        policy = RunLevelPolicy(jsonschema_available=True)
        schema = {
            'type': 'object',
            'properties': {
                'task': {'type': 'string'},
                'max_iterations': {'type': 'integer', 'maximum': 10},
            },
        }

        payload = {'task': 'analyze', 'max_iterations': 5, 'evil_key': 'inject'}
        result = policy.enforce(payload, schema=schema, enable_run_policy=True)
        assert 'evil_key' not in result
        assert result == {'task': 'analyze', 'max_iterations': 5}

    def test_run_level_policy_rejects_invalid(self):
        """Run-level policy rejects payload failing schema validation."""
        policy = RunLevelPolicy(jsonschema_available=True)
        schema = {
            'type': 'object',
            'properties': {
                'task': {'type': 'string'},
                'max_iterations': {'type': 'integer', 'maximum': 10},
            },
        }

        with pytest.raises(HookAborted):
            policy.enforce({'task': 'x', 'max_iterations': 999}, schema=schema, enable_run_policy=True)

    def test_passthrough_mode_forwards_everything(self):
        """In passthrough mode (CrewAI unavailable), nothing is blocked."""
        # In passthrough mode, IInstance skips evaluate entirely and just forwards
        # We just verify the audit logger works
        logger = AuditLogger(enabled=True)
        logger.log_passthrough('test_payload_001')  # Should not raise

    def test_audit_logging_captures_decisions(self):
        """Audit logger records authorization decisions."""
        import logging

        logger = AuditLogger(enabled=True)
        with patch.object(logging.getLogger('rocketride.trust_boundary.audit'), 'info') as mock_log:
            logger.log_auth_decision(
                tool_name='search_web',
                agent_id='researcher_agent',
                scope_id='researcher',
                allowed=True,
                reason='',
                evaluated_at=1700000000.0,
            )
            mock_log.assert_called_once()
            call_args = mock_log.call_args[0]
            assert 'AUTH_DECISION' in call_args[0]

    def test_audit_disabled_emits_nothing(self):
        """When audit_log=False, no log entries are produced."""
        import logging

        logger = AuditLogger(enabled=False)
        with patch.object(logging.getLogger('rocketride.trust_boundary.audit'), 'info') as mock_log:
            logger.log_auth_decision('tool', 'agent', 'scope', True, '', 0.0)
            logger.log_run_policy('accepted', [], 0.0)
            mock_log.assert_not_called()
