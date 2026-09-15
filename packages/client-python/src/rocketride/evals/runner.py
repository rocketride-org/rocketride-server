# MIT License
#
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

"""
Eval Runner: Executes Eval Specs Against a Live Pipeline.

This module orchestrates a single eval spec run: it starts the pipeline under
test on the engine, sends each case's input through ``client.chat()``, measures
the chat round-trip latency, evaluates the case's assertions, and always tears
the pipeline down again - even when a case or the pipeline itself fails.

Execution model:
    - Cases run sequentially, in spec order.
    - A case whose ``chat()`` call raises is recorded as a case error (counted
      as failed with the error message preserved); the run continues unless
      ``fail_fast`` is set.
    - Assertions are evaluated on a worker thread (via ``asyncio.to_thread``)
      so that the synchronous LLM-judge callable can schedule judge pipeline
      runs back onto the main event loop without deadlocking.
    - Judge pipelines are themselves ``.pipe`` runs on the same engine; their
      task tokens are cached per judge path for the duration of the spec run
      and terminated together with the main pipeline.
    - Each judge round-trip is bounded by ``judge_timeout`` (default
      ``DEFAULT_JUDGE_TIMEOUT_S``): the judge blocks a worker thread that
      cannot be cancelled, so an unbounded wait would hang the run and skip
      teardown. On expiry the judge call is cancelled and the case is
      recorded as errored.

Components:
    run_spec: Run one EvalSpec against a connected client, returning an EvalReport
    default_judge_pipeline_path: Path of the packaged default judge template
"""

import asyncio
import concurrent.futures
import json
import time
from importlib import resources
from typing import TYPE_CHECKING, Any, Callable

from ..schema import Question
from .assertions import evaluate_assertion
from .reporters import CaseResult, EvalReport
from .spec import EvalCase, EvalSpec

if TYPE_CHECKING:
    from ..client import RocketRideClient

#: Default upper bound (seconds) on a single judge pipeline round-trip.
#:
#: A judge run blocks a worker thread inside ``asyncio.to_thread``, which is
#: not cancellable, so an unbounded wait would hang the whole run and skip
#: pipeline teardown. Five minutes is well above any realistic LLM-judge
#: latency while still guaranteeing the run finishes.
DEFAULT_JUDGE_TIMEOUT_S = 300.0


def default_judge_pipeline_path() -> str:
    """
    Return the path of the default judge pipeline packaged with the SDK.

    The template ships inside the wheel at
    ``rocketride/evals/templates/judge-default.pipe`` so pip-installed users
    get a working LLM judge without any extra setup. Spec-level and per-case
    ``judge_pipeline`` values override it.

    Returns:
        Filesystem path of the packaged default judge template
    """
    return str(resources.files('rocketride.evals').joinpath('templates', 'judge-default.pipe'))


def _first_answer(result: Any) -> str:
    """
    Extract the output text from a chat result.

    The output is the first entry of ``result['answers']`` (an empty string
    when the pipeline returned no answers). Non-string answers (e.g. JSON
    lane output) are serialized to JSON so assertions always see text.

    Args:
        result: The dict returned by ``client.chat()``

    Returns:
        The pipeline output as a string ('' if there were no answers)
    """
    answers = (result or {}).get('answers') or []
    if not answers:
        return ''
    first = answers[0]
    if isinstance(first, str):
        return first
    return json.dumps(first)


def _bind_case_judge(judge: Callable[..., Any] | None, case_judge_pipeline: str | None) -> Callable[..., Any] | None:
    """
    Bind a case-level judge pipeline override into a judge callable.

    The assertion evaluator invokes the judge without knowing which case is
    running, so the per-case ``judge_pipeline`` override is injected here:
    whenever the evaluator leaves ``judge_pipeline`` unset (or None), the
    case's override is substituted. Explicit non-None values win.

    Args:
        judge: The spec-level judge callable (or None when no judge exists)
        case_judge_pipeline: The case's resolved judge pipeline path, if any

    Returns:
        A judge callable with the case override applied, or the original
        judge (or None) when there is nothing to bind
    """
    if judge is None or case_judge_pipeline is None:
        return judge

    def bound_judge(*args: Any, **kwargs: Any) -> Any:
        """Invoke the judge, defaulting ``judge_pipeline`` to the case override."""
        if kwargs.get('judge_pipeline') is None:
            kwargs['judge_pipeline'] = case_judge_pipeline
        return judge(*args, **kwargs)

    return bound_judge


async def _terminate_quietly(client: 'RocketRideClient', token: str) -> None:
    """
    Terminate a pipeline task, swallowing any teardown error.

    Teardown failures must never mask the eval result, mirroring how the CLI
    stop command treats termination as best-effort during cleanup.

    Args:
        client: Connected client to send the terminate request through
        token: Task token of the pipeline to terminate
    """
    try:
        await client.terminate(token)
    except Exception:
        pass


async def _run_case(
    client: 'RocketRideClient',
    token: str,
    case: EvalCase,
    judge: Callable[..., Any] | None,
) -> CaseResult:
    """
    Run a single eval case against an already-started pipeline.

    Sends the case input via ``client.chat()``, measures the round-trip
    duration, then evaluates every assertion on a worker thread. A raising
    ``chat()`` call - or a raising assertion evaluation - is recorded as a
    case error (failed, with the error preserved) rather than propagating,
    so one broken case never aborts the rest of the spec.

    Args:
        client: Connected client for server communication
        token: Task token of the pipeline under test
        case: The eval case to run
        judge: Judge callable for ``llm_judge`` assertions (already bound to
            the spec's default judge pipeline), or None

    Returns:
        CaseResult with the outcome, assertion results, output, and timing
    """
    question = Question()
    question.addQuestion(case.input)

    # Duration covers exactly the chat round-trip, per the latency contract
    chat_started = time.perf_counter()
    try:
        result = await client.chat(token=token, question=question)
    except Exception as err:
        duration_ms = (time.perf_counter() - chat_started) * 1000.0
        return CaseResult(
            name=case.name,
            passed=False,
            assertion_results=[],
            output_text='',
            duration_ms=duration_ms,
            error=str(err),
        )
    duration_ms = (time.perf_counter() - chat_started) * 1000.0

    output_text = _first_answer(result)
    case_judge = _bind_case_judge(judge, case.judge_pipeline)

    def _evaluate_all() -> list:
        """Evaluate every assertion of the case (runs on a worker thread)."""
        return [
            evaluate_assertion(
                assertion,
                output_text=output_text,
                duration_ms=duration_ms,
                case_input=case.input,
                judge=case_judge,
            )
            for assertion in case.expect
        ]

    # Evaluate on a worker thread: the judge callable is synchronous and
    # blocks on judge pipeline runs that are scheduled back onto this event
    # loop, which must stay free to service the underlying websocket.
    try:
        assertion_results = await asyncio.to_thread(_evaluate_all)
    except Exception as err:
        return CaseResult(
            name=case.name,
            passed=False,
            assertion_results=[],
            output_text=output_text,
            duration_ms=duration_ms,
            error=str(err),
        )

    passed = all(item.passed for item in assertion_results)
    return CaseResult(
        name=case.name,
        passed=passed,
        assertion_results=assertion_results,
        output_text=output_text,
        duration_ms=duration_ms,
        error=None,
    )


async def run_spec(
    client: 'RocketRideClient',
    spec: EvalSpec,
    *,
    case_filter: str | None = None,
    fail_fast: bool = False,
    judge_factory: Callable[[Callable[[str, str], str], str], Callable[..., Any]] | None = None,
    judge_timeout: float | None = DEFAULT_JUDGE_TIMEOUT_S,
) -> EvalReport:
    """
    Run all (filtered) cases of an eval spec and return an EvalReport.

    Starts the spec's pipeline via ``client.use()``, runs each case
    sequentially through ``client.chat()``, and always terminates the
    pipeline (and any judge pipelines started on its behalf) when done -
    including when a case errors or evaluation raises. Failures to start
    the pipeline itself propagate to the caller.

    Args:
        client: Connected RocketRideClient used for all engine communication
        spec: The parsed and validated eval spec to run
        case_filter: When set, only cases whose name contains this substring
            are run; a filter that matches nothing yields an empty report
            (and the pipeline is never started)
        fail_fast: Stop after the first failed (or errored) case
        judge_factory: Callable building the LLM-judge function, invoked as
            ``judge_factory(run_pipeline, default_judge_pipeline)`` where
            ``run_pipeline(pipeline_path, prompt) -> str`` executes a judge
            pipeline on the same engine; None disables LLM-judge support
        judge_timeout: Upper bound in seconds on a single judge pipeline
            round-trip (default ``DEFAULT_JUDGE_TIMEOUT_S``). On expiry the
            judge call is cancelled and raises ``TimeoutError``, which is
            recorded against the case so teardown still runs. Pass None to
            wait indefinitely (not recommended: the judge blocks a
            non-cancellable worker thread).

    Returns:
        EvalReport: Per-case results plus the total wall-clock duration

    Raises:
        Exception: Whatever ``client.use()`` raises when the pipeline under
            test cannot be started (no teardown is needed in that case)
    """
    run_started = time.perf_counter()

    selected = [case for case in spec.cases if case_filter is None or case_filter in case.name]
    if not selected:
        duration_ms = (time.perf_counter() - run_started) * 1000.0
        return EvalReport(spec_path=spec.path, pipeline=spec.pipeline, case_results=[], duration_ms=duration_ms)

    # Start the pipeline under test; a start failure propagates to the caller
    started = await client.use(filepath=spec.pipeline, source=spec.source)
    token = started['token']

    # Judge pipelines are started lazily and cached per path for this run
    judge_tokens: dict[str, str] = {}
    loop = asyncio.get_running_loop()

    async def _judge_chat(pipeline_path: str, prompt: str) -> str:
        """Run one judge prompt through a (cached) judge pipeline."""
        judge_token = judge_tokens.get(pipeline_path)
        if judge_token is None:
            judge_started = await client.use(filepath=pipeline_path)
            judge_token = judge_started['token']
            judge_tokens[pipeline_path] = judge_token
        judge_question = Question()
        judge_question.addQuestion(prompt)
        judge_result = await client.chat(token=judge_token, question=judge_question)
        return _first_answer(judge_result)

    def run_pipeline(pipeline_path: str, prompt: str) -> str:
        """
        Execute a judge pipeline synchronously from the evaluation thread.

        Must only be called off the event-loop thread (assertion evaluation
        runs inside ``asyncio.to_thread``); it blocks on a coroutine that is
        scheduled onto the main event loop.

        The wait is bounded by ``judge_timeout``: the worker thread this runs
        on cannot be cancelled, so an unbounded wait on a stalled judge would
        hang the run and skip pipeline teardown. On expiry the scheduled judge
        coroutine is cancelled and a ``TimeoutError`` is raised, which the
        caller records as an assertion/case error and teardown proceeds.
        """
        future = asyncio.run_coroutine_threadsafe(_judge_chat(pipeline_path, prompt), loop)
        try:
            return future.result(timeout=judge_timeout)
        except concurrent.futures.TimeoutError as err:
            future.cancel()
            raise TimeoutError(f'judge pipeline {pipeline_path!r} did not answer within {judge_timeout}s') from err

    case_results: list[CaseResult] = []
    try:
        # Judge setup happens inside the teardown scope: the pipeline under
        # test is already running, so a raising judge_factory must not skip
        # the finally block below.
        judge: Callable[..., Any] | None = None
        if judge_factory is not None:
            judge = judge_factory(run_pipeline, spec.judge_pipeline or default_judge_pipeline_path())

        for case in selected:
            case_result = await _run_case(client, token, case, judge)
            case_results.append(case_result)
            if fail_fast and not case_result.passed:
                break
    finally:
        # Teardown is unconditional: the pipeline under test first, then any
        # judge pipelines that were started on its behalf.
        await _terminate_quietly(client, token)
        for judge_token in judge_tokens.values():
            await _terminate_quietly(client, judge_token)

    duration_ms = (time.perf_counter() - run_started) * 1000.0
    return EvalReport(spec_path=spec.path, pipeline=spec.pipeline, case_results=case_results, duration_ms=duration_ms)
