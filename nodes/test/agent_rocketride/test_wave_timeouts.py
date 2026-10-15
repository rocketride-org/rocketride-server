# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""The tool time limit, tested on one wave of parallel calls.

Each call gets the limit from when it starts. Python cannot stop a running thread, so
a call the wave gave up on finishes in the background, and its result is dropped.
Stuck tools here wait on an event the test sets, and slow ones move a fake clock, so
no test sleeps.
"""

from __future__ import annotations

import threading
from concurrent.futures import Future
from types import SimpleNamespace

import pytest

WAIT = 10  # seconds; a bound for waits that should end at once
LIMIT = 0.3  # seconds; the real time limit in tests where a call is stuck


class Memory:
    """The memory channel's three calls over a dict. *after_put* runs once a value lands."""

    def __init__(self, after_put=None):
        self.data, self.cleared = {}, []
        self.after_put = after_put

    def put(self, key, value):
        self.data[key] = value
        if self.after_put:
            self.after_put(key)
        return {'ok': True}

    def get(self, key):
        if key in self.data:
            return {'ok': True, 'value': self.data[key]}
        return {'ok': False, 'error': f'key {key!r} not found'}

    def clear(self, key):
        self.cleared.append(key)
        self.data.pop(key, None)
        return {'ok': True}


def fake_clock(wave, monkeypatch):
    """Give the executor a clock the test moves by hand, so no result depends on thread speed."""
    clock = SimpleNamespace(now=0.0)
    monkeypatch.setattr(wave.executor, 'time', SimpleNamespace(monotonic=lambda: clock.now))
    return clock


def call(tool, **args):
    return {'tool': tool, 'args': args}


def run_wave(wave, calls, call_tool, *, memory, release=None, while_held=None, **kwargs):
    """Run one wave and return its results once every thread it started has ended.

    The wave must end within WAIT seconds while its stuck calls are still held. Before
    the limit existed, it waited for them forever. Then *while_held* runs, *release*
    lets the stuck calls return, and this waits for them, so whatever a late call does
    to memory has happened before the test looks.
    """
    before, out = set(threading.enumerate()), {}

    def target():
        try:
            out['results'] = wave.executor.execute_wave(
                calls,
                agent_base=SimpleNamespace(call_tool=call_tool),
                context=SimpleNamespace(memory=memory),
                wave_name='wave-0',
                **kwargs,
            )
        except Exception as exc:  # raised again below, in the test's own thread
            out['error'] = exc

    thread = threading.Thread(target=target)
    thread.start()
    thread.join(timeout=WAIT)
    ended = not thread.is_alive()
    try:
        if ended and while_held:
            while_held()
    finally:
        if release:
            release.set()
        for t in set(threading.enumerate()) - before:
            t.join(timeout=WAIT)
    if 'error' in out:
        raise out['error']
    assert ended, 'the wave waited for a stuck call'
    return out['results']


def test_a_stuck_call_times_out_and_the_others_return(wave, monkeypatch):
    monkeypatch.setattr(wave.executor, '_TOOL_TIMEOUT_S', LIMIT)
    release = threading.Event()

    def call_tool(context, tool, args):
        if tool == 'stuck':
            release.wait(timeout=30)
        return {'tool': tool}

    memory = Memory()
    calls = [call('stuck'), call('quick'), call('also-quick')]
    results = run_wave(wave, calls, call_tool, memory=memory, release=release)

    assert results[0]['error'] == f'TimeoutError: no result after {LIMIT:g} s'
    assert [r.get('error') for r in results[1:]] == [None, None]
    assert sorted(memory.data) == ['wave-0.r1', 'wave-0.r2'], 'the stuck call stored nothing when it returned'


@pytest.mark.parametrize('slow', ['tool', 'store'])
def test_a_result_that_arrives_after_the_limit_is_dropped(wave, monkeypatch, slow):
    """The tool answers late, or the store takes the result late. Either way the call timed out.

    Storing the result counts as part of the call. A value that reached the store is
    cleared, and the result never reaches the run's duplicate tracking.
    """
    clock = fake_clock(wave, monkeypatch)
    monkeypatch.setattr(wave.executor, '_TOOL_TIMEOUT_S', 10.0)

    def eleven_seconds_later(*_):
        clock.now = 11.0

    def call_tool(context, tool, args):
        if slow == 'tool':
            eleven_seconds_later()
        return {'rows': [1, 2, 3]}

    memory = Memory(after_put=eleven_seconds_later if slow == 'store' else None)
    state = wave.run_state.RunState()
    results = run_wave(wave, [call('db.query', q='select')], call_tool, memory=memory, state=state)

    assert 'TimeoutError' in results[0]['error']
    assert memory.data == {}
    assert state.seen_results == {}
    if slow == 'store':
        assert memory.cleared == ['wave-0.r0']


def test_a_result_the_wave_gave_up_on_is_never_readable(wave, monkeypatch):
    """The store writes the value and then hangs. The run's memory never shows that value."""
    monkeypatch.setattr(wave.executor, '_TOOL_TIMEOUT_S', LIMIT)
    release, reads = threading.Event(), []
    store = Memory(after_put=lambda key: release.wait(timeout=30))
    run = wave.run_state.RunMemory(store, 'run-1')

    def read():
        reads.append(run.get('wave-0.r0')['ok'])

    results = run_wave(wave, [call('db.query')], lambda *_: 'SECRET', memory=run, release=release, while_held=read)
    read()

    assert 'TimeoutError' in results[0]['error']
    assert store.data == {'run-1/wave-0.r0': 'SECRET'}, 'written before the store hung'
    assert reads == [False, False], 'readable while the store hung, or after it returned'
    run.close()
    assert store.data == {}


def test_each_call_gets_the_limit_from_its_own_start(wave, monkeypatch):
    """One worker runs two 9 s calls in turn under a 10 s limit. The second starts at 9 s and is not cut off."""
    clock = fake_clock(wave, monkeypatch)
    monkeypatch.setattr(wave.executor, '_TOOL_TIMEOUT_S', 10.0)
    monkeypatch.setattr(wave.executor, '_MAX_WORKERS', 1)

    def call_tool(context, tool, args):
        clock.now += 9.0
        return {'tool': tool}

    results = run_wave(wave, [call('first'), call('second')], call_tool, memory=Memory())

    assert [r.get('error') for r in results] == [None, None]


def test_queued_calls_are_reported_as_not_run_when_every_worker_is_stuck(wave, monkeypatch):
    monkeypatch.setattr(wave.executor, '_TOOL_TIMEOUT_S', LIMIT)
    monkeypatch.setattr(wave.executor, '_MAX_WORKERS', 1)
    release, invoked = threading.Event(), []

    def call_tool(context, tool, args):
        invoked.append(tool)
        if tool == 'stuck':
            release.wait(timeout=30)
        return {'tool': tool}

    calls = [call('stuck'), call('workspace.write', path='a.txt')]
    results = run_wave(wave, calls, call_tool, memory=Memory(), release=release)

    assert 'no result after' in results[0]['error']
    assert results[1]['error'] == 'TimeoutError: not run, every worker was held by a call that timed out'
    assert invoked == ['stuck'], 'a call reported as not run ran once the worker was free'


def test_calls_stuck_from_an_earlier_step_keep_their_workers(wave, monkeypatch):
    """Each step builds a new pool. Calls still running from an earlier step count against its workers."""
    monkeypatch.setattr(wave.executor, '_MAX_WORKERS', 1)
    state, invoked = wave.run_state.RunState(), []
    state.background.add(Future())  # still running, holding the only worker

    def call_tool(context, tool, args):
        invoked.append(tool)

    results = run_wave(wave, [call('workspace.read')], call_tool, memory=Memory(), state=state)

    assert 'not run, every worker is held by a call that timed out earlier' in results[0]['error']
    assert invoked == []


@pytest.mark.parametrize(
    ('setting', 'timed_out'), [(None, True), (2000, False), (0, False)], ids=['unset-300', 'raised', 'no-limit']
)
def test_the_tool_timeout_setting_sets_the_limit_and_zero_turns_it_off(wave, monkeypatch, setting, timed_out):
    """The tool takes 1,000 s on a clock the test moves. Unset, the default of 300 s applies."""
    clock = fake_clock(wave, monkeypatch)

    def call_tool(context, tool, args):
        clock.now += 1000.0
        return {'rows': [1]}

    timeout = wave.rocketride_agent._tool_timeout(setting)  # how the driver reads the node setting
    results = run_wave(wave, [call('db.query')], call_tool, memory=Memory(), timeout=timeout)

    assert ('TimeoutError' in results[0].get('error', '')) is timed_out


CHECK = 'workspace.compile'


def _driver(wave, **config):
    """Build the driver from node config, through the real Config merge."""
    glb = SimpleNamespace(logicalType='agent_rocketride', connConfig=config)
    return wave.rocketride_agent.RocketRideDriver(SimpleNamespace(glb=glb))


def _context(wave, memory):
    tools = SimpleNamespace(list=[{'name': CHECK}, {'name': 'workspace.write'}])
    return wave.rocketride_agent.AgentContext(
        invoker=None, llm=None, tools=tools, memory=memory, run_id='run-1', pipe_id=0, framework='wave', started_at=''
    )


def _reply(**fields):
    """A planner reply as normalize_plan leaves it."""
    return {'done': False, 'tool_calls': [], 'remove': [], **fields, 'asked_done': fields.get('done', False)}


def _run_states(wave, monkeypatch):
    """Record each run's RunState, so a test can wait for the calls it gave up on."""
    states, real = [], wave.rocketride_agent.RunState
    monkeypatch.setattr(wave.rocketride_agent, 'RunState', lambda: states.append(real()) or states[-1])
    return states


def test_a_write_that_timed_out_holds_done_until_it_lands_and_is_checked(wave, monkeypatch):
    """A check that passes while a timed-out write is still running covers nothing.

    done is refused while the write is out, refused again once it lands (it changed the
    work after the check), and accepted after a check that runs once it has landed.
    """
    release, states = threading.Event(), _run_states(wave, monkeypatch)

    def call_tool(context, tool, args):
        if tool == 'workspace.write':
            release.wait(timeout=30)
        return {'ok': True}

    def write_lands():
        release.set()
        assert states[0].background.wait(WAIT) == 0, 'the write did not return'
        return _reply(done=True, answer='Done.')

    steps = iter(
        [
            lambda: _reply(tool_calls=[call('workspace.write', path='src/App.tsx')]),
            lambda: _reply(tool_calls=[call(CHECK)]),
            lambda: _reply(done=True, answer='Done.'),
            write_lands,
            lambda: _reply(tool_calls=[call(CHECK)]),
            lambda: _reply(done=True, answer='Done, checked after the write landed.'),
        ]
    )
    monkeypatch.setattr(wave.rocketride_agent, 'plan_wave', lambda **kw: next(steps)())
    driver = _driver(wave, verify_tool=CHECK)
    driver._tool_timeout_s, driver._max_waves = LIMIT, 8
    driver.call_tool = call_tool
    driver.sendSSE = lambda *a, **kw: None

    try:
        answer, trace = driver._run(context=_context(wave, Memory()), question=None)
    finally:
        release.set()

    waves = trace['waves']
    assert 'TimeoutError' in waves[0]['results'][0]['error']
    assert waves[2]['results'][0]['error'].startswith('Not finished: 1 call(s) that timed out are still running')
    assert waves[3]['results'][0]['error'].startswith('Not finished: call workspace.compile on its own, after')
    assert answer == 'Done, checked after the write landed.'
    assert trace['stop_reason'] == 'done'


def test_a_run_that_fails_waits_for_its_timed_out_call_before_it_ends(wave, monkeypatch):
    """The answer is ready, but a call is still inside the engine, so the run must not end yet.

    It ends once the call returns, and its memory is cleared after that, so the late
    write leaves nothing behind.
    """
    release, answered, memory, out = threading.Event(), threading.Event(), Memory(), {}

    def planning_fails():
        raise RuntimeError('Rate limit exceeded.')

    steps = iter([lambda: _reply(tool_calls=[call('workspace.write', path='src/App.tsx')]), planning_fails])
    monkeypatch.setattr(wave.rocketride_agent, 'plan_wave', lambda **kw: next(steps)())
    driver = _driver(wave)
    driver._tool_timeout_s = LIMIT
    driver.call_tool = lambda context, tool, args: release.wait(timeout=30) and {'ok': True}
    driver.sendSSE = lambda *a, **kw: None
    driver._synthesize = lambda **kw: answered.set() or 'answered from what was gathered'

    thread = threading.Thread(
        target=lambda: out.update(result=driver._run(context=_context(wave, memory), question=None))
    )
    thread.start()
    try:
        assert answered.wait(WAIT), 'the run never reached its fallback answer'
        thread.join(timeout=LIMIT)
        assert thread.is_alive(), 'the run ended while its timed-out call was still running'
    finally:
        release.set()
        thread.join(timeout=WAIT)

    assert not thread.is_alive()
    answer, trace = out['result']
    assert answer == 'answered from what was gathered'
    assert trace['stop_reason'] == 'error'
    assert memory.data == {}, 'the late write was left in memory'


def test_a_wave_whose_next_worker_cannot_start_waits_for_every_call(wave, monkeypatch):
    """Starting a worker can fail (a thread that cannot start) after submit() queued the call.

    A worker that is free later can still pick that call up, with no future to track
    it. So the failed wave cancels what has not started and waits for the rest before
    it raises: nothing it started is still inside the engine once the run ends.
    """
    release, first_started, ran = threading.Event(), threading.Event(), []

    class NoSecondWorker(wave.executor.ThreadPoolExecutor):
        def _adjust_thread_count(self):
            if self._threads:
                # The first call is running by now, so the failure lands mid-wave.
                assert first_started.wait(WAIT), 'the first call never started'
                raise RuntimeError("can't start new thread")
            super()._adjust_thread_count()

    def call_tool(context, tool, args):
        ran.append(args.get('table', 'a'))
        first_started.set()
        release.wait(timeout=30)
        return {'ok': True}

    monkeypatch.setattr(wave.executor, 'ThreadPoolExecutor', NoSecondWorker)
    before, out = set(threading.enumerate()), {}

    def target():
        try:
            wave.executor.execute_wave(
                [call('db.query'), call('db.query', table='b')],
                agent_base=SimpleNamespace(call_tool=call_tool),
                context=SimpleNamespace(memory=Memory()),
                wave_name='wave-0',
                state=wave.run_state.RunState(),
                timeout=LIMIT,
            )
        except Exception as exc:
            out['error'] = exc

    thread = threading.Thread(target=target)
    thread.start()
    try:
        assert first_started.wait(WAIT), 'the first call never started'
        thread.join(timeout=LIMIT)
        assert thread.is_alive(), 'the wave raised while its first call was still running'
    finally:
        release.set()
        thread.join(timeout=WAIT)

    assert not thread.is_alive()
    assert "can't start new thread" in str(out.get('error'))
    assert ran == ['a'], 'the queued call was cancelled, not run after the wave gave up'
    assert not [t for t in set(threading.enumerate()) - before if t.is_alive()], 'a worker outlived the wave'
