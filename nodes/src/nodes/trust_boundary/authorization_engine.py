# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Permission-scoped authorization engine for tool calls and agent actions."""

import fnmatch
import time
from typing import Dict, List

from .models import AuthDecision, PermissionScope


class AuthorizationEngine:
    """Evaluates tool call contexts against configured permission scopes.

    Implements default-deny semantics: if no scope explicitly grants access,
    the call is denied. Deny lists always take precedence over allow lists.
    """

    def __init__(self, scopes: List[PermissionScope]) -> None:
        self.scopes = list(scopes)
        self._call_counts: Dict[str, int] = {}

    def reset_counters(self) -> None:
        """Reset per-run call counters. Called at the start of each execution run."""
        self._call_counts = {}

    def reload_scopes(self, scopes: List[PermissionScope]) -> None:
        """Hot-reload permission scopes without restarting the node."""
        self.scopes = list(scopes)

    def evaluate(self, tool_name: str, args: dict, agent_id: str) -> AuthDecision:
        """Evaluate a tool call against configured permission scopes.

        Checks in order: deny list → allow list → rate limit → args schema.
        Default-deny if no scope covers the agent or tool.
        """
        evaluated_at = time.time()

        # Find applicable scopes for this agent
        applicable_scopes = [
            s for s in self.scopes
            if agent_id in s.allowed_agents or "*" in s.allowed_agents
        ]

        if not applicable_scopes:
            return AuthDecision(
                allowed=False,
                reason=f"No permission scope covers agent '{agent_id}'",
                scope_id="__default_deny__",
                evaluated_at=evaluated_at,
            )

        for scope in applicable_scopes:
            # Check explicit deny first (deny takes precedence)
            if self._matches_pattern_list(tool_name, scope.denied_tools):
                return AuthDecision(
                    allowed=False,
                    reason=f"Tool '{tool_name}' is explicitly denied in scope '{scope.scope_id}'",
                    scope_id=scope.scope_id,
                    evaluated_at=evaluated_at,
                )

            # Check allow list
            if not self._matches_pattern_list(tool_name, scope.allowed_tools):
                continue  # This scope doesn't cover this tool

            # Check rate limit
            if scope.max_calls_per_run > 0:
                call_count = self._get_call_count(scope.scope_id)
                if call_count >= scope.max_calls_per_run:
                    return AuthDecision(
                        allowed=False,
                        reason=(
                            f"Rate limit exceeded: {call_count}/{scope.max_calls_per_run} "
                            f"in scope '{scope.scope_id}'"
                        ),
                        scope_id=scope.scope_id,
                        evaluated_at=evaluated_at,
                    )

            # Check args schema if required
            if scope.require_args_schema:
                schema_error = self._validate_args_schema(args, scope.require_args_schema)
                if schema_error:
                    return AuthDecision(
                        allowed=False,
                        reason=schema_error,
                        scope_id=scope.scope_id,
                        evaluated_at=evaluated_at,
                    )

            # All checks passed for this scope — increment counter and allow
            self._increment_call_count(scope.scope_id)
            return AuthDecision(
                allowed=True,
                reason="",
                scope_id=scope.scope_id,
                evaluated_at=evaluated_at,
            )

        return AuthDecision(
            allowed=False,
            reason=f"No scope grants access to tool '{tool_name}' for agent '{agent_id}'",
            scope_id="__no_match__",
            evaluated_at=evaluated_at,
        )

    def _matches_pattern_list(self, tool_name: str, patterns: List[str]) -> bool:
        """Check if tool_name matches any glob pattern in the list.

        Uses fnmatch semantics (case-sensitive, supports * and ?).
        """
        for pattern in patterns:
            if fnmatch.fnmatchcase(tool_name, pattern):
                return True
        return False

    def _get_call_count(self, scope_id: str) -> int:
        """Get current call count for a scope in this run."""
        return self._call_counts.get(scope_id, 0)

    def _increment_call_count(self, scope_id: str) -> None:
        """Increment call counter for a scope (only called on authorization)."""
        self._call_counts[scope_id] = self._call_counts.get(scope_id, 0) + 1

    def _validate_args_schema(self, args: dict, schema: dict) -> str:
        """Validate tool args against a JSON Schema.

        Returns empty string if valid, or an error message if invalid.
        Fail-closed: rejects call when jsonschema is unavailable or schema is malformed.
        """
        try:
            import jsonschema
        except ImportError:
            return 'jsonschema library unavailable; tool call denied (fail-closed)'

        try:
            jsonschema.validate(
                args, schema,
                format_checker=jsonschema.FormatChecker(),
            )
        except jsonschema.ValidationError as e:
            path = '.'.join(str(p) for p in e.absolute_path) if e.absolute_path else '(root)'
            return f"Tool args schema violation at '{path}': {e.message}"
        except jsonschema.SchemaError as e:
            return f'Malformed require_args_schema: {e.message}'

        return ''
