from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

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
        return _AgentAsToolProvider(agent=agent, pSelf=pSelf).handle_invoke(param)
    except ValueError as e:
        msg = str(e)
        if msg.startswith('tools: '):
            raise ValueError('agent tool: ' + msg[len('tools: ') :]) from None
        raise


class _AgentAsToolProvider(ToolsBase):
    def __init__(self, *, agent: Any, pSelf: Any):
        self._agent = agent
        self._pSelf = pSelf
        self._full_name = f'{self.unique_agent_tool_name()}.{getattr(self._agent, "_AGENT_TOOL_NAME", "run_agent")}'
        self._tools_available: Optional[List[str]] = None

    def unique_agent_tool_name(self) -> str:
        inst = self._pSelf.instance
        pipe_type = inst.pipeType
        pipe_id = pipe_type.get('id') if isinstance(pipe_type, dict) else pipe_type.id
        return str(pipe_id)

    def _connected_tools_available(self) -> List[str]:
        if self._tools_available is not None:
            return self._tools_available
        try:
            host = AgentHostServices(self._pSelf.instance.invoke)
            tools = self._agent._discover_tools(host=host)
            names = [t.get('name', '') for t in tools if t.get('name')]
        except Exception:
            names = []
        tools_available = [t for t in names if not is_agent_run_tool_name(t)]
        self._tools_available = tools_available
        return tools_available

    def _parse_input(self, input_obj: Any) -> tuple[str, Optional[Dict[str, Any]]]:  # noqa: ANN401
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
        if tool_name != self._full_name:
            raise ValueError(f'agent tool: unknown tool_name {tool_name!r}')
        query, _ = self._parse_input(input_obj)
        if not query.strip():
            raise ValueError('agent tool: input.query must be a non-empty string')

    def _tool_query(self) -> List[ToolsBase.ToolDescriptor]:

        tools_available = self._connected_tools_available()
        desc = 'Invoke this agent as a tool. Input: {query: string, context?: object}. Output: {content, meta, stack}.'
        if tools_available:
            desc = f'{desc} Tools available to this agent: {", ".join(tools_available)}.'
        else:
            desc = f'{desc} Tools available to this agent: (none).'

        descriptor = {
            'name': self._full_name,
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
            }
        }
        return [descriptor]

    def _tool_validate(self, *, tool_name: str, input_obj: Any) -> None:
        self._validate_request(tool_name=tool_name, input_obj=input_obj)

    def _tool_invoke(self, *, tool_name: str, input_obj: Any) -> Any:
        self._tool_validate(tool_name=tool_name, input_obj=input_obj)

        query, ctx = self._parse_input(input_obj)
        q = Question(role='')
        q.addQuestion(query)
        if ctx is not None:
            try:
                q.addContext(json.dumps({'type': 'aparavi.agent.tool_context.v1', 'context': ctx}, default=str))
            except Exception:
                pass

        return self._agent.run_agent(self._pSelf, q, emit_answers_lane=False)
