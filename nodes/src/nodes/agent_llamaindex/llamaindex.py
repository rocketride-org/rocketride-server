# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
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
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""LlamaIndex driver implementing the shared `ai.common.agent.AgentBase` interface."""

from __future__ import annotations

import json
from copy import deepcopy
from dataclasses import dataclass, field
from typing import Any, List

from ai.common.agent import AgentBase, AgentContext
from ai.common.agent.types import AgentRunResult
from ai.common.schema import Question
from ai.common.utils import safe_str

# The agent's LLM invocation channel returns plain text synchronously, so we drive
# LlamaIndex's ReAct loop by hand (call_llm/call_tool) rather than its async agents.
_MAX_ITERATIONS = 10


def _build_tools(descriptors: List[Any]) -> List[Any]:
    """Wrap host tool descriptors as LlamaIndex FunctionTools (metadata only; we execute via call_tool)."""
    from llama_index.core.tools import FunctionTool, ToolMetadata

    @dataclass
    class HostToolMetadata(ToolMetadata):
        """Keep the host JSON Schema authoritative in ReAct's Tool Args field."""

        host_schema: dict = field(default_factory=dict)

        def get_parameters_dict(self) -> dict:
            return deepcopy(self.host_schema)

    # The callable is never executed: call_tool dispatches through the host.
    # Do not infer its empty signature as the real tool's argument schema.
    def _noop() -> str:
        return ''

    tools: List[Any] = []
    for td in descriptors:
        name = (td or {}).get('name')
        if not name:
            continue
        description = (td or {}).get('description') or name
        schema = (td or {}).get('inputSchema') or {'type': 'object', 'properties': {}}
        metadata = HostToolMetadata(name=name, description=description, host_schema=deepcopy(schema))
        tools.append(FunctionTool.from_defaults(fn=_noop, tool_metadata=metadata))
    return tools


def _messages_to_text(messages: List[Any]) -> str:
    """Flatten ReAct ChatMessages into a single text prompt for the host LLM."""
    parts: List[str] = []
    for m in messages:
        role = getattr(m, 'role', '')
        role = getattr(role, 'value', role)
        parts.append(f'{safe_str(role)}: {safe_str(getattr(m, "content", "") or "")}')
    return '\n\n'.join(parts).strip()


def _clean_answer(text: str) -> str:
    """Strip a leading ReAct 'Thought:' so loop scaffolding doesn't leak to the user."""
    cleaned = safe_str(text).strip()
    if cleaned.startswith('Thought:'):
        cleaned = cleaned[len('Thought:') :].strip()
    return cleaned


class LlamaIndexDriver(AgentBase):
    FRAMEWORK = 'llamaindex'

    def __init__(self, iGlobal: Any) -> None:
        """Initialize the LlamaIndex driver."""
        super().__init__(iGlobal)

    def _run(self, *, context: AgentContext, question: Question) -> AgentRunResult:
        from llama_index.core.agent.react.formatter import ReActChatFormatter
        from llama_index.core.agent.react.output_parser import ReActOutputParser
        from llama_index.core.agent.react.types import ObservationReasoningStep
        from llama_index.core.base.llms.types import ChatMessage, MessageRole

        self.sendSSE(context, 'thinking', message='Starting LlamaIndex agent...')

        tools = _build_tools(list(context.tools.list))
        formatter = ReActChatFormatter.from_defaults()
        parser = ReActOutputParser()

        # Instructions are already merged into the prompt by the base run_agent.
        query = safe_str(question.getPrompt() or '')

        chat_history = [ChatMessage(role=MessageRole.USER, content=query)]
        current_reasoning: List[Any] = []
        stack: List[Any] = []
        raw = ''

        for _ in range(_MAX_ITERATIONS):
            messages = formatter.format(tools, chat_history, current_reasoning=current_reasoning)
            raw = safe_str(self.call_llm(context, _messages_to_text(messages), stop_words=['Observation:']))

            try:
                step = parser.parse(raw)
            except Exception:
                # Unparseable output means the model answered directly; strip scaffolding.
                return _clean_answer(raw), stack

            if step.is_done:
                return safe_str(getattr(step, 'response', raw)), stack

            self.sendSSE(context, 'thinking', message=f'Calling {step.action}...', tool=step.action)
            try:
                observation = self.call_tool(context, step.action, step.action_input or {})
            except Exception as e:
                observation = {'tool': step.action, 'error': str(e), 'type': type(e).__name__}

            obs_text = safe_str(
                json.dumps(observation, default=str) if isinstance(observation, (dict, list)) else observation
            )
            current_reasoning.append(step)
            current_reasoning.append(ObservationReasoningStep(observation=obs_text))
            stack.append({'action': step.action, 'action_input': step.action_input, 'observation': obs_text})

        # Iteration budget exhausted without a final Answer.
        return 'Agent stopped after reaching the maximum number of reasoning steps.', stack
