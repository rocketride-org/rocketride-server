# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
RocketRide Wave — a wave-planning agent driver implementing AgentBase.

Execution model:
  1. Build the full planning prompt (system instructions, tool schemas,
     memory context, prior wave results, persistent scratch notes).
  2. **Wave-planning step** — call the LLM with all tool descriptions.
     The LLM replies with either:
       {"tool_calls": [{"tool": "...", "args": {...}}, ...], "scratch": "..."}
     or:
       {"done": true, "answer": "...", "scratch": "..."}
  3. Execute all tool calls in the wave in parallel via the host.
  4. Store results in memory, append structural summaries to wave history.
  5. Repeat from step 1 until done=true or max_waves is reached.
  6. If max_waves is reached without done=true, run a synthesis fallback
     that asks the LLM to produce a best-effort answer from everything gathered.

Token efficiency is achieved by:
  - Showing only structural summaries of prior results (not raw data) in context.
  - The LLM uses memory.peek to pull specific values on demand.
  - Scratch notes carry only what the LLM explicitly chooses to remember.
  - Completed result keys are evicted from memory and context via the remove field.
"""

from __future__ import annotations

from typing import Any, Dict, List

from rocketlib import debug, error
from rocketlib.types import IInvokeLLM

from ai.common.agent import AgentBase, extract_text, safe_str
from ai.common.agent.types import AgentHost, AgentInput, AgentRunResult
from ai.common.config import Config

from .planner import plan as plan_wave
from .executor import execute_wave, resolve_answer_refs

# Default hard cap on planning iterations before the synthesis fallback fires.
# Prevents runaway loops if the LLM fails to converge on done=true.
# Can be overridden via the ``max_waves`` node configuration field.
_DEFAULT_MAX_WAVES = 10

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
        config = Config.getNodeConfig(iGlobal.glb.logicalType, iGlobal.glb.connConfig)
        self._max_waves = config.get('max_waves', _DEFAULT_MAX_WAVES)

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

        Each iteration:
          1. Calls plan_wave() which builds the full prompt and fires one LLM call.
          2. Extracts scratch (persistent working notes) from the LLM response.
          3. Prunes memory keys the LLM has finished with (remove field).
          4. Surfaces the LLM's thought to the UI via SSE.
          5. If done=true, resolves {{memory.ref:...}} template refs in the answer
             and returns.
          6. Otherwise, executes the tool_calls in parallel and loops.

        Returns:
            A ``(content, trace)`` tuple consumed by ``AgentBase.run_agent``.
        """
        run_id = ctx.get('run_id', '')
        debug(f'rocketride wave _run start run_id={run_id}')
        self.sendSSE('thinking', message='Analyzing your request...')

        # waves accumulates the full history of every tool call and its result
        # summary.  It is passed to plan_wave() each iteration so the planner
        # can inject all prior results into the prompt as context.
        waves: List[Dict[str, Any]] = []

        # trace is returned to the caller and recorded for observability.
        # waves is shared by reference — appending to it here also updates trace.
        trace: Dict[str, Any] = {'waves': waves, 'run_id': run_id}

        # Scratch persists the LLM's working notes across iterations.
        # The LLM emits it in each response and we re-inject it into the next
        # planning prompt so the LLM can continue from where it left off
        # (remembered memory keys, extracted values, intermediate calculations).
        current_scratch = ''

        for wave_num in range(self._max_waves):
            debug(f'rocketride wave wave_num={wave_num} run_id={run_id}')
            self.sendSSE('thinking', message=f'Planning step {wave_num + 1}...')

            # Run the planner — one LLM call with all tool descriptions.
            # Returns either {"done": true, "answer": "..."} or {"tool_calls": [...]}
            # or {} if the LLM response was malformed.
            try:
                result = plan_wave(
                    agent_input=agent_input,
                    host=host,
                    waves=waves,
                    instructions=self._instructions,
                    current_scratch=current_scratch,
                )
            except Exception as exc:
                error(f'rocketride wave plan failed run_id={run_id}: {exc}')
                return f'LLM error: {exc}', trace

            # Update scratch from the LLM response.  Fall back to the previous
            # scratch if the LLM returned an empty string — we never want to
            # lose accumulated working notes due to an accidental empty response.
            current_scratch = safe_str(result.get('scratch', '')) or current_scratch
            trace['scratch'] = current_scratch

            # ------------------------------------------------------------------
            # Memory pruning — evict keys the LLM is done with
            # ------------------------------------------------------------------

            # The LLM signals via the remove field which memory keys it no
            # longer needs.  We clear them from the memory store and strip them
            # from wave history so they don't re-appear in the next prompt.
            # This keeps the "Previous tool results" context lean as the session
            # progresses and old intermediate results become irrelevant.
            remove_keys = result.get('remove') or []
            if remove_keys:
                for key in remove_keys:
                    try:
                        host.memory.clear(key)
                    except Exception as exc:
                        debug(f'rocketride wave remove key={key!r} failed: {exc}')
                # Strip removed result entries from wave history to keep context lean
                for w in waves:
                    w['results'] = [r for r in w.get('results', []) if r.get('key') not in remove_keys]
                # Drop wave entries that are now completely empty (all results pruned)
                waves[:] = [w for w in waves if w.get('results')]

            # Surface the LLM's thought to the UI — one-sentence description of
            # what the agent is doing this turn.  Shown in the "thinking" panel.
            thought = safe_str(result.get('thought', ''))
            if thought:
                self.sendSSE('thinking', message=thought)

            # ------------------------------------------------------------------
            # Done — resolve answer refs and return
            # ------------------------------------------------------------------

            if result.get('done'):
                self.sendSSE('thinking', message='Generating final answer...')
                answer = safe_str(result.get('answer', ''))

                # Resolve {{memory.ref:key:format:path}} references in the answer.
                # The LLM may reference bulk data (large tables, arrays) via these
                # template tags rather than embedding it inline.  resolve_answer_refs
                # fetches each referenced key from memory, applies the JMESPath
                # extraction and formatter, and substitutes the result into the answer
                # string — all without the LLM ever having seen the raw data.
                answer = resolve_answer_refs(answer, host)
                debug(f'rocketride wave done wave_num={wave_num} run_id={run_id}')
                return answer, trace

            # ------------------------------------------------------------------
            # Execute tool calls
            # ------------------------------------------------------------------

            # Guard against a malformed response where tool_calls is missing or
            # empty but done is also not set.  This would cause an infinite loop
            # of empty iterations — stop early and let synthesis handle it.
            tool_calls = result.get('tool_calls') or []
            if not isinstance(tool_calls, list) or not tool_calls:
                debug(f'rocketride wave empty plan wave_num={wave_num} run_id={run_id}, stopping')
                break

            # Inform the UI which tools are about to run this wave
            tool_names = [c.get('tool', '?') for c in tool_calls]
            self.sendSSE('thinking', message=f'Running: {", ".join(tool_names)}', wave=wave_num + 1, tools=tool_names)

            # Execute all tool calls in this wave concurrently.  Each result is
            # stored in memory under "wave-N.rM" and a structural summary is
            # returned.  The summary is what gets injected into the next prompt
            # as context; the full result stays in memory for later peek access.
            results = execute_wave(tool_calls, host=host, wave_name=f'wave-{wave_num}')
            waves.append({'wave_num': wave_num, 'calls': tool_calls, 'results': results})
            self.sendSSE('thinking', message=f'Step {wave_num + 1} complete', results=len(results))

        # ------------------------------------------------------------------
        # Synthesis fallback — max waves reached without done=true
        # ------------------------------------------------------------------

        # If the LLM never converged on a done=true response within max_waves
        # iterations, ask it one final time to produce a best-effort answer
        # from everything that was gathered.  This prevents the agent from
        # silently returning nothing after a long run.
        debug(f'rocketride wave max waves reached run_id={run_id}, synthesizing final answer')
        self.sendSSE('thinking', message='Synthesizing final answer...')
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

        This is a simple single-shot LLM call (no JSON format, no tool calls)
        — the goal is a best-effort human-readable answer from whatever data
        was accumulated before the wave limit was hit.
        """
        # Flatten all wave results into a compact bullet list.
        # Errors are shown explicitly so the LLM can acknowledge data gaps.
        lines: List[str] = []
        for w in waves:
            for r in w.get('results', []):
                tool = r.get('tool', '?')
                if r.get('error'):
                    lines.append(f'- {tool}: ERROR — {r["error"]}')
                else:
                    lines.append(f'- {tool}: {r.get("summary", "")}')

        gathered = '\n'.join(lines) if lines else '(no results gathered)'

        # Build a synthesis prompt from the original question context.
        # Deep-copy to avoid mutating the original AgentInput.
        q = agent_input.question.model_copy(deep=True)
        q.role = 'You are a helpful assistant.'

        # Promote original questions to goals so the LLM understands the
        # objective it is synthesizing toward, rather than treating them as
        # literal questions to answer verbatim.
        for qt in q.questions:
            q.addGoal(qt.text)
        q.questions = []

        q.addContext(f'Information gathered:\n{gathered}')
        q.addQuestion('Based on the above, provide a complete and accurate final answer.')
        try:
            result = host.llm.invoke(IInvokeLLM(op='ask', question=q))
            return extract_text(result)
        except Exception as exc:
            return f'Unable to produce final answer: {exc}'
