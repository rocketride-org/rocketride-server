"""Receiver of the call context probe (test only).

``whoami`` answers with the call context the engine attached to the call it is
running in; ``payload`` answers with a JSON body of about the requested size;
``dap_only`` is listed for external callers only, so it must never appear in an
agent's catalog.
"""

import dataclasses
from typing import Any, Dict

from rocketlib import IInstanceBase, tool_function

from .IGlobal import IGlobal

# Largest payload the probe builds, in bytes of JSON (the transport caps sit far above it).
PAYLOAD_MAX_BYTES = 16 * 1024 * 1024


def _input(args: Any) -> Dict[str, Any]:
    return args if isinstance(args, dict) else {}


class IInstance(IInstanceBase):
    """Tools that report what the engine attached to the call."""

    IGlobal: IGlobal

    @tool_function(
        input_schema={'type': 'object', 'properties': {}},
        description='Report the call context of this call (test probe).',
    )
    def whoami(self, args):
        """Return the call context, the input keys it received, and whether the context module loaded."""
        try:
            from ai.common.tool_context import current_tool_call
        except ImportError:
            return {'module': False, 'context': None, 'input_keys': sorted(_input(args))}
        ctx = current_tool_call()
        return {
            'module': True,
            'context': None if ctx is None else dataclasses.asdict(ctx),
            'input_keys': sorted(_input(args)),
        }

    @tool_function(
        input_schema={
            'type': 'object',
            'properties': {'bytes': {'type': 'integer', 'description': 'Approximate JSON size to return.'}},
        },
        description='Return a JSON payload of about the requested size (test probe).',
        audience=('dap',),
    )
    def payload(self, args):
        """Return a columnar payload of 4-decimal floats of about ``bytes`` bytes of JSON."""
        try:
            requested = int(_input(args).get('bytes', 1024))
        except (TypeError, ValueError):
            requested = 1024
        requested = max(0, min(requested, PAYLOAD_MAX_BYTES))
        # json.dumps writes each value as '0.1234, ' (8 bytes).
        count = requested // 8
        values = [round((i % 10000) / 10000 + 0.0001, 4) for i in range(count)]
        return {'success': True, 'bytes_requested': requested, 'count': count, 'values': values}

    @tool_function(
        input_schema={'type': 'object', 'properties': {}},
        description='A tool listed for external callers only (test probe).',
        audience=('dap',),
    )
    def dap_only(self, args):
        """Answer that the call reached the tool."""
        return {'success': True, 'tool': 'dap_only'}
