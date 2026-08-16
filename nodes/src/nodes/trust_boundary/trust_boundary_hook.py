# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""CrewAI lifecycle hook for the Trust Boundary Evaluation Gate.

This module provides the TrustBoundaryHook class that integrates with CrewAI's
lifecycle interception system. It is only imported/used when CrewAI is available.
"""

from .models import ToolCallHookContext, HookAborted

try:
    from crewai.security import on, InterceptionPoint
except ImportError:
    # Stubs for environments without CrewAI
    class InterceptionPoint:
        PRE_TOOL_CALL = "pre_tool_call"
        EXECUTION_START = "execution_start"

    def on(interception_point):
        """No-op decorator when CrewAI is not available."""
        def decorator(func):
            return func
        return decorator


class TrustBoundaryHook:
    """CrewAI lifecycle hook implementing PRE_TOOL_CALL and EXECUTION_START.

    Delegates authorization decisions to the AuthorizationEngine via the
    IInstance. This hook is registered by IGlobal.beginGlobal when CrewAI
    is available.
    """

    def __init__(self, instance):
        """Initialize with a reference to the IInstance for delegation.

        Args:
            instance: The Trust Boundary IInstance that handles authorization.
        """
        self._instance = instance

    @on(InterceptionPoint.PRE_TOOL_CALL)
    def on_pre_tool_call(self, context) -> None:
        """Intercept tool calls and enforce authorization policy.

        Args:
            context: CrewAI ToolCallHookContext with tool_name, tool_args, agent_id.

        Raises:
            HookAborted: If the tool call is unauthorized and abort_on_unauthorized is True.
        """
        hook_context = ToolCallHookContext(
            tool_name=getattr(context, 'tool_name', ''),
            tool_args=getattr(context, 'tool_args', {}),
            agent_id=getattr(context, 'agent_id', ''),
            crew_id=getattr(context, 'crew_id', ''),
            task_id=getattr(context, 'task_id', ''),
            call_index=getattr(context, 'call_index', 0),
        )

        self._instance.evaluate_tool_call(hook_context)

    @on(InterceptionPoint.EXECUTION_START)
    def on_execution_start(self, context) -> None:
        """Enforce run-level policy at execution start.

        Sanitizes the initial payload by stripping unknown keys and
        validating against the configured schema.

        Args:
            context: CrewAI ExecutionContext with initial_payload attribute.

        Raises:
            HookAborted: If payload fails schema validation.
        """
        if hasattr(context, 'initial_payload'):
            payload = context.initial_payload
            if isinstance(payload, dict):
                sanitized = self._instance.enforce_run_policy(payload)
                context.initial_payload = sanitized
