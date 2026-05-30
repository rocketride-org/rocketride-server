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

# Server-side sliding window: retain only the most recent N waves in the
# planning context.  Prevents unbounded prompt growth in long-running sessions
# where the LLM omits ``remove`` signals.  Configurable via ``context_window_waves``.
_DEFAULT_CONTEXT_WINDOW_WAVES = 5

# Hard character budget for the aggregate structural summaries injected into
# every planning prompt.  When exceeded, the oldest wave entries are evicted
# until the total is under budget.  Configurable via ``wave_context_budget_chars``.
# 12 000 chars ~= ~3 000 tokens, a safe budget for most provider context windows.
_DEFAULT_WAVE_CONTEXT_BUDGET_CHARS = 12_000


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
        self._max_waves = config.get('max_waves', _DEFAULT_MAX_WAVES)
        self._context_window_waves = int(
            config.get('context_window_waves', _DEFAULT_CONTEXT_WINDOW_WAVES)
        )
        self._wave_context_budget_chars = int(
            config.get('wave_context_budget_chars', _DEFAULT_WAVE_CONTEXT_BUDGET_CHARS)
        )

    # ------------------------------------------------------------------
    # Context pruning
    # ------------------------------------------------------------------

    def _prune_wave_context(self, waves: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Return a token-budget-capped *copy* of the wave history for planning.

        This method never mutates the master ``waves`` list (which feeds the
        observability ``trace``).  It returns a shallow copy with two
        complementary eviction strategies applied:

        1. **Sliding window** — retains only the most recent
           ``context_window_waves`` entries.  This is the primary mechanism:
           it unconditionally bounds worst-case prompt growth.

        2. **Character budget** — if the aggregate length of all structural
           summaries in the window still exceeds ``wave_context_budget_chars``,
           evicts the oldest entries one-by-one until within budget.  This
           handles edge cases where a single wave produces unusually large
           summaries (e.g. a DB query returning hundreds of rows).

        The LLM's ``remove`` signal operates independently on the master
        ``waves`` list and is intentionally preserved; this method adds an
        additional server-side safety net on the planning copy only.

        Returns:
            A new list (shallow copy of wave dicts) safe to pass to
            ``plan_wave()`` without affecting the trace.
        """
        # Work on a copy — the master waves list must never be mutated here.
        # (Wave dicts themselves are not deep-copied because the planner only
        # reads them; it never writes back into the wave history.)
        context: List[Dict[str, Any]] = list(waves)

        # --- Strategy 1: sliding window ---
        window = max(1, self._context_window_waves)
        if len(context) > window:
            context = context[len(context) - window :]

        # --- Strategy 2: character budget ---
        budget = self._wave_context_budget_chars
        if budget <= 0:
            return context  # Budget disabled (0 means unlimited).

        def _total_summary_chars(w_list: List[Dict[str, Any]]) -> int:
            total = 0
            for w in w_list:
                for r in w.get('results', []):
                    total += len(r.get('summary', ''))
            return total

        # Evict oldest entries until within budget or only one wave remains.
        while len(context) > 1 and _total_summary_chars(context) > budget:
            evicted = context.pop(0)
            debug(
                f'rocketride wave context budget: evicted wave {evicted.get("wave_num")} '
                f'(budget={budget} chars) from planning context'
            )

        return context

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

            # waves is the canonical trace (never mutated by the pruner).
            # context_waves is a pruned shallow copy passed to the planner so
            # that the planning prompt stays within the token budget without
            # destroying the historical record in trace['waves'].
            context_waves = self._prune_wave_context(waves)

            # Run the planner — one LLM call with all tool descriptions.
            # Returns either {"done": true, "answer": "..."} or {"tool_calls": [...]}
            # or {} if the LLM response was malformed.
            try:
                result = plan_wave(
                    agent_base=self,
                    context=context,
                    question=question,
                    waves=context_waves,
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
                        context.memory.clear(key)
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
                self.sendSSE(context, 'thinking', message=thought)

            # ------------------------------------------------------------------
            # Done — resolve answer refs and return
            # ------------------------------------------------------------------

            if result.get('done'):
                self.sendSSE(context, 'thinking', message='Generating final answer...')
                answer = safe_str(result.get('answer', ''))

                # Resolve {{memory.ref:key:format:path}} references in the answer.
                # The LLM may reference bulk data (large tables, arrays) via these
                # template tags rather than embedding it inline.  resolve_answer_refs
                # fetches each referenced key from memory, applies the JMESPath
                # extraction and formatter, and substitutes the result into the answer
                # string — all without the LLM ever having seen the raw data.
                answer = resolve_answer_refs(answer, agent_base=self, context=context)
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
            self.sendSSE(
                context, 'thinking', message=f'Running: {", ".join(tool_names)}', wave=wave_num + 1, tools=tool_names
            )

            # Execute all tool calls in this wave concurrently.  Each result is
            # stored in memory under "wave-N.rM" and a structural summary is
            # returned.  The summary is what gets injected into the next prompt
            # as context; the full result stays in memory for later peek access.
            results = execute_wave(tool_calls, agent_base=self, context=context, wave_name=f'wave-{wave_num}')
            waves.append({'wave_num': wave_num, 'calls': tool_calls, 'results': results})
            # NOTE: do NOT call _prune_wave_context(waves) here.
            # Pruning now returns a copy computed at the top of each planning
            # iteration; the master waves list is the immutable trace record.

            self.sendSSE(context, 'thinking', message=f'Step {wave_num + 1} complete', results=len(results))

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
