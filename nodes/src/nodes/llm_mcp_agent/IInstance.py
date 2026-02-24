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
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================
"""
Generic MCP agent instance: on each question, auto-generates a system prompt
from the dynamically discovered MCP tools, invokes the connected LLM with
those tools, and writes the answer downstream.

"""

from rocketlib import IInstanceBase
from rocketlib.types import IInvokeLLM
from ai.common.schema import Answer, Question

from .IGlobal import IGlobal


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


class _QuestionWithPrompt:
    """Wraps a Question to inject a system instruction before the user prompt."""

    def __init__(self, question: Question, system_instruction: str):
        self._question = question
        self._prompt = f'{system_instruction}\n\nUser: {question.getPrompt()}'

    def getPrompt(self):
        return self._prompt

    @property
    def expectJson(self):
        return getattr(self._question, 'expectJson', False)


# ---------------------------------------------------------------------------
# IInstance
# ---------------------------------------------------------------------------


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    def writeQuestions(self, question: Question):
        tools = getattr(self.IGlobal, '_all_tools', None) or []
        if not tools:
            answer = Answer(expectJson=True)
            answer.setAnswer({
                'error': 'LLM MCP Agent: no MCP tools available.',
                'text': '',
                'agent_queries': [],
            })
            self.instance.writeAnswers(answer)
            return

        # Auto-generate system prompt from discovered tools
        system_prompt = self._build_system_prompt()
        wrapped = _QuestionWithPrompt(question, system_prompt)

        invoke_param = IInvokeLLM(op='askWithTools', question=wrapped, tools=tools)
        result = self.instance.invoke('llm', invoke_param)

        if result is not None:
            self.instance.writeAnswers(result)
        else:
            answer = Answer(expectJson=True)
            answer.setAnswer({
                'error': "LLM MCP Agent: no LLM connected. Connect an LLM node to this agent's 'llm' invoke.",
                'text': '',
                'agent_queries': [],
            })
            self.instance.writeAnswers(answer)

    def _build_system_prompt(self) -> str:
        """Auto-generate a system prompt listing all discovered MCP tools."""
        n = len(self.IGlobal.tools)
        summary = self.IGlobal.tool_summary
        parts = [
            f'You have access to {n} tools from connected MCP servers.',
            '',
            f'Available tools:\n{summary}',
        ]

        # Append user-defined prompt if configured
        prompt = self.IGlobal.prompt
        if prompt:
            parts.append('')
            parts.append(prompt)

        parts.append('')
        parts.append('Use these tools to answer the user\'s question.')
        parts.append('If the user is just chatting, answer normally without calling tools.')
        return '\n'.join(parts)
