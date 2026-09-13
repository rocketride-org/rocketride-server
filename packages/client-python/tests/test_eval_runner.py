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
Unit tests for the eval runner (rocketride.evals.runner.run_spec).

Exercises the orchestration logic with a fake client and a patched assertion
evaluator, so no server is required: use/chat/terminate call order, per-case
error isolation, fail-fast, case filtering, guaranteed teardown (including
when evaluation raises), judge factory wiring, and the per-case judge
pipeline override.
"""

import asyncio
from typing import Any

import pytest

from rocketride.evals import runner as runner_module
from rocketride.evals.assertions import AssertionResult
from rocketride.evals.spec import AssertionSpec, EvalCase, EvalSpec


class FakeClient:
    """Minimal stand-in for RocketRideClient recording every engine call."""

    def __init__(self, chat_results=None, use_error=None):
        """
        Initialize the fake client.

        Args:
            chat_results: Answers (str) or exceptions consumed per chat() call;
                when exhausted, chat() answers 'ok'
            use_error: Exception to raise from use(), if any
        """
        self.calls: list[tuple[str, Any]] = []
        self.chat_results = list(chat_results or [])
        self.use_error = use_error
        self._token_counter = 0

    async def use(self, *, filepath=None, source=None, **kwargs):
        """Record the call and hand out a fresh task token."""
        if self.use_error is not None:
            raise self.use_error
        self._token_counter += 1
        token = f'task-{self._token_counter}'
        self.calls.append(('use', {'filepath': filepath, 'source': source, 'token': token}))
        return {'token': token}

    async def chat(self, *, token, question, on_sse=None):
        """Record the call and return (or raise) the next queued result."""
        self.calls.append(('chat', {'token': token, 'question': question.questions[0].text}))
        result = self.chat_results.pop(0) if self.chat_results else 'ok'
        if isinstance(result, Exception):
            raise result
        if result is None:
            return {'answers': []}
        return {'answers': [result]}

    async def terminate(self, token):
        """Record the teardown call."""
        self.calls.append(('terminate', token))

    def call_kinds(self):
        """Return the ordered list of call kinds for order assertions."""
        return [kind for kind, _ in self.calls]

    def terminated_tokens(self):
        """Return every token that was terminated."""
        return [payload for kind, payload in self.calls if kind == 'terminate']


def make_case(name='greeting', input_text='Say hello', judge_pipeline=None, assertions=1):
    """Build an EvalCase with the requested number of contains assertions."""
    expect = [AssertionSpec(type='contains', params={'value': 'x'}) for _ in range(assertions)]
    return EvalCase(name=name, input=input_text, expect=expect, judge_pipeline=judge_pipeline)


def make_spec(cases, source=None, judge_pipeline=None):
    """Build an EvalSpec around the given cases."""
    return EvalSpec(
        path='suite.eval.json',
        pipeline='/abs/chat.pipe',
        source=source,
        judge_pipeline=judge_pipeline,
        cases=cases,
    )


def passing_evaluate(assertion, *, output_text, duration_ms, case_input, judge):
    """Assertion evaluator stub that always passes."""
    return AssertionResult(spec=assertion, passed=True, detail='')


def failing_evaluate(assertion, *, output_text, duration_ms, case_input, judge):
    """Assertion evaluator stub that always fails."""
    return AssertionResult(spec=assertion, passed=False, detail='nope')


class TestRunSpecOrchestration:
    async def test_use_chat_terminate_call_order(self, monkeypatch):
        monkeypatch.setattr(runner_module, 'evaluate_assertion', passing_evaluate)
        fake = FakeClient(chat_results=['hello there', 'goodbye'])
        spec = make_spec([make_case('greeting'), make_case('farewell', 'Say goodbye')], source='webhook_1')

        report = await runner_module.run_spec(fake, spec, case_filter=None, fail_fast=False, judge_factory=None)

        assert fake.call_kinds() == ['use', 'chat', 'chat', 'terminate']
        use_call = fake.calls[0][1]
        assert use_call['filepath'] == '/abs/chat.pipe'
        assert use_call['source'] == 'webhook_1'
        assert fake.terminated_tokens() == ['task-1']
        assert report.spec_path == 'suite.eval.json'
        assert report.pipeline == '/abs/chat.pipe'
        assert [case.name for case in report.case_results] == ['greeting', 'farewell']
        assert all(case.passed for case in report.case_results)
        assert report.duration_ms > 0

    async def test_output_text_is_first_answer(self, monkeypatch):
        seen = {}

        def recording_evaluate(assertion, *, output_text, duration_ms, case_input, judge):
            seen['output_text'] = output_text
            seen['duration_ms'] = duration_ms
            seen['case_input'] = case_input
            return AssertionResult(spec=assertion, passed=True, detail='')

        monkeypatch.setattr(runner_module, 'evaluate_assertion', recording_evaluate)
        fake = FakeClient(chat_results=['first answer'])

        report = await runner_module.run_spec(
            fake, make_spec([make_case()]), case_filter=None, fail_fast=False, judge_factory=None
        )

        assert seen['output_text'] == 'first answer'
        assert seen['case_input'] == 'Say hello'
        assert seen['duration_ms'] == report.case_results[0].duration_ms
        assert report.case_results[0].output_text == 'first answer'

    async def test_empty_answers_yield_empty_output_text(self, monkeypatch):
        monkeypatch.setattr(runner_module, 'evaluate_assertion', passing_evaluate)
        fake = FakeClient(chat_results=[None])  # chat returns {'answers': []}

        report = await runner_module.run_spec(
            fake, make_spec([make_case()]), case_filter=None, fail_fast=False, judge_factory=None
        )

        assert report.case_results[0].output_text == ''

    async def test_case_error_isolation(self, monkeypatch):
        monkeypatch.setattr(runner_module, 'evaluate_assertion', passing_evaluate)
        fake = FakeClient(chat_results=[RuntimeError('pipeline exploded'), 'fine'])
        spec = make_spec([make_case('first'), make_case('second')])

        report = await runner_module.run_spec(fake, spec, case_filter=None, fail_fast=False, judge_factory=None)

        first, second = report.case_results
        assert first.passed is False
        assert first.error == 'pipeline exploded'
        assert first.assertion_results == []
        assert second.passed is True
        assert second.error is None
        # Teardown still happened after the errored case
        assert fake.terminated_tokens() == ['task-1']

    async def test_fail_fast_stops_after_first_failure(self, monkeypatch):
        monkeypatch.setattr(runner_module, 'evaluate_assertion', passing_evaluate)
        fake = FakeClient(chat_results=[RuntimeError('boom'), 'never used'])
        spec = make_spec([make_case('first'), make_case('second')])

        report = await runner_module.run_spec(fake, spec, case_filter=None, fail_fast=True, judge_factory=None)

        assert len(report.case_results) == 1
        assert fake.call_kinds() == ['use', 'chat', 'terminate']

    async def test_fail_fast_on_assertion_failure(self, monkeypatch):
        monkeypatch.setattr(runner_module, 'evaluate_assertion', failing_evaluate)
        fake = FakeClient(chat_results=['a', 'b'])
        spec = make_spec([make_case('first'), make_case('second')])

        report = await runner_module.run_spec(fake, spec, case_filter=None, fail_fast=True, judge_factory=None)

        assert len(report.case_results) == 1
        assert report.case_results[0].passed is False

    async def test_case_filter_selects_matching_cases(self, monkeypatch):
        monkeypatch.setattr(runner_module, 'evaluate_assertion', passing_evaluate)
        fake = FakeClient(chat_results=['x'])
        spec = make_spec([make_case('greeting-basic'), make_case('farewell')])

        report = await runner_module.run_spec(fake, spec, case_filter='greet', fail_fast=False, judge_factory=None)

        assert [case.name for case in report.case_results] == ['greeting-basic']
        assert fake.call_kinds() == ['use', 'chat', 'terminate']

    async def test_case_filter_matching_nothing_never_starts_pipeline(self, monkeypatch):
        monkeypatch.setattr(runner_module, 'evaluate_assertion', passing_evaluate)
        fake = FakeClient()
        spec = make_spec([make_case('greeting')])

        report = await runner_module.run_spec(
            fake, spec, case_filter='no-such-case', fail_fast=False, judge_factory=None
        )

        assert report.case_results == []
        assert fake.calls == []

    async def test_teardown_when_evaluation_raises(self, monkeypatch):
        def exploding_evaluate(assertion, *, output_text, duration_ms, case_input, judge):
            raise RuntimeError('evaluator bug')

        monkeypatch.setattr(runner_module, 'evaluate_assertion', exploding_evaluate)
        fake = FakeClient(chat_results=['x'])

        report = await runner_module.run_spec(
            fake, make_spec([make_case()]), case_filter=None, fail_fast=False, judge_factory=None
        )

        case = report.case_results[0]
        assert case.passed is False
        assert 'evaluator bug' in case.error
        assert fake.terminated_tokens() == ['task-1']

    async def test_teardown_when_judge_factory_raises(self, monkeypatch):
        """A raising judge_factory must not orphan the already-started pipeline."""
        monkeypatch.setattr(runner_module, 'evaluate_assertion', passing_evaluate)
        fake = FakeClient(chat_results=['x'])

        def exploding_factory(run_pipeline, default_path):
            raise RuntimeError('factory bug')

        with pytest.raises(RuntimeError, match='factory bug'):
            await runner_module.run_spec(
                fake, make_spec([make_case()]), case_filter=None, fail_fast=False, judge_factory=exploding_factory
            )

        assert fake.terminated_tokens() == ['task-1']

    async def test_teardown_failure_is_swallowed(self, monkeypatch):
        monkeypatch.setattr(runner_module, 'evaluate_assertion', passing_evaluate)
        fake = FakeClient(chat_results=['x'])

        async def failing_terminate(token):
            fake.calls.append(('terminate', token))
            raise RuntimeError('already gone')

        fake.terminate = failing_terminate

        report = await runner_module.run_spec(
            fake, make_spec([make_case()]), case_filter=None, fail_fast=False, judge_factory=None
        )

        assert report.case_results[0].passed is True
        assert fake.terminated_tokens() == ['task-1']

    async def test_use_failure_propagates_without_teardown(self, monkeypatch):
        monkeypatch.setattr(runner_module, 'evaluate_assertion', passing_evaluate)
        fake = FakeClient(use_error=RuntimeError('cannot start'))

        with pytest.raises(RuntimeError, match='cannot start'):
            await runner_module.run_spec(
                fake, make_spec([make_case()]), case_filter=None, fail_fast=False, judge_factory=None
            )

        assert fake.terminated_tokens() == []

    async def test_evaluate_receives_no_judge_without_factory(self, monkeypatch):
        seen = {}

        def recording_evaluate(assertion, *, output_text, duration_ms, case_input, judge):
            seen['judge'] = judge
            return AssertionResult(spec=assertion, passed=True, detail='')

        monkeypatch.setattr(runner_module, 'evaluate_assertion', recording_evaluate)
        fake = FakeClient(chat_results=['x'])

        await runner_module.run_spec(
            fake, make_spec([make_case()]), case_filter=None, fail_fast=False, judge_factory=None
        )

        assert seen['judge'] is None


class TestRunSpecJudgeWiring:
    async def test_judge_factory_receives_packaged_default(self, monkeypatch):
        monkeypatch.setattr(runner_module, 'evaluate_assertion', passing_evaluate)
        fake = FakeClient(chat_results=['x'])
        captured = {}

        def fake_factory(run_pipeline, default_judge_pipeline):
            captured['run_pipeline'] = run_pipeline
            captured['default'] = default_judge_pipeline
            return lambda **kwargs: None

        await runner_module.run_spec(
            fake, make_spec([make_case()]), case_filter=None, fail_fast=False, judge_factory=fake_factory
        )

        assert callable(captured['run_pipeline'])
        assert captured['default'].endswith(('templates/judge-default.pipe', 'templates\\judge-default.pipe'))

    async def test_judge_factory_receives_spec_level_override(self, monkeypatch):
        monkeypatch.setattr(runner_module, 'evaluate_assertion', passing_evaluate)
        fake = FakeClient(chat_results=['x'])
        captured = {}

        def fake_factory(run_pipeline, default_judge_pipeline):
            captured['default'] = default_judge_pipeline
            return lambda **kwargs: None

        spec = make_spec([make_case()], judge_pipeline='/abs/spec-judge.pipe')
        await runner_module.run_spec(fake, spec, case_filter=None, fail_fast=False, judge_factory=fake_factory)

        assert captured['default'] == '/abs/spec-judge.pipe'

    async def test_case_judge_override_is_bound_into_judge_calls(self, monkeypatch):
        judge_calls = []

        def spec_judge(**kwargs):
            judge_calls.append(kwargs)
            return None

        def judging_evaluate(assertion, *, output_text, duration_ms, case_input, judge):
            judge(criteria='helpful', case_input=case_input, output_text=output_text, judge_pipeline=None)
            return AssertionResult(spec=assertion, passed=True, detail='')

        monkeypatch.setattr(runner_module, 'evaluate_assertion', judging_evaluate)
        fake = FakeClient(chat_results=['x', 'y'])
        spec = make_spec(
            [
                make_case('default-judge'),
                make_case('custom-judge', judge_pipeline='/abs/case-judge.pipe'),
            ]
        )

        await runner_module.run_spec(
            fake, spec, case_filter=None, fail_fast=False, judge_factory=lambda run, default: spec_judge
        )

        # Case without an override leaves judge_pipeline as passed (None);
        # the per-case override replaces None with the case's judge path
        assert judge_calls[0]['judge_pipeline'] is None
        assert judge_calls[1]['judge_pipeline'] == '/abs/case-judge.pipe'

    async def test_run_pipeline_executes_judge_on_engine_and_tears_down(self, monkeypatch):
        captured = {}

        def fake_factory(run_pipeline, default_judge_pipeline):
            captured['run_pipeline'] = run_pipeline
            return lambda **kwargs: None

        def judging_evaluate(assertion, *, output_text, duration_ms, case_input, judge):
            # Runs on the worker thread: drive a judge pipeline synchronously
            verdict_text = captured['run_pipeline']('/abs/judge.pipe', 'score this output')
            return AssertionResult(spec=assertion, passed=verdict_text == 'judge says ok', detail=verdict_text)

        monkeypatch.setattr(runner_module, 'evaluate_assertion', judging_evaluate)
        # First chat serves the case, second chat serves the judge pipeline
        fake = FakeClient(chat_results=['main answer', 'judge says ok'])

        report = await runner_module.run_spec(
            fake, make_spec([make_case()]), case_filter=None, fail_fast=False, judge_factory=fake_factory
        )

        assert report.case_results[0].passed is True
        # The judge pipeline was started on the same engine...
        use_paths = [payload['filepath'] for kind, payload in fake.calls if kind == 'use']
        assert use_paths == ['/abs/chat.pipe', '/abs/judge.pipe']
        # ...received the judge prompt...
        judge_chats = [payload for kind, payload in fake.calls if kind == 'chat' and payload['token'] == 'task-2']
        assert judge_chats == [{'token': 'task-2', 'question': 'score this output'}]
        # ...and was terminated together with the pipeline under test
        assert sorted(fake.terminated_tokens()) == ['task-1', 'task-2']

    async def test_judge_pipeline_token_is_cached_across_calls(self, monkeypatch):
        captured = {}

        def fake_factory(run_pipeline, default_judge_pipeline):
            captured['run_pipeline'] = run_pipeline
            return lambda **kwargs: None

        def judging_evaluate(assertion, *, output_text, duration_ms, case_input, judge):
            captured['run_pipeline']('/abs/judge.pipe', 'first prompt')
            captured['run_pipeline']('/abs/judge.pipe', 'second prompt')
            return AssertionResult(spec=assertion, passed=True, detail='')

        monkeypatch.setattr(runner_module, 'evaluate_assertion', judging_evaluate)
        fake = FakeClient(chat_results=['main answer', 'verdict one', 'verdict two'])

        await runner_module.run_spec(
            fake, make_spec([make_case()]), case_filter=None, fail_fast=False, judge_factory=fake_factory
        )

        # The judge pipeline is only started once despite two judge calls
        use_paths = [payload['filepath'] for kind, payload in fake.calls if kind == 'use']
        assert use_paths == ['/abs/chat.pipe', '/abs/judge.pipe']
        assert sorted(fake.terminated_tokens()) == ['task-1', 'task-2']

    async def test_stalled_judge_times_out_and_pipelines_are_torn_down(self, monkeypatch):
        """A judge that never answers must not hang the run or skip teardown."""

        class StallingJudgeClient(FakeClient):
            """Answers the case chat, then hangs forever on the judge chat."""

            async def chat(self, *, token, question, on_sse=None):
                self.calls.append(('chat', {'token': token, 'question': question.questions[0].text}))
                if token == 'task-2':
                    await asyncio.Event().wait()  # never set: simulates a stalled judge
                return {'answers': ['main answer']}

        captured = {}

        def fake_factory(run_pipeline, default_judge_pipeline):
            captured['run_pipeline'] = run_pipeline
            return lambda **kwargs: None

        def judging_evaluate(assertion, *, output_text, duration_ms, case_input, judge):
            return AssertionResult(
                spec=assertion,
                passed=True,
                detail=captured['run_pipeline']('/abs/judge.pipe', 'score this output'),
            )

        monkeypatch.setattr(runner_module, 'evaluate_assertion', judging_evaluate)
        fake = StallingJudgeClient()

        report = await runner_module.run_spec(
            fake,
            make_spec([make_case()]),
            case_filter=None,
            fail_fast=False,
            judge_factory=fake_factory,
            judge_timeout=0.05,
        )

        # The stalled judge is recorded as a case error rather than hanging
        assert report.case_results[0].passed is False
        assert '/abs/judge.pipe' in report.case_results[0].error
        assert '0.05s' in report.case_results[0].error
        # ...and both pipelines were still terminated
        assert sorted(fake.terminated_tokens()) == ['task-1', 'task-2']

    async def test_default_judge_timeout_is_finite(self):
        """The default must be a bound, not None: an unbounded wait can hang the run."""
        assert isinstance(runner_module.DEFAULT_JUDGE_TIMEOUT_S, float)
        assert runner_module.DEFAULT_JUDGE_TIMEOUT_S > 0
