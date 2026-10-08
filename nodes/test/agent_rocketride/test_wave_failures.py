# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Tests for how the Wave loop notices work that did not happen.

A tool can fail without raising. tool_http_request returns a 403 as a normal
response, MCP tools set ``isError``, tool_python reports a non-zero ``exit_code``,
and many tools answer ``{"ok": false}``. The loop used to read all of these as
success, so a reply that set done=true beside a failed write ended the run with
an answer about work that never happened. ``executor._reports_failure`` now
recognizes these shapes, and the result's entry carries ``"failed": true`` into
the next prompt, the done check and the fallback answer. Each tool's fields
count only on that tool's result shape, so data such as log rows with an
``error`` column is not taken for a failure.

The planner also reports the calls it has to skip. ``plan`` returns them as
``problems``, and the driver lists them with the wave's results.

Each test calls one function directly with a small fake. The ``wave`` fixture
in conftest.py loads the node's modules from source.
"""

from types import SimpleNamespace

import pytest


def _http(status):
    """What tool_http_request returns for a response, whatever its status."""
    return {'status_code': status, 'status_text': 'reason', 'headers': {}, 'body': '', 'json': None}


def _child_agent(kind):
    """What an agent called as a tool returns (AgentBase.run_agent). Its stack says how the run ended."""
    return {'content': 'RuntimeError: boom', 'meta': {'agent_id': 'helper'}, 'stack': [{'kind': kind, 'payload': {}}]}


FAILURES = {
    'ok-false': {'ok': False, 'error': 'conflict'},
    'success-false': {'success': False},
    'error-text': {'error': 'Permission denied'},
    'error-object': {'error': {'code': 403}},
    'error-true': {'error': True},
    'mcp-isError': {'isError': True, 'content': [{'type': 'text', 'text': 'Permission denied'}]},
    'http-403': _http(403),
    # A 404 counts even when the model expected it. That costs one round, not a false report.
    'http-404': _http(404),
    'child-agent-crashed': _child_agent('RocketRide.agent.error.v1'),
    'child-agent-guard': _child_agent('RocketRide.agent.guard.v1'),
    'exit-code': {'exit_code': 1, 'stdout': '', 'stderr': 'PermissionError: src/App.tsx'},
    # tool_python keeps SystemExit(True) as exit_code=True.
    'python-exit-true': {'exit_code': True, 'stdout': '', 'stderr': '', 'timed_out': False},
    'daytona-timed-out': {'timed_out': True, 'output': ''},
    'script-result': {'exit_code': 0, 'stdout': '', 'result': {'ok': False, 'error': 'denied'}},
    'script-error-list': {'exit_code': 0, 'stdout': '', 'result': [{'error': 'permission denied'}]},
    'vertex-error-list': [{'error': 'Failed to search: quota exceeded'}],
    'batch-with-a-failed-item': [{'ok': True, 'path': 'src/a.ts'}, {'ok': False, 'error': 'denied'}],
}

NOT_FAILURES = {
    'success': {'ok': True, 'revision': 2},
    'log-rows-with-an-error-column': [{'ts': 't1', 'error': 'NullPointerException'}, {'ts': 't2', 'error': 'Timeout'}],
    'ci-job-with-an-exit-code': {'job': 'build', 'status': 'completed', 'exit_code': 1},
    'a-status-code-on-data': {'service': 'api', 'status_code': 500, 'count': 3},
    'a-result-field-on-data': {'rows': [], 'result': {'ok': False}},
    'a-measurement-named-error': {'fit': 'linear', 'error': 0.25},
    'empty-error': [{'error': ''}],
    'null-error': {'ok': True, 'error': None},
    'http-201': _http(201),
    'a-child-agent-that-answered': _child_agent('RocketRide.agent.raw.v1'),
    'a-clean-run': {'exit_code': 0, 'timed_out': False, 'stdout': 'ok', 'result': {'fit': 'linear', 'error': 0.25}},
}


@pytest.mark.parametrize('result', FAILURES.values(), ids=FAILURES.keys())
def test_a_result_that_reports_a_failure_counts_as_failed(wave, result):
    assert wave.executor._reports_failure(result) is True


@pytest.mark.parametrize('result', NOT_FAILURES.values(), ids=NOT_FAILURES.keys())
def test_data_that_looks_like_a_failure_is_not_one(wave, result):
    assert wave.executor._reports_failure(result) is False


def test_a_script_result_that_holds_itself_is_followed_once(wave):
    """tool_python keeps a script's result as is, so result['result'] = result can be a successful run."""
    result = {'stdout': '', 'exit_code': 0}
    result['result'] = result

    assert wave.executor._reports_failure(result) is False


def test_a_failed_result_is_marked_in_its_entry(wave):
    """The entry goes into the next prompt. The driver reads "failed" there before it lets done stand."""
    context = SimpleNamespace(memory=SimpleNamespace(put=lambda key, value: {'ok': True}))
    agent = SimpleNamespace(seen_results={})
    store = wave.executor._store_and_preview

    failed = store('workspace.write', 'wave-0.r0', {'ok': False, 'error': 'conflict'}, context, agent.seen_results)
    worked = store('workspace.write', 'wave-0.r1', {'ok': True, 'revision': 2}, context, agent.seen_results)

    assert failed['failed'] is True
    assert 'failed' not in worked


def test_the_fallback_answer_is_told_which_results_failed(wave):
    """The fallback reads summaries, and a summary's sample may not show the row that failed."""
    entries = [
        {'tool': 'workspace.write', 'key': 'wave-0.r0', 'summary': '301 items', 'failed': True},
        {'tool': 'workspace.read', 'key': 'wave-0.r1', 'summary': 'path: "src/App.tsx"'},
    ]
    driver = SimpleNamespace(call_llm=lambda context, q: '\n'.join(q.context))

    gathered = wave.rocketride_agent.RocketRideDriver._synthesize(
        driver, question=wave.planner.Question(), waves=[{'results': entries}], context=None
    )

    assert '- workspace.write: FAILED (the result reports a failure)' in gathered
    assert '- workspace.read: path: "src/App.tsx"' in gathered


class _SameReply:
    """A model that sends the same reply to every planning prompt."""

    def __init__(self, reply):
        self.reply, self.prompts = reply, []

    def call_llm_json(self, context, prompt):
        self.prompts.append(prompt)
        return self.reply


def _plan(wave, model):
    context = SimpleNamespace(tools=SimpleNamespace(list=[]))
    question = wave.planner.Question()
    return wave.planner.plan(agent_base=model, context=context, question=question, waves=[], current_scratch='')


def test_a_skipped_call_is_reported_beside_the_calls_that_run(wave):
    """The driver lists these problems with the wave's results, so the model sees what did not run."""
    good = {'tool': 'workspace.list', 'args': {}}
    model = _SameReply({'thought': 't', 'tool_calls': ['workspace.write src/App.tsx', good]})

    result = _plan(wave, model)

    assert result['tool_calls'] == [good]
    assert result['problems'] == ['tool_calls[0] was not an object']
    assert len(model.prompts) == 1


def test_a_done_reply_whose_only_call_was_skipped_returns_only_its_problems(wave):
    """It claims work that did not happen. After one more try the driver gets the problems and no answer."""
    model = _SameReply({'done': True, 'answer': 'Renamed the button.', 'tool_calls': ['workspace.write src/App.tsx']})

    result = _plan(wave, model)

    assert result == {'problems': ['tool_calls[0] was not an object']}
    assert len(model.prompts) == 2
    asked_again = [i.instructions for i in model.prompts[-1].instructions]
    assert any('not usable: tool_calls[0] was not an object' in text for text in asked_again)
