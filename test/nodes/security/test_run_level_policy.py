# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Property tests for Run-Level Policy (Properties 16-17) and Abort Behavior (Property 18)."""

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from trust_boundary.run_level_policy import RunLevelPolicy
from trust_boundary.models import HookAborted


# ---------------------------------------------------------------------------
# Property 16: Run-Level Policy Strict Sanitization
# Validates: Requirements 9.1, 9.2, 9.3
# ---------------------------------------------------------------------------

class TestRunLevelPolicySanitization:
    """Sanitized output only contains schema-defined keys; invalid payloads raise HookAborted."""

    def test_unknown_keys_stripped(self):
        """Keys not in schema properties are removed."""
        policy = RunLevelPolicy(jsonschema_available=True)
        schema = {
            'type': 'object',
            'properties': {
                'task': {'type': 'string'},
                'context': {'type': 'string'},
            },
        }
        payload = {'task': 'hello', 'context': 'world', 'secret': 'bad', 'extra': 123}
        result = policy.enforce(payload, schema=schema, enable_run_policy=True)
        assert 'secret' not in result
        assert 'extra' not in result
        assert result == {'task': 'hello', 'context': 'world'}

    def test_nested_unknown_keys_stripped(self):
        """Unknown keys are stripped recursively at nested levels."""
        policy = RunLevelPolicy(jsonschema_available=True)
        schema = {
            'type': 'object',
            'properties': {
                'config': {
                    'type': 'object',
                    'properties': {
                        'name': {'type': 'string'},
                    },
                },
            },
        }
        payload = {'config': {'name': 'test', 'hidden': 'value'}, 'extra': 1}
        result = policy.enforce(payload, schema=schema, enable_run_policy=True)
        assert result == {'config': {'name': 'test'}}

    def test_array_of_objects_stripped(self):
        """Unknown keys inside array objects are stripped."""
        policy = RunLevelPolicy(jsonschema_available=True)
        schema = {
            'type': 'object',
            'properties': {
                'items': {
                    'type': 'array',
                    'items': {
                        'type': 'object',
                        'properties': {
                            'name': {'type': 'string'},
                        },
                    },
                },
            },
        }
        payload = {'items': [{'name': 'a', 'secret': 'bad'}, {'name': 'b', 'hidden': 1}]}
        result = policy.enforce(payload, schema=schema, enable_run_policy=True)
        assert result == {'items': [{'name': 'a'}, {'name': 'b'}]}

    def test_nested_array_of_objects_stripped(self):
        """Unknown keys inside nested arrays of objects are stripped recursively."""
        policy = RunLevelPolicy(jsonschema_available=True)
        schema = {
            'type': 'object',
            'properties': {
                'groups': {
                    'type': 'array',
                    'items': {
                        'type': 'object',
                        'properties': {
                            'name': {'type': 'string'},
                            'members': {
                                'type': 'array',
                                'items': {
                                    'type': 'object',
                                    'properties': {
                                        'id': {'type': 'integer'},
                                    },
                                },
                            },
                        },
                    },
                },
            },
        }
        payload = {
            'groups': [
                {
                    'name': 'admin',
                    'members': [{'id': 1, 'secret': 'x'}, {'id': 2, 'hack': 'y'}],
                    'extra': 'bad',
                }
            ]
        }
        result = policy.enforce(payload, schema=schema, enable_run_policy=True)
        assert result == {'groups': [{'name': 'admin', 'members': [{'id': 1}, {'id': 2}]}]}

    def test_invalid_type_raises_hook_aborted(self):
        """Type mismatch raises HookAborted."""
        policy = RunLevelPolicy(jsonschema_available=True)
        schema = {
            'type': 'object',
            'properties': {
                'count': {'type': 'integer'},
            },
        }
        with pytest.raises(HookAborted) as exc_info:
            policy.enforce({'count': 'not_a_number'}, schema=schema, enable_run_policy=True)
        assert 'schema violation' in exc_info.value.reason.lower() or 'integer' in exc_info.value.reason.lower()

    def test_empty_payload_raises_hook_aborted(self):
        """Empty dict raises HookAborted."""
        policy = RunLevelPolicy(jsonschema_available=True)
        schema = {'type': 'object', 'properties': {'x': {'type': 'string'}}}
        with pytest.raises(HookAborted) as exc_info:
            policy.enforce({}, schema=schema, enable_run_policy=True)
        assert 'missing' in exc_info.value.reason.lower() or 'empty' in exc_info.value.reason.lower()

    def test_none_payload_raises_hook_aborted(self):
        """None payload raises HookAborted."""
        policy = RunLevelPolicy(jsonschema_available=True)
        schema = {'type': 'object', 'properties': {'x': {'type': 'string'}}}
        with pytest.raises(HookAborted):
            policy.enforce(None, schema=schema, enable_run_policy=True)

    def test_malformed_schema_raises_hook_aborted(self):
        """Invalid schema definition raises HookAborted."""
        policy = RunLevelPolicy(jsonschema_available=True)
        bad_schema = {'type': 'not_a_valid_type'}
        with pytest.raises(HookAborted) as exc_info:
            policy.enforce({'x': 1}, schema=bad_schema, enable_run_policy=True)
        assert 'malformed' in exc_info.value.reason.lower()


# ---------------------------------------------------------------------------
# Property 17: Run-Level Policy Passthrough
# Validates: Requirements 9.4, 9.5
# ---------------------------------------------------------------------------

class TestRunLevelPolicyPassthrough:
    """Payload passes through unmodified when policy disabled or no schema."""

    @given(payload=st.dictionaries(st.text(min_size=1, max_size=10), st.text(max_size=50), min_size=1, max_size=5))
    @settings(max_examples=100)
    def test_disabled_policy_passthrough(self, payload):
        """When enable_run_policy=False, payload is returned unchanged."""
        policy = RunLevelPolicy(jsonschema_available=True)
        result = policy.enforce(payload, schema={'type': 'object'}, enable_run_policy=False)
        assert result == payload

    @given(payload=st.dictionaries(st.text(min_size=1, max_size=10), st.text(max_size=50), min_size=1, max_size=5))
    @settings(max_examples=100)
    def test_no_schema_passthrough(self, payload):
        """When schema is None, payload is returned unchanged."""
        policy = RunLevelPolicy(jsonschema_available=True)
        result = policy.enforce(payload, schema=None, enable_run_policy=True)
        assert result == payload

    def test_jsonschema_unavailable_passthrough(self):
        """When jsonschema not available, payload passes through."""
        policy = RunLevelPolicy(jsonschema_available=False)
        payload = {'task': 'x', 'secret': 'bad'}
        schema = {'type': 'object', 'properties': {'task': {'type': 'string'}}}
        result = policy.enforce(payload, schema=schema, enable_run_policy=True)
        assert result == payload  # No stripping because jsonschema unavailable


# ---------------------------------------------------------------------------
# Property 18: Abort Behavior Correctness
# Validates: Requirements 10.1, 10.2
# ---------------------------------------------------------------------------

class TestAbortBehavior:
    """HookAborted carries the denial reason and source identifier."""

    def test_hook_aborted_has_reason_and_source(self):
        """HookAborted exception includes reason and source."""
        exc = HookAborted(reason="Tool denied", source="TrustBoundaryEvaluationGate")
        assert exc.reason == "Tool denied"
        assert exc.source == "TrustBoundaryEvaluationGate"
        assert "Tool denied" in str(exc)

    def test_run_policy_abort_has_source(self):
        """Run-level policy HookAborted has correct source."""
        policy = RunLevelPolicy(jsonschema_available=True)
        schema = {'type': 'object', 'properties': {'x': {'type': 'string'}}}
        with pytest.raises(HookAborted) as exc_info:
            policy.enforce({'x': 123}, schema=schema, enable_run_policy=True)
        assert exc_info.value.source == "TrustBoundaryEvaluationGate"
