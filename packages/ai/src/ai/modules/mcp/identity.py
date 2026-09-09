# Copyright 2026 Aparavi Software AG. MIT License.
"""Per-request caller identity for /mcp.

The ASGI mount stashes the caller's bearer credential (auth.authorize) and
sets CALLER_AUTH for the duration of the request; engine_factory reads it to
build a per-caller engine client (the task_http pattern - see
modules/task_http/task_status.py). No credential => the configured singleton,
byte-identical to the pre-integrations behavior.
"""

from contextvars import ContextVar
from typing import Any, Optional

CALLER_AUTH: ContextVar[Optional[str]] = ContextVar('mcp_caller_auth', default=None)
REQUEST_CLIENTS: ContextVar[Optional[list]] = ContextVar('mcp_request_clients', default=None)


def credential_from_scope(scope: Any) -> Optional[str]:
    """Extract the stashed caller credential from an ASGI scope.

    Args:
        scope: The ASGI connection scope.

    Returns:
        Optional[str]: The stashed mcp_credential, or None when absent or scope
            is not a dict.
    """
    state = scope.get('state') if isinstance(scope, dict) else None
    if not isinstance(state, dict):
        return None
    return state.get('mcp_credential')
