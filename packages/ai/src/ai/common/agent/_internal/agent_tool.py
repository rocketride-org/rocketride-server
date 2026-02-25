from __future__ import annotations

import json
from typing import Any, Dict, List, Optional, Tuple

from ai.common.schema import Question
from ai.common.tools import ToolsBase

from .host import AgentHostServices
from .utils import is_agent_run_tool_name, normalize_invocation_payload


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
        return make_agent_as_tool_provider(agent=agent, pSelf=pSelf).handle_invoke(param)
    except ValueError as e:
        msg = str(e)
        if msg.startswith('tools: '):
            raise ValueError('agent tool: ' + msg[len('tools: ') :]) from None
        raise


def agent_tool_server_name(*, agent: Any, pSelf: Any) -> str:
    """Derive the tool server namespace for this agent instance."""
    try:
        inst = getattr(pSelf, 'instance', None)
        pipe_type = getattr(inst, 'pipeType', None) if inst is not None else None
        pipe_id = None
        if isinstance(pipe_type, dict):
            pipe_id = pipe_type.get('id')
        else:
            pipe_id = getattr(pipe_type, 'id', None)
        if pipe_id:
            return str(pipe_id)

        glb = getattr(pSelf, 'IGlobal', None)
        if glb and getattr(glb, 'glb', None) and getattr(glb.glb, 'logicalType', None):
            return str(glb.glb.logicalType)
    except Exception:
        pass
    return getattr(agent, '_agent_id')(pSelf) or getattr(agent, 'FRAMEWORK', None) or 'agent'


def agent_tool_full_name(*, agent: Any, pSelf: Any) -> str:
    """Return the fully-qualified tool name for this agent-as-tool."""
    return f'{agent_tool_server_name(agent=agent, pSelf=pSelf)}.{getattr(agent, "_AGENT_TOOL_NAME", "run_agent")}'


def discover_connected_tool_names(*, agent: Any, pSelf: Any) -> List[str]:
    """Discover connected host tool names for descriptor metadata (best-effort)."""
    try:
        host = AgentHostServices(pSelf.instance.invoke)
        return agent._discover_tool_names(host=host)
    except Exception:
        return []


def agent_tool_descriptor(*, agent: Any, pSelf: Any) -> Dict[str, Any]:
    """Build the tool descriptor for invoking this agent as a tool."""
    tools_available_all = discover_connected_tool_names(agent=agent, pSelf=pSelf)
    tools_available = [t for t in tools_available_all if not is_agent_run_tool_name(t)]

    desc = 'Invoke this agent as a tool. Input: {query: string, context?: object}. Output: AgentEnvelope.'
    if tools_available:
        tools_list = ', '.join(tools_available)
        desc = f'{desc} Tools available to this agent: {tools_list}.'
    else:
        desc = f'{desc} Tools available to this agent: (none).'

    return {
        'name': agent_tool_full_name(agent=agent, pSelf=pSelf),
        'description': desc,
        'input_schema': {
            'type': 'object',
            'properties': {
                'query': {'type': 'string', 'description': 'Query string for the agent (required)'},
                'context': {'type': 'object', 'description': 'Optional caller-provided context'},
            },
            'required': ['query'],
        },
        'output_schema': {
            'type': 'object',
            'description': 'AgentEnvelope',
            'properties': {
                'status': {'type': 'string'},
                'error': {'type': ['object', 'null']},
                'control': {'type': 'object'},
                'result': {'type': 'object'},
                'artifacts': {'type': 'array'},
                'meta': {'type': 'object'},
            },
            'required': ['status', 'result', 'meta'],
        },
        'tools_available': tools_available,
    }


def agent_tool_parse_input(input_obj: Any) -> Tuple[str, Optional[Dict[str, Any]]]:
    """Parse the agent-as-tool input payload into (query, optional_context)."""
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


def agent_tool_validate(*, agent: Any, pSelf: Any, server_name: str, tool_name: str, input_obj: Any) -> None:
    """Validate an agent-as-tool invocation request."""
    if server_name != agent_tool_server_name(agent=agent, pSelf=pSelf):
        raise ValueError(f'agent tool: unknown server_name {server_name!r}')
    if tool_name != getattr(agent, '_AGENT_TOOL_NAME', 'run_agent'):
        raise ValueError(f'agent tool: unknown tool_name {tool_name!r}')
    query, _ = agent_tool_parse_input(input_obj)
    if not isinstance(query, str) or not query.strip():
        raise ValueError('agent tool: input.query must be a non-empty string')


class _AgentAsToolProvider(ToolsBase):
    def __init__(self, *, agent: Any, pSelf: Any):
        self._agent = agent
        self._pSelf = pSelf

    def _tool_query(self) -> List[Dict[str, Any]]:
        return [agent_tool_descriptor(agent=self._agent, pSelf=self._pSelf)]

    def _tool_validate(self, *, server_name: str, tool_name: str, input_obj: Any) -> None:
        agent_tool_validate(
            agent=self._agent,
            pSelf=self._pSelf,
            server_name=server_name,
            tool_name=tool_name,
            input_obj=input_obj,
        )

    def _tool_invoke(self, *, server_name: str, tool_name: str, input_obj: Any) -> Any:
        self._tool_validate(server_name=server_name, tool_name=tool_name, input_obj=input_obj)

        query, ctx = agent_tool_parse_input(input_obj)
        q = Question(role='')
        q.addQuestion(query)
        if ctx is not None:
            try:
                q.addContext(json.dumps({'type': 'aparavi.agent.tool_context.v1', 'context': ctx}, default=str))
            except Exception:
                pass

        return self._agent.run_agent(self._pSelf, q, emit_answers_lane=False)


def make_agent_as_tool_provider(*, agent: Any, pSelf: Any) -> ToolsBase:
    """Create a ToolsBase adapter for agent-as-tool."""
    return _AgentAsToolProvider(agent=agent, pSelf=pSelf)
