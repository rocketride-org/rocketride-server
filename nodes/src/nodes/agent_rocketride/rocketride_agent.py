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

from rocketlib import debug, error, warning

from ai.common.agent import AgentBase, AgentContext
from ai.common.agent.types import AgentRunResult
from ai.common.config import Config
from ai.common.schema import Question

from ai.common.utils import safe_str

from .planner import plan as plan_wave
from .executor import execute_wave, resolve_answer_refs

# Default hard cap on planning iterations before the synthesis fallback fires.
# Prevents runaway loops if the LLM fails to converge on done=true.
# Can be overridden via the ``max_waves`` node configuration field.
_DEFAULT_MAX_WAVES = 10

# Bounds declared for ``max_waves`` in services.json. Schema minimum/maximum
# are not enforced at config validation, so an out-of-range value (e.g. 60)
# used to be accepted and run as-is; clamp here so the schema's stated
# contract holds at runtime.
_MAX_WAVES_BOUNDS = (1, 50)


def _resolve_max_waves(value: Any) -> int:
    """Return ``max_waves`` as an int clamped to the services.json bounds.

    Non-numeric values fall back to the default rather than failing later
    inside the wave loop.
    """
    lo, hi = _MAX_WAVES_BOUNDS
    try:
        waves = int(value)
    except (TypeError, ValueError):
        warning(f'agent_rocketride: max_waves={value!r} is not an integer; using {_DEFAULT_MAX_WAVES}')
        return _DEFAULT_MAX_WAVES
    if waves < lo or waves > hi:
        clamped = max(lo, min(hi, waves))
        warning(f'agent_rocketride: max_waves={waves} is outside the schema bounds [{lo}, {hi}]; using {clamped}')
        return clamped
    return waves


class RocketRideDriver(AgentBase):
    """
    RocketRide Wave framework driver.

    Subclasses AgentBase and implements the wave-planning execution loop.
    The Wave loop is its own framework — there are no third-party agent
    libraries to wrap, so there are no `_build_llm` / `_build_tools`
    methods.  All host calls go through `self.call_llm(context, ...)` and
    `self.call_tool(context, ...)` like every other driver, but the
    planner builds its own structured `Question` objects (because the
    wave algorithm needs prompt structure that flatten-to-transcript
    would destroy) and passes them to `call_llm` via the polymorphic
    `prompt: Union[Question, Any]` parameter.
    """

    FRAMEWORK = 'wave'
    REQUIRES_MEMORY = True

    def __init__(self, iGlobal) -> None:
        """Initialize the Wave driver and load host services."""
        super().__init__(iGlobal)
        config = Config.getNodeConfig(iGlobal.glb.logicalType, iGlobal.glb.connConfig)
        self._max_waves = _resolve_max_waves(config.get('max_waves', _DEFAULT_MAX_WAVES))

    # ------------------------------------------------------------------
    # Main driver
    # ------------------------------------------------------------------

    def _run(
        self,
        *,
        context: AgentContext,
        question: Question,
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
        run_id = context.run_id
        debug(f'rocketride wave _run start run_id={run_id}')
        self.sendSSE(context, 'thinking', message='Analyzing your request...')

        # waves accumulates the full history of every tool call and its result
        # summary.  It is passed to plan_wave() each iteration so the planner
        # can inject all prior results into the prompt as context.
        waves: List[Dict[str, Any]] = []

        # Fingerprint of each stored result mapped to the key holding it, so a later
        # identical result can name it. Rebuilt per run, never shared across runs.
        self.seen_results: Dict[str, str] = {}

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
            self.sendSSE(context, 'thinking', message=f'Planning step {wave_num + 1}...')

            # Run the planner — one LLM call with all tool descriptions, checked
            # by normalize_plan. Returns a plan with a bool "done" and a clean
            # "tool_calls" list, or only the problems if even a second try was unusable.
            try:
                result = plan_wave(
                    agent_base=self,
                    context=context,
                    question=question,
                    waves=waves,
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
                        context.memory.clear(key)
                    except Exception as exc:
                        debug(f'rocketride wave remove key={key!r} failed: {exc}')
                # Strip removed result entries from wave history to keep context lean
                for w in waves:
                    w['results'] = [r for r in w.get('results', []) if r.get('key') not in remove_keys]
                # Drop wave entries that are now completely empty (all results pruned)
                waves[:] = [w for w in waves if w.get('results')]
                # Forget fingerprints for cleared keys, or a later note would point at
                # a key that no longer resolves.
                self.seen_results = {f: k for f, k in self.seen_results.items() if k not in remove_keys}

            # Surface the LLM's thought to the UI — one-sentence description of
            # what the agent is doing this turn.  Shown in the "thinking" panel.
            thought = safe_str(result.get('thought', ''))
            if thought:
                self.sendSSE(context, 'thinking', message=thought)

            # ------------------------------------------------------------------
            # Done — resolve answer refs and return
            # ------------------------------------------------------------------

            tool_calls = result.get('tool_calls') or []
            if result.get('done') and not tool_calls:
                debug(f'rocketride wave done wave_num={wave_num} run_id={run_id}')
                # Problems in a final reply (an unusable "remove") reach no later
                # prompt, so the trace keeps them.
                notes = [
                    {'tool': 'reply-check', 'key': f'wave-{wave_num}.check{i}', 'note': f'Ignored: {problem}'}
                    for i, problem in enumerate(result.get('problems') or [])
                ]
                if notes:
                    waves.append({'wave_num': wave_num, 'calls': [], 'results': notes})
                return self._final_answer(result, context), trace

            # ------------------------------------------------------------------
            # Execute tool calls
            # ------------------------------------------------------------------

            # Guard against a malformed response where tool_calls is missing or
            # empty but done is also not set.  This would cause an infinite loop
            # of empty iterations — stop early and let synthesis handle it.
            if not tool_calls:
                debug(f'rocketride wave empty plan wave_num={wave_num} run_id={run_id}, stopping')
                # Why the reply was unusable goes on record (the trace, and the fallback
                # answer's prompt), so a dropped call does not vanish silently.
                problems = result.get('problems') or []
                if problems:
                    results = [
                        {'tool': 'reply-check', 'key': f'wave-{wave_num}.check{i}', 'error': f'Skipped: {problem}'}
                        for i, problem in enumerate(problems)
                    ]
                    waves.append({'wave_num': wave_num, 'calls': [], 'results': results})
                break

            # Inform the UI which tools are about to run this wave
            tool_names = [c.get('tool', '?') for c in tool_calls]
            self.sendSSE(
                context, 'thinking', message=f'Running: {", ".join(tool_names)}', wave=wave_num + 1, tools=tool_names
            )

            # Execute all tool calls in this wave concurrently.  Each result is
            # stored in memory under "wave-N.rM" and a structural summary is
            # returned.  The summary is what gets injected into the next prompt
            # as context; the full result stays in memory for later peek access.
            results = execute_wave(tool_calls, agent_base=self, context=context, wave_name=f'wave-{wave_num}')

            # Calls the planner had to drop from this reply are listed with the
            # results, as errors, so the model sees what did not run and why.
            # Problems with "remove" only tidy memory, so they are notes, not errors.
            for i, problem in enumerate(result.get('problems') or []):
                key = f'wave-{wave_num}.check{i}'
                if problem.startswith('remove'):
                    results.append({'tool': 'reply-check', 'key': key, 'note': f'Ignored: {problem}'})
                else:
                    results.append({'tool': 'reply-check', 'key': key, 'error': f'Skipped: {problem}'})

            waves.append({'wave_num': wave_num, 'calls': tool_calls, 'results': results})
            self.sendSSE(context, 'thinking', message=f'Step {wave_num + 1} complete', results=len(results))

            # A reply that both asked for calls and set done=true: the calls have
            # run, and if every one succeeded its answer stands, with no extra
            # round. If any failed (raised, or returned a failure) or was skipped,
            # the model sees why and goes on.
            if result.get('done') and not any(r.get('error') or r.get('failed') for r in results):
                debug(f'rocketride wave done after its calls wave_num={wave_num} run_id={run_id}')
                return self._final_answer(result, context), trace

        # ------------------------------------------------------------------
        # Synthesis fallback — max waves reached without done=true
        # ------------------------------------------------------------------

        # If the LLM never converged on a done=true response within max_waves
        # iterations, ask it one final time to produce a best-effort answer
        # from everything that was gathered.  This prevents the agent from
        # silently returning nothing after a long run.
        debug(f'rocketride wave max waves reached run_id={run_id}, synthesizing final answer')
        self.sendSSE(context, 'thinking', message='Synthesizing final answer...')
        return self._synthesize(question=question, waves=waves, context=context), trace

    # ------------------------------------------------------------------
    # Final answer
    # ------------------------------------------------------------------

    def _final_answer(self, result: Dict[str, Any], context: AgentContext) -> str:
        """Return the answer of a done=true plan, with its memory refs filled in."""
        self.sendSSE(context, 'thinking', message='Generating final answer...')
        answer = safe_str(result.get('answer', ''))

        # Resolve {{memory.ref:key:format:path}} references in the answer.
        # The LLM may reference bulk data (large tables, arrays) via these
        # template tags rather than embedding it inline.  resolve_answer_refs
        # fetches each referenced key from memory, applies the JMESPath
        # extraction and formatter, and substitutes the result into the answer
        # string — all without the LLM ever having seen the raw data.
        return resolve_answer_refs(answer, agent_base=self, context=context)

    # ------------------------------------------------------------------
    # Final synthesis (fallback when max waves exhausted)
    # ------------------------------------------------------------------

    def _synthesize(
        self,
        *,
        question: Question,
        waves: List[Dict[str, Any]],
        context: AgentContext,
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
                elif r.get('failed'):
                    # The call returned, but its result says it failed: the summary's
                    # sample may not show where, so the fallback must not read it as success.
                    lines.append(f'- {tool}: FAILED (the result reports a failure) — {r.get("summary", "")}')
                else:
                    lines.append(f'- {tool}: {r.get("summary", "")}')

        gathered = '\n'.join(lines) if lines else '(no results gathered)'

        # Build a synthesis prompt from the original question context.
        # Deep-copy to avoid mutating the original question.
        q = question.model_copy(deep=True)
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
            return self.call_llm(context, q)
        except Exception as exc:
            return f'Unable to produce final answer: {exc}'
