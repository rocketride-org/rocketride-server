# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Unit tests for the calls shown to the model and the check tool rule (W12, W13).

W12. The planning prompt showed each result but not the call behind it, so the
model could not tell a retry from a repeat. Each result now shows the call's
arguments, and a repeated call gets a note that names the first one.

W13. The node setting verify_tool names a tool that checks the work. The driver
refuses done=true until that check has passed in a later step than the last
change. The setting verify_args fixes the check's exact arguments.

The ``wave`` fixture in conftest.py loads the node's modules from source. The
tools, the memory and the planner reply are small fakes. No model is involved.
"""

from types import SimpleNamespace

import pytest

CHECK = 'workspace.compile'
CHECK_ARGS = '{"target": "app"}'


class _Host:
    """The driver side of call_tool. Every tool returns the same result, and "broken" raises."""

    def __init__(self):
        self.seen_results = {}

    def call_tool(self, context, tool, args):
        if tool == 'broken':
            raise RuntimeError('tool is down')
        return {'ok': True, 'diagnostics': []}


def _call(tool, **args):
    return {'tool': tool, 'args': args}


def _run_steps(wave, steps, **checks):
    """Run each step through execute_wave with one run's call history, and return all the results in order."""
    host, seen_calls = _Host(), {}
    context = SimpleNamespace(memory=SimpleNamespace(put=lambda key, value: {'ok': True}))
    run = wave.executor.execute_wave
    return [
        r
        for i, calls in enumerate(steps)
        for r in run(calls, agent_base=host, context=context, wave_name=f'wave-{i}', seen_calls=seen_calls, **checks)
    ]


def _preview(wave, args):
    """The argument preview the planner sees for one call with *args*."""
    return wave.executor._with_call({'tool': 't', 'key': 'wave-0.r0'}, 't', args, None)['args']


def _context(wave, *tools, memory=None):
    """A run context with these tools connected, and no memory unless one is given."""
    return wave.rocketride_agent.AgentContext(
        invoker=None,
        llm=None,
        tools=SimpleNamespace(list=[{'name': t} for t in tools]),
        memory=memory,
        run_id='run-1',
        pipe_id=0,
        framework='wave',
        started_at='',
    )


def _driver(wave, **config):
    """Build the driver from node config, through the real Config merge."""
    glb = SimpleNamespace(logicalType='agent_rocketride', connConfig=config)
    return wave.rocketride_agent.RocketRideDriver(SimpleNamespace(glb=glb))


def test_each_result_shows_the_arguments_the_model_sent(wave):
    """After a write the model sees what it wrote, not only "ok". A call without arguments shows none."""
    write = _call('workspace.write', path='src/App.css', content='header { background: #2563eb; }', baseRevision=1)

    written, listed = _run_steps(wave, [[write, _call('workspace.list')]])

    assert list(written)[:3] == ['tool', 'key', 'args']
    assert '"src/App.css"' in written['args']
    assert '#2563eb' in written['args']
    assert 'baseRevision: 1' in written['args']
    assert 'args' not in listed


def test_a_repeated_failing_call_names_the_first(wave):
    """A failed call stores no result, so only the call note can say it was tried before."""
    first, second = _run_steps(wave, [[_call('broken', path='a')], [_call('broken', path='a')]])

    assert 'error' in second
    assert 'note' not in first
    assert second['note'] == 'Same tool and arguments as wave-0.r0.'


def test_an_identical_result_keeps_the_more_specific_note(wave):
    """The same read twice. The note says the data is identical, not only the call."""
    read = _call('workspace.read', path='src/App.css')

    _, second = _run_steps(wave, [[read], [read]])

    assert 'identical to wave-0.r0' in second['note']
    assert 'Same tool and arguments' not in second['note']


def test_re_running_a_removed_call_says_it_was_removed(wave):
    """Read, remove, read again was a loop seen in live runs. The note names the removal."""
    entry, seen_calls = {'tool': 'workspace.read', 'key': 'wave-0.r0', 'summary': 'ok: true'}, {}
    wave.executor._with_call(entry, 'workspace.read', {'path': 'spec.md'}, seen_calls)

    again = wave.executor._with_call(
        {**entry, 'key': 'wave-2.r0'}, 'workspace.read', {'path': 'spec.md'}, seen_calls, removed={'wave-0.r0'}
    )

    assert 'Same tool and arguments as wave-0.r0, whose result you removed.' in again['note']


def test_a_check_run_again_is_not_called_a_repeat(wave):
    """The rule asks for a new check after every change, so neither repeat note applies to it."""
    steps = [[_call(CHECK)], [_call(CHECK)]]

    _, plain = _run_steps(wave, steps)
    _, check = _run_steps(wave, steps, check_tool=CHECK)

    assert 'note' in plain, 'without a check tool this is an ordinary repeat'
    assert 'note' not in check


def test_with_verify_args_only_the_exact_check_is_exempt(wave):
    """Other calls to the check tool, such as a command runner editing a file, get repeat notes as usual."""
    other, check = _call(CHECK, command='ls'), _call(CHECK, target='app')

    results = _run_steps(wave, [[other], [other], [check], [check]], check_tool=CHECK, check_args={'target': 'app'})

    first_other, second_other, first_check, second_check = results
    assert 'note' not in first_other
    assert 'note' in second_other
    assert 'note' not in first_check and 'note' not in second_check


def test_long_arguments_share_one_budget_and_keep_their_ends(wave):
    """Three long texts split the budget, and each keeps its start and its end."""
    preview = _preview(wave, {name: name * 1000 + f'END_{name}' for name in 'abc'})

    assert all(f'END_{name}' in preview for name in 'abc')
    assert len(preview) < wave.executor._ARGS_HARD_CAP


def test_many_long_arguments_still_show_their_text(wave):
    """The length-only rule is for stored results, which the model can peek.

    Arguments are not stored, so a call with many long texts still shows the start of each.
    """
    preview = _preview(wave, {f'file{i}': f'START_{i} ' + 'x' * 1000 for i in range(9)})

    assert 'peek the key' not in preview
    assert 'START_0' in preview


def test_an_argument_preview_is_cut_at_its_cap(wave):
    """Each text keeps at least 80 characters, so a call with dozens of them is cut at 1,200."""
    preview = _preview(wave, {f'field{i}': 'x' * 5000 for i in range(30)})

    assert 'cut at 1,200' in preview
    assert 'x' * 1300 not in preview


def test_is_check_without_verify_args_matches_the_tool_name(wave):
    calls = [_call(CHECK, target='any'), _call('workspace.write', path='a')]
    driver = _driver(wave, verify_tool=CHECK)

    assert driver._is_check({'tool': CHECK}, calls, 0)
    assert not driver._is_check({'tool': 'workspace.write'}, calls, 1)
    assert not _driver(wave)._is_check({'tool': CHECK}, calls, 0), 'no check tool is set'


def test_is_check_with_verify_args_needs_the_exact_arguments(wave):
    calls = [_call(CHECK, target='app'), _call(CHECK, command="printf '(' > app.py"), _call(CHECK)]
    driver = _driver(wave, verify_tool=CHECK, verify_args=CHECK_ARGS)

    assert driver._is_check({'tool': CHECK}, calls, 0)
    assert not driver._is_check({'tool': CHECK}, calls, 1)
    assert not driver._is_check({'tool': CHECK}, calls, 2)


def test_not_checked_wants_a_pass_in_a_later_step_than_the_last_change(wave):
    """A check in the same step as the change ran beside it, so it may have missed the change."""
    driver = _driver(wave, verify_tool=CHECK)

    assert driver._not_checked(last_check=-1, last_change=-1) == '', 'a run that changed nothing may finish'
    assert driver._not_checked(last_check=2, last_change=1) == ''
    assert 'call workspace.compile on its own' in driver._not_checked(last_check=1, last_change=1)
    assert driver._not_checked(last_check=-1, last_change=1), 'a failed check counts as no check'
    assert _driver(wave)._not_checked(last_check=-1, last_change=3) == '', 'no check tool, no rule'


@pytest.mark.parametrize(
    'args, refusal',
    [
        ({'target': 'app'}, 'Not finished: read the result of workspace.compile before done=true.'),
        ({'command': 'ls'}, 'Not finished: call workspace.compile with exactly {"target": "app"} on its own'),
    ],
    ids=['the-check', 'other-arguments'],
)
def test_done_beside_a_call_to_the_check_tool_gives_the_right_refusal(wave, monkeypatch, args, refusal):
    """done=true sent with the check asks the model to read the check's result first.

    Sent with another call to the check tool, which counts as a change, it asks for
    the exact check. Asking to read that result would cost a round. The model would
    send done again and only then hear that the change was never checked.
    """
    reply = {'done': True, 'answer': 'Finished.', 'tool_calls': [_call(CHECK, **args)], 'remove': []}
    stored = [{'tool': CHECK, 'key': 'wave-0.r0', 'summary': 'ok: true'}]
    monkeypatch.setattr(wave.rocketride_agent, 'plan_wave', lambda **kw: reply)
    monkeypatch.setattr(wave.rocketride_agent, 'execute_wave', lambda calls, **kw: list(stored))
    driver = _driver(wave, verify_tool=CHECK, verify_args=CHECK_ARGS)
    driver._max_waves = 1
    driver.sendSSE = lambda *a, **kw: None
    driver._synthesize = lambda **kw: 'synthesized'

    answer, trace = driver._run(context=_context(wave, CHECK), question=None)

    assert answer == 'synthesized', 'the run must not finish on this reply'
    last = trace['waves'][0]['results'][-1]
    assert last['key'] == 'wave-0.done'
    assert last['error'].startswith(refusal)


@pytest.mark.parametrize('value', ['npm test', '[1, 2]', '{"target": '], ids=['text', 'list', 'broken-json'])
def test_verify_args_that_is_not_a_json_object_stops_the_node(wave, value):
    """Ignoring a bad value would quietly let any call to the check tool count as a check."""
    with pytest.raises(ValueError, match='verify_args'):
        _driver(wave, verify_tool=CHECK, verify_args=value)


def _prompt(wave, **settings):
    """The planning prompt for a run with no results yet, under the given check settings."""
    context = SimpleNamespace(tools=SimpleNamespace(list=[]))
    question = wave.planner.Question()
    return wave.planner._build_wave_question(context=context, question=question, waves=[], **settings).getPrompt()


def test_the_check_rule_names_the_exact_call_when_verify_args_is_set(wave):
    prompt = _prompt(wave, verify_tool=CHECK, verify_args={'target': 'app'})

    assert 'call workspace.compile on its own, in a later step than the change' in prompt
    assert 'workspace.compile called with exactly these arguments: {"target": "app"}' in prompt
    assert 'Trust that, if a tool succeeds' not in prompt


def test_without_a_check_tool_the_trust_rule_stays_and_the_last_line_offers_done(wave):
    prompt = _prompt(wave)

    assert 'Trust that, if a tool succeeds, it worked and gave you the correct answer.' in prompt
    assert 'call workspace.compile' not in prompt
    assert 'Plan the next set of tool calls, or set done=true if the goal is already met.' in prompt


def test_a_done_reply_that_is_sent_back_keeps_its_fingerprints(wave, monkeypatch):
    """A done reply sent back keeps its keys, so a later identical result must still be named.

    Its removed keys stay in memory, so their fingerprints must stay too.
    """
    read = {'done': False, 'asked_done': False, 'tool_calls': [_call('workspace.read', path='a')], 'remove': []}
    done = {
        'done': True,
        'asked_done': True,
        'answer': 'Finished.',
        'tool_calls': [_call('broken')],
        'remove': ['wave-0.r0'],
    }
    replies = iter([read, done])

    def run(calls, agent_base, wave_name, **kw):
        if wave_name == 'wave-0':
            agent_base.seen_results['read-a'] = 'wave-0.r0'
            return [{'tool': 'workspace.read', 'key': 'wave-0.r0', 'summary': 'ok: true'}]
        return [{'tool': 'broken', 'key': f'{wave_name}.r0', 'error': 'tool is down'}]

    monkeypatch.setattr(wave.rocketride_agent, 'plan_wave', lambda **kw: next(replies))
    monkeypatch.setattr(wave.rocketride_agent, 'execute_wave', run)
    driver = _driver(wave)
    driver._max_waves = 2
    driver.sendSSE = lambda *a, **kw: None
    driver._synthesize = lambda **kw: 'synthesized'

    answer, _ = driver._run(context=SimpleNamespace(run_id='run-1'), question=None)

    assert answer == 'synthesized', 'a failed call sends the done reply back'
    assert driver.seen_results == {'read-a': 'wave-0.r0'}


def test_a_check_tool_that_is_not_connected_stops_the_run(wave, monkeypatch):
    """A misspelled verify_tool could never pass, so every run would use up its waves without saying why."""
    monkeypatch.setattr(
        wave.rocketride_agent, 'plan_wave', lambda **kw: pytest.fail('the run must stop before planning')
    )
    driver = _driver(wave, verify_tool='workspace.compil')
    driver.sendSSE = lambda *a, **kw: None

    with pytest.raises(ValueError, match="verify_tool 'workspace.compil' is not a connected tool"):
        driver._run(context=_context(wave, CHECK, 'workspace.write'), question=None)


def test_the_check_rule_sends_done_back_until_a_later_check_passes(wave, monkeypatch):
    """The whole enforced path: a change, done refused, a passing check, then done accepted."""
    replies = iter(
        [
            {'done': True, 'asked_done': True, 'answer': 'Done.', 'tool_calls': [_call('workspace.write', path='a')]},
            {'done': False, 'asked_done': False, 'tool_calls': [_call(CHECK)]},
            {'done': True, 'asked_done': True, 'answer': 'Done, and it compiles.', 'tool_calls': []},
        ]
    )

    def run(calls, wave_name, **kw):
        return [{'tool': c['tool'], 'key': f'{wave_name}.r{i}', 'summary': 'ok: true'} for i, c in enumerate(calls)]

    monkeypatch.setattr(wave.rocketride_agent, 'plan_wave', lambda **kw: dict(next(replies), remove=[]))
    monkeypatch.setattr(wave.rocketride_agent, 'execute_wave', run)
    driver = _driver(wave, verify_tool=CHECK)
    driver._max_waves = 5
    driver.sendSSE = lambda *a, **kw: None

    answer, trace = driver._run(context=_context(wave, CHECK, 'workspace.write'), question=None)

    first = trace['waves'][0]['results'][-1]
    assert first['key'] == 'wave-0.done'
    assert first['error'].startswith('Not finished: call workspace.compile on its own, after your last change')
    assert answer == 'Done, and it compiles.'
    assert trace['stop_reason'] == 'done'
    assert len(trace['waves']) == 2, 'the accepted done reply runs no calls'


def test_a_checking_agent_whose_run_failed_is_not_a_pass(wave, monkeypatch):
    """An agent used as the check answers normally when its own model call fails.

    Only meta.stop_reason says the run ended in an error, so that answer must not count
    as a passing check: the change after it was never checked.
    """
    checker = 'checker.run_agent'
    failed_run = {
        'content': 'LLM error: rate limit',
        'meta': {'agent_id': 'checker', 'stop_reason': 'error'},
        'stack': [{'kind': 'RocketRide.agent.raw.v1', 'payload': {}}],
    }
    replies = iter(
        [
            {'done': False, 'asked_done': False, 'tool_calls': [_call('workspace.write', path='a')]},
            {'done': False, 'asked_done': False, 'tool_calls': [_call(checker)]},
            {'done': True, 'asked_done': True, 'answer': 'Done.', 'tool_calls': []},
        ]
    )
    monkeypatch.setattr(wave.rocketride_agent, 'plan_wave', lambda **kw: dict(next(replies), remove=[]))
    driver = _driver(wave, verify_tool=checker)
    driver.call_tool = lambda context, tool, args: failed_run if tool == checker else {'ok': True}
    driver._max_waves = 3
    driver.sendSSE = lambda *a, **kw: None
    driver._synthesize = lambda **kw: 'synthesized'
    context = _context(wave, checker, 'workspace.write', memory=SimpleNamespace(put=lambda key, value: {'ok': True}))

    answer, trace = driver._run(context=context, question=None)

    assert trace['waves'][1]['results'][0]['failed'] is True
    assert trace['waves'][2]['results'][-1]['error'].startswith('Not finished: call checker.run_agent on its own')
    assert answer == 'synthesized', 'the run must not finish on an unchecked change'


class _Engine:
    """The engine side of the host's tool catalog: one tool node, whose tool list can grow."""

    def __init__(self, tools):
        self.tools = list(tools)
        self.instance = self

    def getControllerNodeIds(self, kind):
        return ['workspace'] if kind == 'tool' else []

    def invoke(self, param, component_id=None):
        param.tools.extend({'name': name, 'description': '', 'inputSchema': {}} for name in self.tools)
        raise RuntimeError('no tool node answers a query with success')


def test_a_check_tool_added_after_discovery_is_found(wave, monkeypatch):
    """The host reads each tool node once. A node that has since grown the check tool is asked again.

    Uses the host's real catalog, so the guard goes through the same lookup a call would.
    """
    from ai.common.agent._internal.host import AgentHostServices

    engine = _Engine(['write'])
    tools = AgentHostServices.Tools(engine)
    engine.tools.append('compile')  # added to the server after the catalog was read
    monkeypatch.setattr(wave.rocketride_agent, 'plan_wave', lambda **kw: _reply_done())
    driver = _driver(wave, verify_tool=CHECK)
    driver.sendSSE = lambda *a, **kw: None
    context = wave.rocketride_agent.AgentContext(
        invoker=None, llm=None, tools=tools, memory=None, run_id='run-1', pipe_id=0, framework='wave', started_at=''
    )

    answer, trace = driver._run(context=context, question=None)

    assert CHECK in [t['name'] for t in tools.list], 'the lookup refreshed the catalog the planner reads'
    assert answer == 'Nothing to change.'
    assert trace['stop_reason'] == 'done'


def _reply_done():
    return {'done': True, 'asked_done': True, 'answer': 'Nothing to change.', 'tool_calls': [], 'remove': []}
