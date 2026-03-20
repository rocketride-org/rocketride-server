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

    The tool name is namespaced by the pipeline component id so it remains unique
    per connected agent node.
    """

    def __init__(self, *, agent: Any, pSelf: Any):
        self._agent = agent
        self._pSelf = pSelf
        self._full_name = f'{self.unique_agent_tool_name()}.{getattr(self._agent, "_AGENT_TOOL_NAME", "run_agent")}'
        self._tools_available: Optional[List[Tuple[str, str]]] = None

        # Build a human-readable summary from the agent's instructions so the
        # tool descriptor is meaningful to LLMs and they can distinguish between
        # multiple agent tools.
        self._agent_summary: str = ''
        try:
            instructions = getattr(self._agent, '_instructions', None)
            # instructions may be a Python list or an IJson C++ wrapper.
            # Convert to a plain list to normalize access.
            if instructions is not None and not isinstance(instructions, (list, str)):
                try:
                    instructions = list(instructions)
                except Exception:
                    instructions = [str(instructions)]
            if isinstance(instructions, str):
                instructions = [instructions]
            if instructions:
                first = str(instructions[0]).strip()
                if first:
                    dot = first.find('.')
                    self._agent_summary = first[: dot + 1] if 0 < dot < 200 else first[:200]
        except Exception:
            pass

    def unique_agent_tool_name(self) -> str:
        """Return the unique tool namespace for this agent node instance."""
        inst = self._pSelf.instance
        pipe_type = inst.pipeType
        pipe_id = pipe_type.get('id') if isinstance(pipe_type, dict) else pipe_type.id
        return str(pipe_id)

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
                # Filter out this agent's own .run_agent entry (self-reference).
                if name.strip() == self._full_name:
                    continue
                desc = t.get('description', '')
                if not isinstance(desc, str):
                    desc = ''
                # Truncate description to first sentence to prevent recursive
                # blowup — each agent's description can include sub-agent
                # descriptions, which include their sub-agents, etc.
                dot = desc.find('. ')
                short_desc = desc[: dot + 1].strip() if 0 < dot < 120 else desc[:120].strip()
                tools_available.append((name, short_desc))
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
        # Accept common LLM variations for the query field
        query = payload.get('query') or payload.get('content') or payload.get('input') or payload.get('message')
        if isinstance(query, dict):
            # LLM may have passed a JSON object as the query — serialize it
            import json as _json

            query = _json.dumps(query, default=str)
        if not isinstance(query, str) or not query.strip():
            raise ValueError('agent tool: input.query must be a non-empty string')
        # Accept common LLM variations for the context field
        ctx = payload.get('context') or payload.get('meta') or payload.get('metadata')
        if ctx is not None and not isinstance(ctx, dict):
            ctx = None
        return query, ctx

    def _validate_request(self, *, tool_name: str, input_obj: Any) -> None:  # noqa: ANN401
        """Validate tool selection and required input fields."""
        if tool_name != self._full_name:
            raise ValueError(f'agent tool: unknown tool_name {tool_name!r}')
        query, _ = self._parse_input(input_obj)
        if not query.strip():
            raise ValueError('agent tool: input.query must be a non-empty string')

    def _tool_query(self) -> List[ToolsBase.ToolDescriptor]:
        """Return the single tool descriptor that exposes this agent."""
        tools_available = self._connected_tools_available()
        # Build a meaningful description including a summary of the agent's
        # instructions so LLMs can distinguish between multiple agent tools.
        summary = f' This agent: {self._agent_summary}' if self._agent_summary else ''
        desc = f'Invoke this agent as a tool.{summary} Input: {{query: string, context?: object}}. Output: {{content, meta, stack}}.'
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
