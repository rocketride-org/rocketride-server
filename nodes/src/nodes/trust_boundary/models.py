# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Data models for the Trust Boundary Evaluation Gate node."""

from dataclasses import dataclass, field
from typing import Optional


@dataclass
class PermissionScope:
    """A configured permission scope for tool/agent authorization."""

    scope_id: str
    allowed_tools: list  # Glob patterns
    denied_tools: list  # Glob patterns
    allowed_agents: list  # Agent IDs or "*" for wildcard
    max_calls_per_run: int = 0  # 0 = unlimited
    require_args_schema: Optional[dict] = None  # JSON Schema draft-07
    description: str = ""


@dataclass
class AuthDecision:
    """Result of authorization evaluation."""

    allowed: bool
    reason: str  # Empty if allowed; explanation if denied
    scope_id: str  # Which scope made the decision
    evaluated_at: float  # time.time() of evaluation


@dataclass
class ToolCallHookContext:
    """Context passed to PRE_TOOL_CALL hooks by the agent framework."""

    tool_name: str
    tool_args: dict
    agent_id: str
    crew_id: str = ""
    task_id: str = ""
    call_index: int = 0


@dataclass
class TrustBoundaryConfig:
    """Trust Boundary Evaluation Gate .pipe configuration."""

    enable_tool_interception: bool = True
    enable_run_policy: bool = False
    permission_scopes: list = field(default_factory=list)
    abort_on_unauthorized: bool = True
    audit_log: bool = True
    payload_schema: Optional[dict] = None


class HookAborted(Exception):
    """Raised to block unauthorized tool calls or invalid payloads."""

    def __init__(self, reason: str, source: str = 'TrustBoundaryEvaluationGate'):
        self.reason = reason
        self.source = source
        super().__init__(f'[{source}] {reason}')
