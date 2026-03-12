# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
RocketRide Wave — a wave-planning agent driver implementing AgentBase.

Execution model:
  1. Discover host tools and build a compact catalog (names + 1-line descs).
  2. **Tool-selection step** — call the LLM with the catalog. The LLM replies:
       {"tools": ["tool_name_1", "tool_name_2"]}
     selecting which tools it needs for the next wave.
  3. **Schema resolution** — the driver batch-resolves full input schemas for
     all selected tools (cached across waves).
  4. **Wave-planning step** — call the LLM again, now with resolved schemas
     included. The LLM replies:
       {"wave": [{"tool": "...", "args": {...}}, ...]}
  5. Execute all tools in the wave in parallel via the host.
  6. Append compact result summaries to the planning context and repeat.
  7. When done=true or max waves is reached, return the final answer.

Either step may return {"done": true, "answer": "..."} to end the loop early.

Token efficiency is achieved by:
  - Showing only names + 1-line descriptions in the tool-selection prompt.
  - Schemas are resolved incrementally — only new tools are looked up.
  - Wave results are kept as compact summaries (≤300 chars each).
"""

from __future__ import annotations

from typing import Any, Dict, List

from rocketlib import debug, error
from rocketlib.types import IInvokeLLM

from ai.common.agent import AgentBase, extract_text, safe_str
from ai.common.agent.types import AgentHost, AgentInput, AgentRunResult

from .planner import plan as plan_wave
from .executor import execute_wave, resolve_answer_refs

_MAX_WAVES = 10

class RocketRideDriver(AgentBase):
    """
    RocketRide Wave framework driver.

    Subclasses AgentBase and implements the wave-planning execution loop
    directly against the host LLM and tool infrastructure — no third-party
    agent framework required.
    """

    FRAMEWORK = 'wave'

    def __init__(self, iGlobal) -> None:
        """Initialize the Wave driver and load host services."""
        super().__init__(iGlobal)

    # ------------------------------------------------------------------
    # AgentBase abstract stubs — unused; we call the host directly
    # ------------------------------------------------------------------
    def _bind_framework_llm(self, *, host: Any, call_llm_text: Any, ctx: Any) -> None:
        """No-op — the Wave driver calls ``host.llm.invoke()`` directly."""
        return None

    def _bind_framework_tools(self, *, host: Any, tool_descriptors: Any, invoke_tool: Any, log_tool_call: Any, ctx: Any) -> List:
        """No-op — the Wave driver calls ``host.tools.invoke()`` directly."""
        return []

    # ------------------------------------------------------------------
    # Main driver
    # ------------------------------------------------------------------

    def _run(
        self,
        *,
        agent_input: AgentInput,
        host: AgentHost,
        ctx: Dict[str, Any],
    ) -> AgentRunResult:
        """Execute the wave-planning loop.

        Each iteration runs a two-phase planning cycle (tool selection then
        wave planning) followed by parallel tool execution.  The loop ends
        when the LLM signals ``done``, the plan is empty, or ``_MAX_WAVES``
        is reached — in which case a final synthesis prompt is used.

        Returns:
            A ``(content, trace)`` tuple consumed by ``AgentBase.run_agent``.
        """
        run_id = ctx.get('run_id', '')
        debug(f'rocketride wave _run start run_id={run_id}')
        self.sendSSE('thinking', 'Analyzing your request...')

        # Accumulate wave history — shared mutably with the planner so each
        # planning call can see all prior tool results as context.
        waves: List[Dict[str, Any]] = []
        trace: Dict[str, Any] = {'waves': waves, 'run_id': run_id}

        current_plan = ''

        for wave_num in range(_MAX_WAVES):
            debug(f'rocketride wave wave_num={wave_num} run_id={run_id}')
            self.sendSSE('thinking', f'Planning step {wave_num + 1}...')

            # Run the planner — one LLM call with all tool descriptions.
            # May return {"done": true, "answer": "..."} or {"wave": [...]}.
            try:
                result = plan_wave(
                    agent_input=agent_input,
                    host=host,
                    waves=waves,
                    instructions=self._instructions,
                    current_plan=current_plan,
                )
            except Exception as exc:
                error(f'rocketride wave plan failed run_id={run_id}: {exc}')
                return f'LLM error: {exc}', trace

            # Extract updated plan from the LLM response
            current_plan = safe_str(result.get('plan', '')) or current_plan
            trace['plan'] = current_plan

            # Surface the LLM's thought to the UI if present
            thought = safe_str(result.get('thought', ''))
            if thought:
                self.sendSSE('thinking', thought)

            # LLM decided no more tool calls are needed
            if result.get('done'):
                self.sendSSE('thinking', 'Generating final answer...')
                answer = safe_str(result.get('answer', ''))
                # Resolve {{memory.get:key@format}} references in the answer
                answer = resolve_answer_refs(answer, host)
                debug(f'rocketride wave done wave_num={wave_num} run_id={run_id}')
                return answer, trace

            # Guard against malformed or empty wave plans
            wave = result.get('wave') or []
            if not isinstance(wave, list) or not wave:
                debug(f'rocketride wave empty plan wave_num={wave_num} run_id={run_id}, stopping')
                break

            # Surface which tools are about to run
            tool_names = [c.get('tool', '?') for c in wave]
            self.sendSSE('thinking', f'Running: {", ".join(tool_names)}', {'wave': wave_num + 1, 'tools': tool_names})

            # Execute all tool calls in this wave concurrently and record
            # the results so subsequent planning iterations can reference them.
            results = execute_wave(wave, host=host, wave_name=f'wave-{wave_num}')
            waves.append({'wave_num': wave_num, 'calls': wave, 'results': results})
            self.sendSSE('thinking', f'Step {wave_num + 1} complete', {'results': len(results)})

        # Reached max waves without the LLM signaling done — ask it
        # to produce a final answer from everything gathered so far.
        debug(f'rocketride wave max waves reached run_id={run_id}, synthesizing final answer')
        self.sendSSE('thinking', 'Synthesizing final answer...')
        return self._synthesize(agent_input=agent_input, waves=waves, host=host), trace

    # ------------------------------------------------------------------
    # Final synthesis (fallback when max waves exhausted)
    # ------------------------------------------------------------------

    def _synthesize(
        self,
        *,
        agent_input: AgentInput,
        waves: List[Dict[str, Any]],
        host: AgentHost,
    ) -> str:
        """Ask the LLM to produce a final answer from all gathered results.

        Collects tool result summaries from every wave into a compact
        bullet list, injects it as context, and asks the LLM to synthesize
        a coherent answer.
        """
        # Flatten all wave results into a compact bullet list.
        lines: List[str] = []
        for w in waves:
            for r in w.get('results', []):
                tool = r.get('tool', '?')
                if r.get('error'):
                    lines.append(f'- {tool}: ERROR — {r["error"]}')
                else:
                    lines.append(f'- {tool}: {r.get("summary", "")}')

        gathered = '\n'.join(lines) if lines else '(no results gathered)'

        # Build a synthesis prompt from the original question context
        q = agent_input.question.model_copy(deep=True)
        q.role = 'You are a helpful assistant.'

        # Move the user's original questions into goals so the LLM
        # understands the high-level objective when synthesizing
        for qt in q.questions:
            q.addGoal(qt.text)
        q.questions = []

        # Inject the gathered information and ask for a final answer
        q.addContext(f'Information gathered:\n{gathered}')
        q.addQuestion('Based on the above, provide a complete and accurate final answer.')
        try:
            result = host.llm.invoke(IInvokeLLM(op='ask', question=q))
            return extract_text(result)
        except Exception as exc:
            return f'Unable to produce final answer: {exc}'
