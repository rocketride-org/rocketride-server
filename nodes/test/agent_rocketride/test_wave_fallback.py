# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""The fallback answer and the stop reason, one driver method at a time.

When a run stops before the model finishes, a last model call writes the answer from
what was gathered. That call used to see only result summaries, so it lost the scratch
notes and showed memory.peek results as empty. When it failed too, everything gathered
was dropped. A forced answer also looked the same as a finished one. Each test calls
one method directly, with the model call and the status events recorded on the driver.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest


class FakeMemory:
    """The memory channel's get and clear calls over a dict."""

    def __init__(self, data=None):
        self.data = dict(data or {})
        self.cleared = []

    def get(self, key):
        if key in self.data:
            return {'ok': True, 'value': self.data[key]}
        return {'ok': False, 'error': f'key {key!r} not found'}

    def clear(self, key):
        self.cleared.append(key)
        self.data.pop(key, None)


@pytest.fixture
def driver(wave):
    """A driver without its engine setup. Its model call replies with ``driver.reply``, or raises it."""
    d = object.__new__(wave.rocketride_agent.RocketRideDriver)
    d.reply, d.prompts, d.events = 'fallback answer', [], []

    def call_llm(context, prompt):
        d.prompts.append(prompt.getPrompt())
        if isinstance(d.reply, Exception):
            raise d.reply
        return d.reply

    d.call_llm = call_llm
    d.sendSSE = lambda context, kind, **data: d.events.append({'type': kind, **data})
    return d


def synthesize(wave, driver, results, **kwargs):
    question = wave.rocketride_agent.Question()
    question.addQuestion('How many CSS rules does src/App.css have?')
    waves = [{'wave_num': 0, 'calls': [], 'results': results}]
    return driver._synthesize(question=question, waves=waves, context=SimpleNamespace(), **kwargs)


READ = {'tool': 'workspace.read', 'key': 'wave-0.r0', 'summary': 'dict(2 keys): path, content'}


def test_fallback_prompt_includes_the_scratch_notes(wave, driver):
    answer = synthesize(wave, driver, [READ], scratch='src/App.css has 4 CSS rules.')

    assert answer == 'fallback answer'
    assert 'src/App.css has 4 CSS rules.' in driver.prompts[0]


def test_fallback_prompt_includes_peeked_values(wave, driver):
    """A memory.peek result carries its data in "preview", not "summary"."""
    peek = {'tool': 'memory.peek', 'key': 'wave-1.r0', 'path': 'path', 'preview': 'src/App.css'}

    synthesize(wave, driver, [READ, peek])

    assert '- memory.peek: path = src/App.css' in driver.prompts[0]


def test_fallback_knows_when_a_peek_was_partial(wave, driver):
    """A capped peek says it saw 50 of 60 items, so the fallback cannot report 50 as the total."""
    files = {'files': [{'path': f'src/file{i:02d}.txt'} for i in range(60)]}
    context = SimpleNamespace(memory=FakeMemory({'wave-0.r0': files, 'wave-0.r1': 'x' * 300}))
    peeks = [
        {'tool': 'memory.peek', 'args': {'key': 'wave-0.r0', 'path': 'files[*].path'}},
        {'tool': 'memory.peek', 'args': {'key': 'wave-0.r1', 'offset': 0, 'length': 100}},
    ]
    results = wave.executor.execute_wave(peeks, agent_base=driver, context=context, wave_name='wave-1')

    synthesize(wave, driver, results)

    assert 'files[*].path = ["src/file00.txt"' in driver.prompts[0]
    assert 'showing 50 of 60 items' in driver.prompts[0]
    assert 'characters 0 to 100 of 300' in driver.prompts[0]


def test_unreachable_model_still_leaves_a_report(wave, driver):
    """When the fallback call fails too, the answer names the cause and keeps the notes and each result whole."""
    long_result = dict(READ, summary='Colours follow the brand guide. ' * 20 + 'primary: #2563eb')
    driver.reply = RuntimeError('Rate limit exceeded.')

    answer = synthesize(wave, driver, [long_result], scratch='Looking for the primary colour.')

    assert 'Rate limit exceeded.' in answer
    assert 'Looking for the primary colour.' in answer
    assert 'primary: #2563eb' in answer


def test_empty_fallback_reply_still_leaves_a_report(wave, driver):
    """The call returned, so the report says the reply was empty, not that the call failed."""
    driver.reply = '  '

    answer = synthesize(wave, driver, [READ])

    assert answer.startswith('I could not finish: the model returned no text.')
    assert 'call failed' not in answer
    assert '- workspace.read: dict(2 keys): path, content' in answer


@pytest.mark.parametrize('count', [None, '300'], ids=['null', 'text'])
def test_a_peek_with_an_odd_character_count_still_gets_an_answer(wave, driver, count):
    """The peek line is built outside the fallback's try block, so a bad count must not raise there."""
    peek = {'tool': 'memory.peek', 'key': 'wave-1.r0', 'preview': 'abc', 'total_chars': count}

    answer = synthesize(wave, driver, [READ, peek])

    assert answer == 'fallback answer'
    assert '- memory.peek: abc' in driver.prompts[0]
    assert '(characters' not in driver.prompts[0], 'a range needs a count to end at'


class _Replies:
    """A model that sends the next reply in a list to each planning prompt."""

    def __init__(self, *replies):
        self.replies = list(replies)

    def call_llm_json(self, context, prompt):
        reply = self.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return reply


UNUSABLE = {'thought': 'counting', 'scratch': 'src/App.css has 4 CSS rules.', 'tool_calls': 'none'}


@pytest.mark.parametrize(
    'retry, kept',
    [
        ({'thought': 'still nothing'}, 'src/App.css has 4 CSS rules.'),
        ({'thought': 'still nothing', 'scratch': 'Rules: 4.'}, 'Rules: 4.'),
        (
            {'thought': 'listing', 'tool_calls': [{'tool': 'workspace.list', 'args': {}}]},
            'src/App.css has 4 CSS rules.',
        ),
    ],
    ids=['unusable-retry', 'unusable-retry-with-new-notes', 'usable-retry-without-notes'],
)
def test_notes_from_an_unusable_reply_are_kept(wave, retry, kept):
    """The retry is asked only to fix its shape. If it writes no notes, the first reply's notes stand.

    When both tries are unusable the run falls back, and the notes must reach that answer.
    """
    context = SimpleNamespace(tools=SimpleNamespace(list=[]))
    model = _Replies(UNUSABLE, retry)

    result = wave.planner.plan(
        agent_base=model, context=context, question=wave.planner.Question(), waves=[], current_scratch=''
    )

    assert result['scratch'] == kept
    assert model.replies == [], 'the planner asks exactly once more'


def test_a_blank_key_never_reaches_memory(wave):
    """The memory node reads a clear with no key as "clear everything"."""
    memory = FakeMemory()

    wave.rocketride_agent.RocketRideDriver._clear_keys(['', '  ', None, 'wave-0.r0'], SimpleNamespace(memory=memory))

    assert memory.cleared == ['wave-0.r0']


def test_a_finished_answer_reports_done(driver):
    """The last status event carries the stop reason, so a caller can tell a finished answer from a forced one."""
    answer = driver._final_answer({'done': True, 'answer': 'Four rules.'}, SimpleNamespace(memory=FakeMemory()))

    assert answer == 'Four rules.'
    assert driver.events[-1]['stop_reason'] == 'done'


def test_a_failed_retry_keeps_the_first_replys_notes(wave):
    """The retry raised, so plan returns nothing; the notes travel with the error instead."""
    context = SimpleNamespace(tools=SimpleNamespace(list=[]))
    model = _Replies(UNUSABLE, RuntimeError('Rate limit exceeded.'))

    with pytest.raises(RuntimeError) as failed:
        wave.planner.plan(
            agent_base=model, context=context, question=wave.planner.Question(), waves=[], current_scratch=''
        )

    assert failed.value.wave_scratch == 'src/App.css has 4 CSS rules.'


def test_a_planning_error_with_notes_still_gets_an_answer(wave, driver, monkeypatch):
    """With no results yet, those notes are all the run has, so the driver answers from them."""
    failure = RuntimeError('Rate limit exceeded.')
    failure.wave_scratch = 'src/App.css has 4 CSS rules.'

    def plan_wave(**kw):
        raise failure

    monkeypatch.setattr(wave.rocketride_agent, 'plan_wave', plan_wave)
    driver._max_waves = 3
    driver._synthesize = lambda **kw: f'answered from: {kw["scratch"]}'

    answer, trace = driver._run(context=SimpleNamespace(run_id='run-1'), question=None)

    assert answer == 'answered from: src/App.css has 4 CSS rules.'
    assert trace['stop_reason'] == 'error'
    assert trace['error'] == 'RuntimeError: Rate limit exceeded.'


def test_a_reply_cannot_remove_the_result_its_own_call_gets(wave, driver, monkeypatch):
    """The reply's remove names the key its own call is about to get. Only earlier results can go.

    Otherwise the run clears the result it just fetched, and the fallback answer loses it.
    """
    reply = {'done': False, 'tool_calls': [{'tool': 'workspace.read', 'args': {}}], 'remove': ['wave-0.r0']}
    monkeypatch.setattr(wave.rocketride_agent, 'plan_wave', lambda **kw: reply)
    monkeypatch.setattr(wave.rocketride_agent, 'execute_wave', lambda calls, **kw: [dict(READ)])
    memory, seen = FakeMemory({'wave-0.r0': {'path': 'src/App.css'}}), {}
    driver._max_waves = 1
    driver._synthesize = lambda **kw: seen.update(kw) or 'synthesized'

    driver._run(context=SimpleNamespace(run_id='run-1', memory=memory), question=None)

    assert memory.cleared == []
    assert seen['waves'][0]['results'] == [READ]
