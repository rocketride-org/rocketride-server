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

"""
Shared base class for all CrewAI driver classes.

Provides framework binding helpers (`_build_crew_llm`, `_build_crew_tools`)
that wrap the host LLM/tool channels as CrewAI BaseLLM / BaseTool instances.
Subclassed by CrewAgent (standalone), CrewSubagent (managed), and CrewManager
(hierarchical delegator).
"""

from __future__ import annotations

import asyncio
import json
from typing import Any, Dict, List, Optional, Union

from rocketlib import ToolDescriptor

from ai.common.agent import AgentBase, AgentContext

from ai.common.utils import safe_str


# ────────────────────────────────────────────────────────────────────────────────
# CREWAI ASYNC COMPATIBILITY PATCHES (applied once at import time)
#
# Two related issues in CrewAI 1.14.x when running inside a shared asyncio loop:
#
# 1. PLANNING — Crew._handle_crew_planning() calls planner_task.execute_sync()
#    → agent.execute_task() (sync) which raises RuntimeError when it detects a
#    running event loop. Fix: offload planning to a ThreadPoolExecutor worker
#    thread that has no running loop (_patch_crewai_planning).
#
# 2. DELEGATION — DelegateWorkTool / BaseAgentTool have no _arun / _aexecute,
#    so hierarchical crews fall back to the sync execute_task() path from inside
#    the async loop → RuntimeError. Fix: patch both classes with async variants
#    that use aexecute_task() instead (_patch_crewai_delegation).
# ────────────────────────────────────────────────────────────────────────────────


def _patch_crewai_planning() -> None:
    """
    Patch Crew._handle_crew_planning() to be safe when called from inside a
    running event loop (e.g. via akickoff() on the CrewRunner daemon thread).

    CrewAI's planning step calls planner_task.execute_sync() -> agent.execute_task(),
    which raises RuntimeError when it detects a running event loop. We fix this by
    offloading the entire planning call to a ThreadPoolExecutor worker thread, which
    has no running loop. Planning mutates self.tasks in-place, so the crew sees the
    updated task descriptions when the worker returns.
    """
    try:
        import concurrent.futures

        from crewai.crew import Crew

        if getattr(Crew, '_rr_planning_patched', False):
            return

        _orig_planning = Crew._handle_crew_planning

        def _safe_handle_crew_planning(self) -> None:
            try:
                asyncio.get_running_loop()
            except RuntimeError:
                _orig_planning(self)
                return
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as ex:
                ex.submit(_orig_planning, self).result()

        Crew._handle_crew_planning = _safe_handle_crew_planning  # type: ignore[method-assign]
        Crew._rr_planning_patched = True  # type: ignore[attr-defined]
    except Exception:
        pass


def _patch_crewai_delegation() -> None:
    try:
        from crewai.task import Task
        from crewai.tools.agent_tools.ask_question_tool import AskQuestionTool
        from crewai.tools.agent_tools.base_agent_tools import BaseAgentTool
        from crewai.tools.agent_tools.delegate_work_tool import DelegateWorkTool
        from crewai.utilities.i18n import I18N_DEFAULT

        if hasattr(BaseAgentTool, '_aexecute'):
            return  # already patched

        async def _aexecute(self, agent_name, task, context=None):  # type: ignore[override]
            try:
                if agent_name is None:
                    agent_name = ''
                sanitized = self.sanitize_agent_name(agent_name)
                agent = [a for a in self.agents if self.sanitize_agent_name(a.role) == sanitized]
            except (AttributeError, ValueError) as e:
                return I18N_DEFAULT.errors('agent_tool_unexisting_coworker').format(
                    coworkers='\n'.join([f'- {self.sanitize_agent_name(a.role)}' for a in self.agents]),
                    error=str(e),
                )
            if not agent:
                return I18N_DEFAULT.errors('agent_tool_unexisting_coworker').format(
                    coworkers='\n'.join([f'- {self.sanitize_agent_name(a.role)}' for a in self.agents]),
                    error=f"No agent found with role '{sanitized}'",
                )
            selected = agent[0]
            try:
                t = Task(description=task, agent=selected, expected_output=I18N_DEFAULT.slice('manager_request'))
                return await selected.aexecute_task(t, context)
            except Exception as e:
                return I18N_DEFAULT.errors('agent_tool_execution_error').format(
                    agent_role=self.sanitize_agent_name(selected.role), error=str(e)
                )

        async def _delegate_arun(self, task, context, coworker=None, **kwargs):  # type: ignore[override]
            coworker = self._get_coworker(coworker, **kwargs)
            return await self._aexecute(coworker, task, context)

        async def _ask_arun(self, question, context, coworker=None, **kwargs):  # type: ignore[override]
            coworker = self._get_coworker(coworker, **kwargs)
            return await self._aexecute(coworker, question, context)

        BaseAgentTool._aexecute = _aexecute  # type: ignore[attr-defined]
        DelegateWorkTool._arun = _delegate_arun  # type: ignore[attr-defined]
        AskQuestionTool._arun = _ask_arun  # type: ignore[attr-defined]
    except Exception:
        pass  # if crewai isn't installed yet, skip silently


_patch_crewai_planning()
_patch_crewai_delegation()


# ────────────────────────────────────────────────────────────────────────────────
# CREWBASE
# ────────────────────────────────────────────────────────────────────────────────


class CrewBase(AgentBase):
    """
    Shared base class for all CrewAI driver classes.

    Inherits from AgentBase. Provides:

      - Framework binding methods that wrap the host LLM and tool channels as
        CrewAI BaseLLM / BaseTool instances:
          * `_build_crew_llm(context, role)`
          * `_build_crew_tools(context, tool_descriptors)`

      - Shared CrewAI utility helpers (`_escape_braces`, `_merge_instructions`)
        as `@staticmethod` so subclasses can call them via `self._escape_braces(...)`
        without import noise. Note: `safe_str` is imported from
        `ai.common.utils` (the shared helper used by every agent
        driver including agent_rocketride).

      - Default field values (`_DEFAULT_GOAL`, `_DEFAULT_BACKSTORY`,
        `_DEFAULT_EXPECTED_OUTPUT`) as class attributes used as fallbacks
        when a node's config leaves the field blank.

    The framework binding methods capture `self` and `context` via closure
    on the inner wrapper classes.  The wrappers delegate back to
    `self.call_llm(context, ...)` and `self.call_tool(context, ...)`, which
    route through `AgentBase`'s host adapters using the channels carried by
    `context`.

    The `context` parameter (not `self`) is what determines which engine
    channels are used.  This is what lets `CrewManager._run` build sub-agent
    LLM/tool wrappers using `self._build_crew_llm(sub_context, ...)` and have
    those calls correctly route through each sub-agent's own channels.
    """

    # Default field values used as fallbacks when a node's config leaves
    # the field blank.  Subclasses can override these as class attributes
    # if they want different defaults (e.g. CrewManager uses its own
    # _MGR_GOAL / _MGR_BACKSTORY constants instead of these).
    _DEFAULT_GOAL = 'Complete the assigned task to the best of your ability.'
    _DEFAULT_BACKSTORY = 'You are a specialized agent in a multi-agent pipeline with access to tools. Use your tools and reasoning to complete tasks effectively.'
    _DEFAULT_EXPECTED_OUTPUT = 'A clear, direct answer to the assigned task.'

    # ─────────────────────────────────────────────────────────────────────
    # SHARED UTILITIES
    # ─────────────────────────────────────────────────────────────────────

    @staticmethod
    def _escape_braces(text: str) -> str:
        """Escape curly braces so CrewAI doesn't treat them as template variables."""
        return text.replace('{', '{{').replace('}', '}}')

    @staticmethod
    def _merge_instructions(backstory: str, instructions: Optional[List[str]]) -> str:
        """Append instructions as a bullet list to a CrewAI backstory string.

        Used by all three CrewAI drivers to weave their `instructions` config
        field into the CrewAI Agent's backstory.  Without this, instructions
        loaded by `AgentBase.__init__` (and copied onto the Question by
        `AgentBase.run_agent` via `addInstruction`) never reach CrewAI — Crew
        only ever sees what's in `Agent(backstory=...)` and `Task(description=...)`.

        Empty/whitespace-only entries are dropped.  If no instructions remain
        after cleaning, the backstory is returned unchanged.
        """
        cleaned = [i.strip() for i in (instructions or []) if i and i.strip()]
        if not cleaned:
            return backstory
        bullets = '\n'.join(f'- {i}' for i in cleaned)
        return f'{backstory}\n\nInstructions:\n{bullets}'

    # ─────────────────────────────────────────────────────────────────────
    # FRAMEWORK BINDING
    # ─────────────────────────────────────────────────────────────────────

    def _build_crew_llm(self, context: AgentContext, role: str) -> Any:
        """
        Wrap the host LLM channel as a CrewAI-compatible BaseLLM.

        The inner `HostInvokeLLM` subclass captures `self`, `context`, and
        `role` via closure on this method.  Its `call` and `acall` methods
        delegate to `self.call_llm(context, messages, role=role, stop_words=...)`,
        routing the request through AgentBase's host adapter and the engine
        channels carried by `context`.
        """
        from crewai import BaseLLM

        outer_self = self
        outer_context = context
        outer_role = role

        class HostInvokeLLM(BaseLLM):
            def __init__(self):
                super().__init__(model='RocketRide-host-llm', temperature=None)

            def call(
                self,
                messages: Union[str, List[Dict[str, str]]],
                tools: Optional[List[dict]] = None,
                callbacks: Optional[List[Any]] = None,
                available_functions: Optional[Dict[str, Any]] = None,
                **kwargs: Any,
            ) -> Union[str, Any]:
                # CrewAI injects the ReAct stop list ("\nObservation:") per-call via a
                # contextvar override that is ONLY visible through the `stop_sequences`
                # property (crewai/llms/base_llm.py) — NOT the raw `self.stop` field.
                # Reading `self.stop` returned an empty list, so call_llm's post-hoc truncation no-oped
                # and the model's fabricated Observation/Final Answer survived, skipping the
                # real tool call. Read the property so truncation trims at "\nObservation:".
                stop_words = self.stop_sequences
                return outer_self.call_llm(
                    outer_context,
                    messages,
                    role=outer_role,
                    stop_words=stop_words,
                )

            async def acall(
                self,
                messages: Union[str, List[Dict[str, str]]],
                tools: Optional[List[dict]] = None,
                callbacks: Optional[List[Any]] = None,
                available_functions: Optional[Dict[str, Any]] = None,
                **kwargs: Any,
            ) -> Union[str, Any]:
                # Bridge to the synchronous host LLM channel via to_thread so the
                # shared kickoff loop is not blocked while the engine's invoke
                # seam runs.  Verified in CrewAI 1.14.1 source: aget_llm_response
                # in crewai/utilities/agent_utils.py awaits llm.acall(...) on the
                # akickoff path, so this override is reached for every async LLM
                # call from a crew running on our shared loop.
                return await asyncio.to_thread(
                    self.call,
                    messages,
                    tools=tools,
                    callbacks=callbacks,
                    available_functions=available_functions,
                    **kwargs,
                )

        return HostInvokeLLM()

    def _build_crew_tools(
        self,
        context: AgentContext,
        tool_descriptors: List[ToolDescriptor],
    ) -> List[Any]:
        """
        Convert host tool descriptors into CrewAI BaseTool instances.

        Each tool's JSON Schema is embedded in the description so CrewAI can
        pass structured arguments. A dynamic Pydantic args_schema is built per
        tool to preserve real parameter names through CrewAI's argument filter.

        The inner `HostTool` subclass captures `self` and `context` via closure
        on this method so its `_run` / `_arun` methods can call
        `self.call_tool(context, name, args)`.
        """
        from crewai.tools import BaseTool
        from pydantic import BaseModel, ConfigDict, Field, create_model

        outer_self = self
        outer_context = context

        class _ToolInput(BaseModel):
            input: Any = Field(default=None, description='Tool input payload')
            model_config = ConfigDict(extra='allow')

        def _make_args_schema(input_schema: Optional[Dict[str, Any]]) -> type[BaseModel]:
            """
            Build a dynamic Pydantic model from a JSON Schema so that
            CrewAI's argument filter preserves real tool parameters.
            """
            if not isinstance(input_schema, dict):
                return _ToolInput
            props = input_schema.get('properties', {})
            if not props:
                return _ToolInput
            required_keys = set(input_schema.get('required', []))
            field_defs: Dict[str, Any] = {}
            for key, prop in props.items():
                desc = prop.get('description', '')
                if key in required_keys:
                    field_defs[key] = (Any, Field(..., description=desc))
                else:
                    default = prop.get('default', None)
                    field_defs[key] = (Any, Field(default=default, description=desc))
            try:
                return create_model(
                    '_DynToolInput',
                    __config__=ConfigDict(extra='ignore'),
                    **field_defs,
                )
            except Exception:
                return _ToolInput

        class HostTool(BaseTool):
            name: str
            description: str
            args_schema: type[BaseModel] = _ToolInput

            def __repr__(self) -> str:
                # Strip JSON schema suffix and CrewAI-reformatted header so planning
                # prompts see a clean one-liner — same as native CrewAI tool reprs.
                desc = self.description.split('\n\nTool input schema (JSON):')[0]
                if '\nTool Description: ' in desc:
                    desc = desc.split('\nTool Description: ', 1)[1].split('\n')[0]
                return f'Tool(name={self.name!r}, description={desc!r})'

            __str__ = __repr__

            def _run(self, **framework_args: Any) -> str:
                try:
                    out = outer_self.call_tool(outer_context, self.name, framework_args)
                except Exception as e:
                    out = {'error': str(e), 'type': type(e).__name__}

                try:
                    return json.dumps(out, default=str) if isinstance(out, (dict, list)) else safe_str(out)
                except Exception:
                    return safe_str(out)

            async def _arun(self, **framework_args: Any) -> str:
                # The ReAct tool path goes tool.ainvoke -> _arun, so this is what
                # gets called when the LLM does NOT use native function calling.
                # Wraps the existing sync _run via to_thread to avoid blocking
                # the shared kickoff loop.
                #
                # NOTE: the native tools path (used by GPT-4 / Claude / any LLM
                # with supports_function_calling()==True) bypasses _arun entirely
                # and calls _run synchronously via available_functions[name].
                # See the "Known Limitations" section of the plan -- tool calls
                # serialize on the loop in that path.  Override
                # supports_function_calling()->False on HostInvokeLLM to force
                # the ReAct path if full tool concurrency is required.
                return await asyncio.to_thread(self._run, **framework_args)

        tools = []
        for td in tool_descriptors:
            name = td.get('name', '') if isinstance(td, dict) else getattr(td, 'name', '')
            desc = td.get('description', '') if isinstance(td, dict) else getattr(td, 'description', '')
            if not name:
                continue
            if not desc:
                desc = f'Invoke host tool: {name}'
            input_schema = td.get('inputSchema') if isinstance(td, dict) else None
            if isinstance(input_schema, dict):
                try:
                    schema_text = json.dumps(input_schema, ensure_ascii=False)
                except Exception:
                    schema_text = ''
                if schema_text:
                    desc = f'{desc}\n\nTool input schema (JSON): {schema_text}'

            schema_cls = _make_args_schema(input_schema)
            tools.append(HostTool(name=name, description=desc, args_schema=schema_cls))
        return tools
