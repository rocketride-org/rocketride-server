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

import dataclasses
import json
from typing import Any, Dict, List, Optional

from rocketlib import debug, error

from ai.common.agent import AgentBase, AgentContext
from ai.common.agent.types import AgentRunResult
from ai.common.config import Config
from ai.common.schema import Question

from ai.common.utils import safe_str

from .planner import plan as plan_wave
from .executor import execute_wave, resolve_answer_refs
from .run_state import RunMemory, RunState

# Default hard cap on planning iterations before the synthesis fallback fires.
# Prevents runaway loops if the LLM fails to converge on done=true.
# Can be overridden via the ``max_waves`` node configuration field.
_DEFAULT_MAX_WAVES = 10

# How much of each memory.peek result the synthesis fallback includes. Peeks are
# targeted reads, so this is usually all of it; the cap bounds a wide one, and the
# line then says where it was cut.
_SYNTHESIS_PREVIEW_CHARS = 2000


def _tool_timeout(value: Any) -> Optional[float]:
    """Read the tool_timeout setting: seconds, None when unset (the executor's default), 0 for no limit."""
    if value is None or value == '':
        return None
    try:
        return max(0.0, float(value))
    except (TypeError, ValueError):
        return None


def _verify_args(value: Any) -> Optional[Dict[str, Any]]:
    """Read the node's verify_args setting: the check call's exact arguments, or None.

    The setting holds a JSON object as text ('{"command": "npm test"}'). A value
    that is not one is a configuration error, raised at once: ignoring it would
    quietly let any call to the check tool count as a check again.
    """
    if value is None or (isinstance(value, str) and not value.strip()):
        return None
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError as exc:
            raise ValueError(f'verify_args is not valid JSON: {exc}') from exc
    if not isinstance(value, dict):
        raise ValueError('verify_args must be a JSON object, such as {"command": "npm test"}')
    return value


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

    # No check tool unless the node config names one (see __init__). A class-level
    # default keeps a driver built without __init__ (as unit tests do) working.
    _verify_tool: str = ''
    _verify_args: Optional[Dict[str, Any]] = None
    _tool_timeout_s: Optional[float] = None

    def __init__(self, iGlobal) -> None:
        """Initialize the Wave driver and load host services."""
        super().__init__(iGlobal)
        config = Config.getNodeConfig(iGlobal.glb.logicalType, iGlobal.glb.connConfig)
        self._max_waves = config.get('max_waves', _DEFAULT_MAX_WAVES)
        # Optional tool that checks the work (e.g. "workspace.compile"). When set,
        # the planner must run it after its last change before it may finish.
        self._verify_tool = safe_str(config.get('verify_tool') or '').strip()
        # Optional exact arguments of that check. A general runner (a command or code
        # tool) could otherwise make a change through the check tool and have it count
        # as a passing check; with these set, only this exact call checks the work.
        self._verify_args = _verify_args(config.get('verify_args'))
        # Seconds one tool call may take (0: no limit); unset uses the executor's default.
        self._tool_timeout_s = _tool_timeout(config.get('tool_timeout'))

    # ------------------------------------------------------------------
    # Main driver
    # ------------------------------------------------------------------

    def _run(
        self,
        *,
        context: AgentContext,
        question: Question,
    ) -> AgentRunResult:
        """Run one request with its own state and its own memory key space.

        This driver object is shared by every run of the node, and runs can
        overlap, so nothing a run remembers is kept on ``self``. The run's memory
        keys are cleared when it ends.

        A tool call the wave gave up on is still running inside the engine, and
        returns into the pipeline's state. The engine tears a pipeline down, or
        hands it to the next request, once every request in it has ended, so the
        run does not end while such a call is running: it waits for every one,
        without a limit. A call returning into a torn-down or reused pipeline would
        read freed state. The cost: a tool that never returns holds the run (the
        model has already been told it timed out and has answered). Ending the run
        sooner and safely needs the engine to track invokes in flight.
        """
        memory = RunMemory(context.memory, context.run_id) if context.memory is not None else None
        run_context = dataclasses.replace(context, memory=memory)
        state = RunState()
        try:
            return self._run_waves(context=run_context, question=question, state=state)
        finally:
            running = state.background.running()
            if running:
                error(
                    f'rocketride wave: waiting for {running} timed-out tool call(s) to return before the run ends; '
                    'a call still inside the engine must not outlive the pipeline'
                )
                state.background.wait(None)
            if memory is not None:
                memory.close()  # never raises: cleanup must not replace the answer

    def _run_waves(
        self,
        *,
        context: AgentContext,
        question: Question,
        state: RunState,
    ) -> AgentRunResult:
        """Execute the wave-planning loop.

        Each iteration:
          1. Calls plan_wave() which builds the full prompt and fires one LLM call.
          2. Extracts scratch (persistent working notes) from the LLM response.
          3. Surfaces the LLM's thought to the UI via SSE.
          4. If done=true with no calls, resolves {{memory.ref:...}} template refs
             in the answer and returns.
          5. Otherwise, executes the tool_calls in parallel. If the reply also set
             done=true and every call succeeded, returns its answer.
          6. Prunes memory keys the LLM has finished with (remove field) and loops.

        The trace records why the run stopped: done, max_waves, empty_plan or error.

        Returns:
            A ``(content, trace)`` tuple consumed by ``AgentBase.run_agent``.
        """
        run_id = context.run_id
        debug(f'rocketride wave _run start run_id={run_id}')
        self._require_check_tool(context)
        self.sendSSE(context, 'thinking', message='Analyzing your request...')

        # waves accumulates the full history of every tool call and its result
        # summary.  It is passed to plan_wave() each iteration so the planner
        # can inject all prior results into the prompt as context.
        waves: List[Dict[str, Any]] = []

        # The last step whose checks all passed, and the last step that ran any other
        # tool (even one that failed) or saw a timed-out call return. -1 means "not
        # yet". See _not_checked().
        last_check = last_change = -1
        late_returns = 0

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
                    verify_tool=self._verify_tool,
                    verify_args=self._verify_args,
                )
            except Exception as exc:
                error(f'rocketride wave plan failed run_id={run_id}: {exc}')
                trace['stop_reason'] = 'error'
                trace['error'] = f'{type(exc).__name__}: {exc}'
                # A retry that failed after an unusable reply carries that reply's notes.
                current_scratch = safe_str(getattr(exc, 'wave_scratch', '')) or current_scratch
                if not waves and not current_scratch:
                    # Nothing was gathered, so there is nothing to save; the cause
                    # (a bad key, a rate limit, an unreadable reply) is the useful part.
                    self.sendSSE(context, 'thinking', message='Planning failed.', stop_reason='error')
                    return f'LLM error: {exc}', trace
                # Work was gathered: answer from it instead of discarding it.
                self.sendSSE(
                    context,
                    'thinking',
                    message='Planning failed; answering from what was gathered...',
                    stop_reason='error',
                )
                return self._synthesize(question=question, waves=waves, context=context, scratch=current_scratch), trace

            # Update scratch from the LLM response.  Fall back to the previous
            # scratch if the LLM returned an empty string — we never want to
            # lose accumulated working notes due to an accidental empty response.
            current_scratch = safe_str(result.get('scratch', '')) or current_scratch
            trace['scratch'] = current_scratch

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
                running, returned = state.background.snapshot()
                if returned != late_returns:
                    late_returns, last_change = returned, wave_num
                refusal = self._not_checked(last_check, last_change, running)
                # Problems in this reply (an unusable "remove") are kept: in the trace
                # when the run ends here, in the next prompt when it does not.
                notes = [
                    {'tool': 'reply-check', 'key': f'wave-{wave_num}.check{i}', 'note': f'Ignored: {problem}'}
                    for i, problem in enumerate(result.get('problems') or [])
                ]
                if not refusal:
                    debug(f'rocketride wave done wave_num={wave_num} run_id={run_id}')
                    if notes:
                        waves.append({'wave_num': wave_num, 'calls': [], 'results': notes})
                    trace['stop_reason'] = 'done'
                    answer = self._final_answer(result, context)
                    self._clear_keys(result.get('remove') or [], context)  # after the answer has used them
                    return answer, trace
                # The work changed after its last passing check: tell the model, and go
                # on. Its "remove" list is not applied: the answer it sends again may
                # still need those keys.
                waves.append({'wave_num': wave_num, 'calls': [], 'results': [self._refusal(wave_num, refusal), *notes]})
                continue

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
                trace['stop_reason'] = 'empty_plan'
                break

            # Inform the UI which tools are about to run this wave
            tool_names = [c.get('tool', '?') for c in tool_calls]
            self.sendSSE(
                context, 'thinking', message=f'Running: {", ".join(tool_names)}', wave=wave_num + 1, tools=tool_names
            )

            # Keys this reply removes are cleared after the wave, so its calls can still
            # read them, but their result fingerprints are forgotten now: a duplicate
            # note made during this wave must not point at a key that is about to
            # disappear. Call fingerprints stay, so a repeat of a removed call is named
            # (see RunState.forget). A reply that asks to finish keeps its keys if it is
            # sent back (see the pruning below), so it keeps their fingerprints too. Only
            # results from earlier waves can be removed: a key this wave's calls are about
            # to be stored under would otherwise clear a result just fetched.
            earlier = {r.get('key') for w in waves for r in w.get('results', [])}
            remove_keys = [k for k in result.get('remove') or [] if k in earlier]
            if remove_keys and not result.get('asked_done'):
                state.forget(remove_keys)

            # Execute all tool calls in this wave concurrently.  Each result is
            # stored in memory under "wave-N.rM" and a structural summary is
            # returned.  The summary is what gets injected into the next prompt
            # as context; the full result stays in memory for later peek access.
            results = execute_wave(
                tool_calls,
                agent_base=self,
                context=context,
                wave_name=f'wave-{wave_num}',
                state=state,
                timeout=self._tool_timeout_s,
                check_tool=self._verify_tool,
                check_args=self._verify_args,
            )

            # Calls the planner had to drop from this reply are listed with the
            # results, as errors, so the model sees what did not run and why.
            # Problems with "remove" only tidy memory, so they are notes, not errors.
            for i, problem in enumerate(result.get('problems') or []):
                key = f'wave-{wave_num}.check{i}'
                if problem.startswith('remove'):
                    results.append({'tool': 'reply-check', 'key': key, 'note': f'Ignored: {problem}'})
                else:
                    results.append({'tool': 'reply-check', 'key': key, 'error': f'Skipped: {problem}'})

            checks = [r for i, r in enumerate(results) if self._is_check(r, tool_calls, i)]
            if checks:
                # The newest check decides: if any check in this step raised or
                # reported a failure, the work is unchecked again, whatever passed before.
                last_check = -1 if any(r.get('error') or r.get('failed') for r in checks) else wave_num
            if any(
                r.get('tool') not in ('memory.peek', 'reply-check') and not self._is_check(r, tool_calls, i)
                for i, r in enumerate(results)
            ):
                # Any other call counts as a change, even one that failed: a write
                # may have landed before its result could be stored.
                last_change = wave_num
            # One snapshot for this step's decisions: a call returning between two
            # reads would be counted neither as running nor as returned.
            running, returned = state.background.snapshot()
            if returned != late_returns:
                # A call the wave gave up on returned while this step ran, or before
                # it: what it did may have landed after this step's check read the work.
                late_returns, last_change = returned, wave_num

            # A reply that both asked for calls and set done=true: the calls have
            # run, and if every one succeeded its answer stands, with no extra
            # round. If any failed (raised, or returned a failure) or was skipped,
            # the model sees why and goes on. A check that ran in this same reply
            # has not been seen by the model yet, so its answer cannot rest on it.
            # Only a real check counts here: with verify_args, another call to the
            # tool is a change, and the refusal below asks for the check after it.
            finished = result.get('done') and not any(r.get('error') or r.get('failed') for r in results)
            if finished and checks:
                finished = False
                results.append(
                    self._refusal(wave_num, f'Not finished: read the result of {self._verify_tool} before done=true.')
                )
            elif finished:
                refusal = self._not_checked(last_check, last_change, running)
                if refusal:
                    finished = False
                    results.append(self._refusal(wave_num, refusal))

            waves.append({'wave_num': wave_num, 'calls': tool_calls, 'results': results})
            self.sendSSE(context, 'thinking', message=f'Step {wave_num + 1} complete', results=len(results))

            if finished:
                debug(f'rocketride wave done after its calls wave_num={wave_num} run_id={run_id}')
                trace['stop_reason'] = 'done'
                answer = self._final_answer(result, context)
                self._clear_keys(remove_keys, context)  # after the answer has used them
                return answer, trace

            # ------------------------------------------------------------------
            # Memory pruning — evict keys the LLM is done with
            # ------------------------------------------------------------------

            # Runs only when the loop goes on: the answer above was already built,
            # so a key this reply both removes and references is still there.
            # The LLM signals via the remove field which memory keys it no
            # longer needs.  We clear them from the memory store and strip them
            # from wave history so they don't re-appear in the next prompt.
            # This keeps the "Previous tool results" context lean as the session
            # progresses and old intermediate results become irrelevant.
            # A reply that asked to finish but did not (a call failed or could not be
            # read, or the check rule sent it back) keeps its keys: the model has not
            # yet read what these calls returned, and its next answer may still need them.
            if remove_keys and not result.get('asked_done'):
                self._clear_keys(remove_keys, context)
                state.removed.update(remove_keys)
                # Strip removed result entries from wave history to keep context lean
                for w in waves:
                    w['results'] = [r for r in w.get('results', []) if r.get('key') not in remove_keys]
                # Drop wave entries that are now completely empty (all results pruned)
                waves[:] = [w for w in waves if w.get('results')]

        # ------------------------------------------------------------------
        # Synthesis fallback — max waves reached, or an unusable plan
        # ------------------------------------------------------------------

        # If the LLM never converged on a done=true response within max_waves
        # iterations, ask it one final time to produce a best-effort answer
        # from everything that was gathered.  This prevents the agent from
        # silently returning nothing after a long run. The stop reason travels
        # with the trace and the last status event, so a caller can tell this
        # answer from a finished one.
        trace.setdefault('stop_reason', 'max_waves')
        debug(f'rocketride wave stopping ({trace["stop_reason"]}) run_id={run_id}, synthesizing final answer')
        self.sendSSE(context, 'thinking', message='Synthesizing final answer...', stop_reason=trace['stop_reason'])
        return self._synthesize(question=question, waves=waves, context=context, scratch=current_scratch), trace

    # ------------------------------------------------------------------
    # Check-tool rule
    # ------------------------------------------------------------------

    def _require_check_tool(self, context: AgentContext) -> None:
        """Stop the run at its start when verify_tool names no connected tool.

        No check could pass then, so every done reply would be sent back until the run
        used up its waves, with nothing to say why. The tool list is known only per run.
        """
        if not self._verify_tool:
            return
        names = []
        for td in getattr(context.tools, 'list', None) or []:
            name = td.get('name', '') if isinstance(td, dict) else safe_str(getattr(td, 'name', ''))
            if name:
                names.append(name)
        if self._verify_tool in names:
            return
        # The catalog is read once per tool node. get() re-queries the owning node, in
        # case it has grown the tool since, and raises when the tool is still unknown.
        lookup = getattr(context.tools, 'get', None)
        if callable(lookup):
            try:
                lookup(self._verify_tool)
                return
            except Exception as exc:
                debug(f'rocketride wave verify_tool lookup failed: {type(exc).__name__}: {exc}')
        connected = ', '.join(sorted(names)) or 'none'
        raise ValueError(f'verify_tool {self._verify_tool!r} is not a connected tool (connected: {connected})')

    def _not_checked(self, last_check: int, last_change: int, running: int = 0) -> str:
        """Return why the run may not finish yet, or '' if it may.

        With a check tool configured, the last change must be followed by a passing
        check in a later step. A check in the same step ran in parallel with the
        change, so it may have checked the code before the change landed. And while
        a call the wave gave up on is still running, no check covers it: it may
        still write. When it returns it counts as a change (see _run_waves).
        """
        if self._verify_tool and running:
            return (
                f'Not finished: {running} call(s) that timed out are still running and may still change '
                f'the work. A check cannot cover them yet; call {self._verify_tool} again after they end.'
            )
        if self._verify_tool and last_change >= 0 and last_check <= last_change:
            return (
                f'Not finished: call {self._check_call()} on its own, after your last change, '
                'and fix what it reports before done=true.'
            )
        return ''

    def _check_call(self) -> str:
        """The check as the model must call it: the tool, and its exact arguments when the node fixes them."""
        if self._verify_args is None:
            return self._verify_tool
        return f'{self._verify_tool} with exactly {json.dumps(self._verify_args, ensure_ascii=False)}'

    def _is_check(self, result: Dict[str, Any], tool_calls: List[Dict[str, Any]], index: int) -> bool:
        """True when *result* (the one at *index* of a step) came from the check.

        That is the check tool, called with the node's verify_args when it sets
        them. A step's results come back in the order of its calls, and the calls
        keep the arguments as the model wrote them.
        """
        if not self._verify_tool or result.get('tool') != self._verify_tool:
            return False
        if self._verify_args is None:
            return True
        call = tool_calls[index] if index < len(tool_calls) else {}
        return (call.get('args') or {}) == self._verify_args

    @staticmethod
    def _refusal(wave_num: int, message: str) -> Dict[str, Any]:
        """A result entry telling the model why its done=true was not accepted."""
        return {'tool': 'reply-check', 'key': f'wave-{wave_num}.done', 'error': message}

    # ------------------------------------------------------------------
    # Final answer
    # ------------------------------------------------------------------

    @staticmethod
    def _clear_keys(keys: List[str], context: AgentContext) -> None:
        """Clear memory keys the model is done with; a failed clear only costs memory."""
        for key in keys or []:
            # The memory node reads a clear with no key as "clear everything".
            if not isinstance(key, str) or not key.strip():
                continue
            try:
                context.memory.clear(key)
            except Exception as exc:
                debug(f'rocketride wave remove key={key!r} failed: {exc}')

    def _final_answer(self, result: Dict[str, Any], context: AgentContext) -> str:
        """Return the answer of a done=true plan, with its memory refs filled in."""
        self.sendSSE(context, 'thinking', message='Generating final answer...', stop_reason='done')
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
        scratch: str = '',
    ) -> str:
        """Ask the LLM to produce a final answer from all gathered results.

        Collects tool result summaries from every wave into a compact
        bullet list, adds the scratch notes the model kept, and asks the
        LLM to synthesize a coherent answer.

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
                elif 'preview' in r:
                    # memory.peek results carry their data in "preview", not "summary".
                    lines.append(f'- {tool}: {_peek_line(r)}')
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
        # The notes are where the model kept what it had worked out (counts, names,
        # conclusions); without them the fallback can only re-derive from summaries.
        if scratch:
            q.addContext(f'Your working notes from the steps so far:\n{scratch}')
        q.addQuestion(
            'Based on the above, provide a complete and accurate final answer. '
            'The work stopped before it was finished: if something the goal needs is '
            'still unknown, say what is missing rather than guessing.'
        )
        try:
            answer = self.call_llm(context, q)
        except Exception as exc:
            # The model cannot be reached for the answer either. Hand the user what
            # was gathered, as it stands, rather than only the error.
            return _partial_report(f'the model call failed ({type(exc).__name__}: {exc})', lines, scratch)
        if not safe_str(answer).strip():
            # An empty reply is no answer either; the gathered facts still are.
            return _partial_report('the model returned no text', lines, scratch)
        return answer


def _peek_line(r: Dict[str, Any]) -> str:
    """A memory.peek result as one line: what was read, the data, and whether it is all of it."""
    text = safe_str(r.get('preview', ''))
    if len(text) > _SYNTHESIS_PREVIEW_CHARS:
        text = (
            f'{text[:_SYNTHESIS_PREVIEW_CHARS]} ... (cut at {_SYNTHESIS_PREVIEW_CHARS:,} of {len(text):,} characters)'
        )
    notes = []
    if r.get('truncated'):
        notes.append(f'showing {r.get("returned_items")} of {r.get("total_items")} items')
    # This runs outside the fallback's try block, so a count that is not a number
    # must not raise here and cost the user the gathered work.
    if isinstance(r.get('total_chars'), int):
        start = int(r.get('offset') or 0)
        notes.append(f'characters {start:,} to {start + int(r.get("length") or 0):,} of {r["total_chars"]:,}')
    where = f'{r["path"]} = ' if r.get('path') else ''
    return where + text + (f' ({"; ".join(notes)})' if notes else '')


def _partial_report(cause: str, lines: List[str], scratch: str) -> str:
    """The answer when the fallback call fails or returns nothing: the cause, then the gathered facts."""
    parts = [f'I could not finish: {cause}.']
    if scratch:
        parts += ['', 'My working notes:', scratch]
    if lines:
        # Whole lines: each is already bounded (a summary by its budget, a peek by
        # _SYNTHESIS_PREVIEW_CHARS, with a note where it was cut), and these facts
        # are all the user gets.
        parts += ['', 'What I gathered:', *lines]
    return '\n'.join(parts)
