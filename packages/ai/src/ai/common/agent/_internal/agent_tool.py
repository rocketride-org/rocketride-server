"""
Agent-as-tool adapter.

Exposes an `AgentBase` instance through the `ToolsBase` control-plane surface so
other agents (or frameworks) can invoke an agent via `tool.invoke`.
"""

from __future__ import annotations

import json
from typing import Any, Dict, List, Optional, Tuple

from ai.common.schema import Question
from ai.common.tools import ToolsBase
from rocketlib import ToolDescriptor

from .host import AgentHostServices
from .utils import normalize_invocation_payload


def handle_agent_tool_invoke(*, agent: Any, pSelf: Any, param: Any) -> Any:
    """
    Handle the agent-as-tool control-plane operations.

    This is a thin wrapper around `ToolsBase.handle_invoke()` that keeps agent
    tool error prefixes stable (`agent tool: ...`).
    """
    op = param.get('op') if isinstance(param, dict) else getattr(param, 'op', None)
    if not isinstance(op, str) or not op:
        raise ValueError('agent tool: missing op')

    try:
        return _AgentAsToolProvider(agent=agent, pSelf=pSelf).handle_invoke(param)
    except ValueError as e:
        msg = str(e)
        if msg.startswith('tools: '):
            raise ValueError('agent tool: ' + msg[len('tools: ') :]) from None
        raise


class _AgentAsToolProvider(ToolsBase):
    """
    `ToolsBase` implementation that routes tool calls into `agent.run_agent(...)`.

    Emits a bare tool name; `AgentHostServices.Tools` handles node-id
    namespacing so each agent instance is unique in the tool catalog.
    """

    def __init__(self, *, agent: Any, pSelf: Any):
        self._agent = agent
        self._pSelf = pSelf
        self._full_name = getattr(self._agent, '_AGENT_TOOL_NAME', 'run_agent')
        self._tools_available: Optional[List[Tuple[str, str]]] = None

    def _connected_tools_available(self) -> List[Tuple[str, str]]:
        """
        Return a cached list of (name, description) for non-agent tools visible to this agent.

        This is used for operator visibility in the tool description and is not
        required for tool invocation.
        """
        if self._tools_available is not None:
            return self._tools_available
        try:
            host = AgentHostServices(self._pSelf)
            tools = self._agent.discover_tools(host=host)
            tools_available = []
            for t in tools:
                name = t.get('name', '')
                if not isinstance(name, str) or not name.strip():
                    continue
                if name.strip() == 'run_agent' or name.strip().endswith('.run_agent'):
                    continue
                desc = t.get('description', '')
                tools_available.append((name, desc if isinstance(desc, str) else ''))
        except Exception:
            tools_available = []
        self._tools_available = tools_available
        return tools_available

    def _parse_input(self, input_obj: Any) -> tuple[str, Optional[Dict[str, Any]]]:  # noqa: ANN401
        """
        Parse and validate the tool input payload.

        Supported payloads include direct objects as well as `{ "input": ... }`
        wrappers (handled by `normalize_invocation_payload`).
        """
        payload = normalize_invocation_payload(input=input_obj)
        if not isinstance(payload, dict):
            raise ValueError('agent tool: input must be an object')
        query = payload.get('query')
        if not isinstance(query, str):
            raise ValueError('agent tool: input.query must be a string')
        ctx = payload.get('context')
        if ctx is None:
            return query, None
        if not isinstance(ctx, dict):
            raise ValueError('agent tool: input.context must be an object if provided')
        return query, ctx

    def _validate_request(self, *, tool_name: str, input_obj: Any) -> None:  # noqa: ANN401
        """Validate tool selection and required input fields."""
        if tool_name != self._full_name:
            raise ValueError(f'agent tool: unknown tool_name {tool_name!r}')
        query, _ = self._parse_input(input_obj)
        if not query.strip():
            raise ValueError('agent tool: input.query must be a non-empty string')

    def _tool_query(self) -> List[ToolDescriptor]:
        """Return the single tool descriptor that exposes this agent."""
        tools_available = self._connected_tools_available()
        agent_description = getattr(self._agent, '_agent_description', '') or ''
        base = 'Invoke this agent as a tool. Input: {query: string, context?: object}. Output: {content, meta, stack}.'
        desc = f'This agent: {agent_description} {base}' if agent_description else base
        if tools_available:
            parts = [f'{n}: {d}' if d else n for n, d in tools_available]
            desc = f'{desc} Tools available to this agent: {"; ".join(parts)}.'
        else:
            desc = f'{desc} Tools available to this agent: (none).'

        descriptor = {
            'name': self._full_name,
            'description': desc,
            'inputSchema': {
                'type': 'object',
                'properties': {
                    'query': {'type': 'string', 'description': 'Query string for the agent (required)'},
                    'context': {'type': 'object', 'description': 'Optional caller-provided context'},
                },
                'required': ['query'],
            },
            'outputSchema': {
                'type': 'object',
                'description': 'Agent answer JSON payload',
                'properties': {
                    'content': {'type': 'string', 'description': 'Final user-facing answer text'},
                    'meta': {
                        'type': 'object',
                        'description': 'Run metadata',
                        'properties': {
                            'framework': {'type': 'string'},
                            'agent_id': {'type': 'string'},
                            'run_id': {'type': 'string'},
                            'task_id': {'type': 'string'},
                            'started_at': {'type': 'string'},
                            'ended_at': {'type': 'string'},
                        },
                        'required': ['framework', 'agent_id', 'run_id', 'started_at', 'ended_at'],
                    },
                    'stack': {'type': 'array', 'items': {'type': 'object'}, 'description': 'Run trace stack'},
                },
                'required': ['content', 'meta', 'stack'],
            },
        }
        return [descriptor]

    def _tool_validate(self, *, tool_name: str, input_obj: Any) -> None:
        """Validate an invocation request without executing the agent."""
        self._validate_request(tool_name=tool_name, input_obj=input_obj)

    def _tool_invoke(self, *, tool_name: str, input_obj: Any) -> Any:
        """Invoke the agent with a `Question` built from the provided query/context."""
        self._tool_validate(tool_name=tool_name, input_obj=input_obj)

        query, ctx = self._parse_input(input_obj)
        q = Question(role='')
        q.addQuestion(query)
        if ctx is not None:
            try:
                q.addContext(json.dumps({'type': 'RocketRide.agent.tool_context.v1', 'context': ctx}, default=str))
            except Exception:
                pass

        return self._agent.run_agent(self._pSelf, q, emit_answers_lane=False)
