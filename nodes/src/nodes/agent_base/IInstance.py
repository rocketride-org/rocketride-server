# =============================================================================
# MIT License
# Copyright (c) 2024 RocketRide Inc.
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OF OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""
Agent base class (framework-agnostic pipeline boundary).

This module intentionally standardizes only:
- Input normalization from the `questions` lane (Question + continuation from Question.context)
- Output normalization to the `answers` lane (AgentEnvelope JSON)
- Host service access to LLMs/tools via the existing control-plane invoke seam

It does NOT standardize agent internals (state machine, planning loop, retries, memory model).
"""

from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

from aparavi import IInstanceBase, debug, error
from ai.common.schema import Answer, Question

from .envelope import failed_envelope, to_envelope
from .host import AgentHostServices
from .trace import attach_tool_calls_artifact, make_tracing_invoker
from .types import AgentEnvelope, AgentInput, AgentRunResult
from .utils import (
    extract_continuation,
    extract_prompt,
    extract_tool_names,
    get_field,
    is_agent_run_tool_name,
    now_iso,
    new_run_id,
    safe_str,
    set_field,
    split_namespaced_tool_name,
)


class IInstanceGenericAgent(IInstanceBase):
    """
    Base class for all agent framework nodes.

    Derived classes implement `_run_agent(...)` to execute their framework internals.
    """

    # Override in derived framework nodes
    FRAMEWORK: str = 'unknown'

    # Tool contract: each agent node exposes exactly one invokable tool.
    _AGENT_TOOL_NAME: str = 'run_agent'

    def writeQuestions(self, question: Question):
        envelope, _agent_input = self._run_question(
            question=question,
            emit_answers_lane=True,
        )

        # Always emit ONLY the standardized envelope on the `answers` lane (client receives this)
        debug(f'agent base emitting envelope run_id={envelope.get("meta", {}).get("run_id")} status={envelope.get("status")}')
        answer = Answer(expectJson=True)
        answer.setAnswer(envelope)
        self.instance.writeAnswers(answer)

    # ---------------------------------------------------------------------
    # Tool-provider surface (agent-as-tool)
    # ---------------------------------------------------------------------
    def invoke(self, param: Any) -> Any:  # noqa: ANN401
        """
        Accept tool control-plane operations so agent nodes can be invoked as tools.

        Supported ops (via `IInvokeTool.*` payloads):
        - tool.query: advertise `<agentServer>.run_agent`
        - tool.validate: validate tool input
        - tool.invoke: run the agent and return an AgentEnvelope in Invoke.output
        """
        op = get_field(param, 'op')
        if not isinstance(op, str) or not op:
            # Not a tool operation; fall back to default behavior (raise) so other drivers can handle.
            return super().invoke(param)

        match op:
            case 'tool.query':
                tools = [self._agent_tool_descriptor()]
                existing = get_field(param, 'tools')
                if isinstance(existing, list):
                    existing.extend(tools)
                    set_field(param, 'tools', existing)
                    return param
                return tools

            case 'tool.validate':
                tool_name = get_field(param, 'tool_name')
                input_obj = get_field(param, 'input')
                server_name, bare_tool = split_namespaced_tool_name(tool_name)
                self._agent_tool_validate(server_name=server_name, tool_name=bare_tool, input_obj=input_obj)
                return {'valid': True, 'tool_name': tool_name}

            case 'tool.invoke':
                tool_name = get_field(param, 'tool_name')
                input_obj = get_field(param, 'input')
                server_name, bare_tool = split_namespaced_tool_name(tool_name)
                self._agent_tool_validate(server_name=server_name, tool_name=bare_tool, input_obj=input_obj)

                query, ctx = self._agent_tool_parse_input(input_obj)
                q = Question(role='')
                q.addQuestion(query)
                # Best-effort: attach provided context as a JSON record in Question.context
                if ctx is not None:
                    try:
                        q.addContext(json.dumps({'type': 'aparavi.agent.tool_context.v1', 'context': ctx}, default=str))
                    except Exception:
                        pass

                envelope, _ = self._run_question(
                    question=q,
                    emit_answers_lane=False,
                )

                # Convention: set Invoke.output on the param and return the param.
                set_field(param, 'output', envelope)
                return param

            case _:
                return super().invoke(param)

    def _agent_tool_server_name(self) -> str:
        """Return the tool server namespace for this agent node (usually logicalType)."""
        try:
            inst = getattr(self, 'instance', None)
            pipe_type = getattr(inst, 'pipeType', None) if inst is not None else None
            # Prefer the pipeline component id so multiple agent nodes can be invoked distinctly.
            pipe_id = None
            if isinstance(pipe_type, dict):
                pipe_id = pipe_type.get('id')
            else:
                pipe_id = getattr(pipe_type, 'id', None)
            if pipe_id:
                return str(pipe_id)

            glb = getattr(self, 'IGlobal', None)
            if glb and getattr(glb, 'glb', None) and getattr(glb.glb, 'logicalType', None):
                return str(glb.glb.logicalType)
        except Exception:
            pass
        return self._agent_id() or self.FRAMEWORK or 'agent'

    def _agent_tool_full_name(self) -> str:
        """Return this agent's fully-qualified tool name (`<server>.run_agent`)."""
        return f'{self._agent_tool_server_name()}.{self._AGENT_TOOL_NAME}'

    def _agent_tool_descriptor(self) -> Dict[str, Any]:
        """Build the tool descriptor for discovery via tool.query."""
        # Discover connected tools; omit other agent `run_agent` tools from the advertised list
        # so managers can see the concrete tools this agent can use.
        tools_available_all = self._discover_connected_tool_names()
        tools_available = [t for t in tools_available_all if not is_agent_run_tool_name(t)]

        desc = 'Invoke this agent as a tool. Input: {query: string, context?: object}. Output: AgentEnvelope.'
        if tools_available:
            desc = f'{desc} Tools available to this agent: {", ".join(tools_available)}.'
        else:
            desc = f'{desc} Tools available to this agent: (none).'
        return {
            'name': self._agent_tool_full_name(),
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
            # Machine-readable capability advertisement for hierarchical routing.
            'tools_available': tools_available,
        }

    def _agent_tool_validate(self, *, server_name: str, tool_name: str, input_obj: Any) -> None:
        """Validate a `tool.invoke` / `tool.validate` payload; raise on invalid input."""
        if server_name != self._agent_tool_server_name():
            raise ValueError(f'agent tool: unknown server_name {server_name!r}')
        if tool_name != self._AGENT_TOOL_NAME:
            raise ValueError(f'agent tool: unknown tool_name {tool_name!r}')
        query, _ = self._agent_tool_parse_input(input_obj)
        if not isinstance(query, str) or not query.strip():
            raise ValueError('agent tool: input.query must be a non-empty string')

    @staticmethod
    def _agent_tool_parse_input(input_obj: Any) -> tuple[str, Optional[Dict[str, Any]]]:
        """Parse tool input into `(query, context)` with strict type checks."""
        # Accept either:
        # - {"query": "...", "context": {...}}
        # - {"input": {"query": "...", "context": {...}}}  (common tool-wrapper shape)
        if isinstance(input_obj, dict) and 'input' in input_obj and len(input_obj) == 1:
            input_obj = input_obj.get('input')
        if not isinstance(input_obj, dict):
            raise ValueError('agent tool: input must be an object')
        query = input_obj.get('query')
        if not isinstance(query, str):
            raise ValueError('agent tool: input.query must be a string')
        ctx = input_obj.get('context')
        if ctx is None:
            return query, None
        if not isinstance(ctx, dict):
            raise ValueError('agent tool: input.context must be an object if provided')
        return query, ctx

    def _discover_connected_tool_names(self) -> List[str]:
        """
        Best-effort discovery of tools connected to this agent (its own allowlist).
        This is included in the agent-tool descriptor for higher-level routing.
        """
        try:
            host = AgentHostServices(self.instance.invoke)
            catalog = host.tools.query()
            return extract_tool_names(catalog)
        except Exception:
            return []

    def _run_question(
        self,
        *,
        question: Question,
        emit_answers_lane: bool,
    ) -> tuple[AgentEnvelope, Optional[AgentInput]]:
        """Execute one agent run and return its normalized envelope + derived input."""
        started_at = now_iso()
        run_id = new_run_id()
        debug(f'agent base run_question run_id={run_id} framework={self.FRAMEWORK}')
        invoker, tool_calls = make_tracing_invoker(self.instance.invoke)

        agent_input: Optional[AgentInput] = None
        try:
            prompt = extract_prompt(question)
            continuation = extract_continuation(getattr(question, 'context', None))
            task_id = self._get_task_id()

            agent_input = AgentInput(
                prompt=prompt,
                question=question,
                continuation=continuation,
                run_id=run_id,
                task_id=task_id,
                started_at=started_at,
            )

            host = AgentHostServices(invoker)
            runtime_ctx = {
                'run_id': run_id,
                'task_id': task_id,
                'framework': self.FRAMEWORK,
            }

            raw_result = self._run_agent(agent_input=agent_input, host=host, ctx=runtime_ctx)

            envelope = to_envelope(
                framework=self.FRAMEWORK,
                agent_id=self._agent_id(),
                run_id=run_id,
                task_id=task_id,
                started_at=started_at,
                ended_at=now_iso(),
                continuation=continuation,
                raw_result=raw_result,
            )
            status = envelope.get('status', '')
            debug(f'agent base _run_agent completed run_id={run_id} status={status}')

        except Exception as e:
            error_type = type(e).__name__
            error_message = str(e)
            error(f'agent base _run_agent failed run_id={run_id} type={error_type} message={error_message}')
            envelope = failed_envelope(
                framework=self.FRAMEWORK,
                agent_id=self._agent_id(),
                run_id=run_id,
                task_id=safe_str(self._get_task_id()) or None,
                started_at=started_at,
                ended_at=now_iso(),
                error_type=error_type,
                error_message=error_message,
            )

        attach_tool_calls_artifact(envelope, tool_calls)

        # When invoked as a tool, we do NOT emit to lanes; we return the envelope.
        if not emit_answers_lane:
            return envelope, agent_input

        return envelope, agent_input

    # ---------------------------------------------------------------------
    # Hooks for derived classes
    # ---------------------------------------------------------------------
    def _run_agent(self, *, agent_input: AgentInput, host: AgentHostServices, ctx: Dict[str, Any]) -> AgentRunResult:
        """
        Implement framework semantics here.
        Must return an AgentRunResult-like dict or raise.
        """
        raise NotImplementedError(
            'IInstanceGenericAgent._run_agent must be implemented by an agent framework node'
        )

    # ---------------------------------------------------------------------
    # Misc utilities
    # ---------------------------------------------------------------------
    def _agent_id(self) -> str:
        """Return a stable identifier for this agent node"""
        # Best-effort: prefer engine logical type if available
        try:
            glb = getattr(self, 'IGlobal', None)
            if glb and getattr(glb, 'glb', None) and getattr(glb.glb, 'logicalType', None):
                return str(glb.glb.logicalType)
        except Exception:
            pass
        return self.__class__.__name__

    def _get_task_id(self) -> Optional[str]:
        """Return the current engine task id if available"""
        try:
            endpoint = getattr(self, 'IEndpoint', None)
            eng = getattr(endpoint, 'endpoint', None)
            job_cfg = getattr(eng, 'jobConfig', None)
            if isinstance(job_cfg, dict):
                task_id = job_cfg.get('taskId')
                return str(task_id) if task_id else None
        except Exception:
            return None
        return None

