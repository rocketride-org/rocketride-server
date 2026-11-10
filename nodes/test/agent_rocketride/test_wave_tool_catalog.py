# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Tool schemas loaded on demand when the tool catalog is over the node's budget.

With ``tool_catalog_budget`` set and a catalog larger than it, each planning prompt
lists every tool as ``- name: summary`` plus a local ``tools.load`` step, and shows
the full schemas of loaded tools in Context. Before each planning request the
driver records which schemas that prompt shows (``RunState.shown_tools``); the
executor runs only those tools and answers every other call itself. Loads take
effect only when the wave keeps their result.

The ``wave`` fixture loads the node's modules from source. Tools, memory and the
model are small fakes; the planner, executor and driver are the real ones.
"""

import json
import threading
from types import SimpleNamespace

import pytest
from bench_tool_catalog import ScriptedPlanner, simulate_run, synthetic_catalog
from eager_scenarios import DictMemory, build_context, build_driver

LOAD = 'tools.load'
CHECK = 'node.catalog.lookup_029'


def _tools(n=30, **shape):
    return synthetic_catalog(n, **shape)


def _name(i):
    return f'node.catalog.lookup_{i:03d}'


def _state(wave, *, loaded=(), shown=None, compact=True):
    state = wave.run_state.RunState()
    if compact:
        state.loaded_tools = set(loaded)
        state.shown_tools = frozenset(loaded if shown is None else shown)
    return state


class _Host:
    """The driver side of call_tool: records every call that reaches a tool node."""

    def __init__(self, result=None):
        self.calls = []
        self.result = result if result is not None else {'ok': True}

    def call_tool(self, context, tool, args):
        self.calls.append((tool, args))
        return self.result


def _execute(wave, calls, *, tools=None, state, host=None, get=None, memory=None, timeout=None, wave_name='wave-0'):
    host = host or _Host()
    context = build_context(wave, tools if tools is not None else _tools(), get=get, memory=memory)
    results = wave.executor.execute_wave(
        calls, agent_base=host, context=context, wave_name=wave_name, state=state, timeout=timeout
    )
    return results, host


def _call(tool, **args):
    return {'tool': tool, 'args': args}


# ---------------------------------------------------------------------------
# Prompt
# ---------------------------------------------------------------------------


def _prompt(wave, view, tools=None):
    q = wave.planner._build_wave_question(
        context=build_context(wave, tools or _tools(200)), question=wave.planner.Question(), waves=[], tool_view=view
    )
    return q


def _view(tools, loaded=()):
    from ai.common.agent.tool_catalog import tool_view

    return tool_view(tools, set(loaded))


def test_large_catalog_prompt_lists_names_and_summaries_only(wave):
    tools = _tools(200)
    prompt = _prompt(wave, _view(tools), tools).getPrompt()

    assert '- node.catalog.lookup_000: Read item 000 by id.' in prompt
    assert prompt.count('"inputSchema"') == 2, 'only tools.load and memory.peek carry a schema'
    assert '200 tools are connected' in prompt
    assert 'Load before you call' in prompt


def test_loaded_schemas_are_in_context_only(wave):
    tools = _tools(200)
    line = json.dumps(tools[7], ensure_ascii=False)
    prompt = _prompt(wave, _view(tools, [_name(7)]), tools).getPrompt()

    assert line in prompt
    assert prompt.index(line) > prompt.index('### Context:')
    assert prompt.count(line) == 1


def test_prefix_is_stable_as_tools_load_and_is_a_prefix_of_the_prompt(wave):
    from ai.common.chat import ChatBase, sanitize_prompt

    class _CachingChat(ChatBase):
        SUPPORTS_PROMPT_CACHE_PREFIX = True

        def __init__(self):
            pass

    tools = _tools(200)
    chat = _CachingChat()
    empty = _prompt(wave, _view(tools), tools)
    loaded = _prompt(wave, _view(tools, [_name(1), _name(2), _name(3)]), tools)

    prefix = chat._prompt_cache_prefix(empty)
    assert prefix
    assert chat._prompt_cache_prefix(loaded) == prefix
    assert sanitize_prompt(loaded.getPrompt()).startswith(prefix)


def test_compact_block_is_under_25_percent_of_eager_for_200_tools(wave):
    tools = _tools(200)
    compact = wave.planner._build_tool_catalog(_view(tools))
    eager = wave.planner._build_all_tool_descriptions(build_context(wave, tools))

    assert len(compact) < 0.25 * len(eager)


def test_a_loaded_name_that_left_the_catalog_is_not_shown(wave):
    tools = _tools(30)
    view = _view(tools, ['gone.tool'])

    assert view.shown == frozenset()
    assert 'Loaded tool schemas (call' not in _prompt(wave, view, tools).getPrompt()


# ---------------------------------------------------------------------------
# Executor
# ---------------------------------------------------------------------------


def test_tools_load_by_name_runs_locally_and_publishes_when_kept(wave):
    state = _state(wave)
    (result,), host = _execute(wave, [_call(LOAD, names=[_name(1), _name(2)])], state=state)

    assert result['tool'] == LOAD
    assert result['summary'] == f'Loaded: {_name(1)}, {_name(2)}'
    assert state.loaded_tools == {_name(1), _name(2)}
    assert host.calls == []


def test_tools_load_by_query_adds_up_to_limit(wave):
    tools = _tools(10)
    tools[4]['description'] = 'Find an invoice by customer.'
    tools[6]['name'] = 'billing.invoice_list'
    tools[8]['name'] = 'billing.get_invoice'
    state = _state(wave)

    (result,), _ = _execute(wave, [_call(LOAD, query='invoice', limit=2)], tools=tools, state=state)

    assert result['summary'] == 'Loaded: billing.invoice_list, billing.get_invoice'
    assert state.loaded_tools == {'billing.invoice_list', 'billing.get_invoice'}


def test_tools_load_resolves_an_unlisted_name_through_the_host_lookup(wave):
    def get(name):
        if name == 'late.tool':
            return {'name': 'late.tool', 'description': 'Late.'}
        raise LookupError(f'Tool {name} not found')

    state = _state(wave)
    (result,), _ = _execute(wave, [_call(LOAD, names=['late.tool', 'ghost.tool'])], state=state, get=get)

    assert result['summary'] == 'Loaded: late.tool. Unknown: ghost.tool'
    assert state.loaded_tools == {'late.tool'}


@pytest.mark.parametrize(
    'args, error',
    [({}, 'tools.load needs names'), ({'names': ['ghost']}, "No tool matched the names ['ghost']")],
)
def test_tools_load_with_nothing_to_load_is_an_error(wave, args, error):
    state = _state(wave)
    (result,), _ = _execute(wave, [_call(LOAD, **args)], state=state)

    assert result['error'].startswith(error)
    assert state.loaded_tools == set()


def test_a_call_to_an_unshown_known_tool_is_skipped_and_loaded_for_the_next_step(wave):
    state = _state(wave)
    (result,), host = _execute(wave, [_call(_name(1), x=1)], state=state)

    assert result['tool'] == 'reply-check'
    assert result['error'].startswith(f'Skipped: {_name(1)} was called before its schema was loaded')
    assert result['args'] == 'x: 1'
    assert 'note' not in result
    assert host.calls == []
    assert state.loaded_tools == {_name(1)}


def test_an_unshown_name_the_host_cannot_find_is_reported_not_connected_without_dispatch(wave):
    """The host's lookup refreshes on a miss; a second lookup could find it. No second lookup happens."""
    lookups = []

    class ToolNotFoundError(ValueError):
        pass

    def get(name):
        lookups.append(name)
        raise ToolNotFoundError(f'Tool {name} not found in tool catalog (owning node re-queried)')

    state = _state(wave)
    (result,), host = _execute(wave, [_call('other.tool', a=1)], state=state, get=get)

    assert result['tool'] == 'reply-check'
    assert 'is not a connected tool (ToolNotFoundError:' in result['error']
    assert host.calls == []
    assert lookups == ['other.tool']
    assert state.loaded_tools == set()


def test_an_unshown_name_whose_lookup_hits_is_skipped_not_run(wave):
    state = _state(wave)
    (result,), host = _execute(wave, [_call('late.tool')], state=state, get=lambda name: {'name': name})

    assert result['error'].startswith('Skipped: late.tool was called before its schema was loaded')
    assert host.calls == []
    assert state.loaded_tools == {'late.tool'}


def test_load_and_call_in_the_same_step_runs_next_step(wave):
    state = _state(wave)
    first, host = _execute(wave, [_call(LOAD, names=[_name(1)]), _call(_name(1), x=1)], state=state)

    assert first[1]['error'].startswith('Skipped:')
    state.shown_tools = frozenset(state.loaded_tools)  # what the driver does before the next prompt
    (second,), _ = _execute(wave, [_call(_name(1), x=1)], state=state, host=host, wave_name='wave-1')

    assert host.calls == [(_name(1), {'x': 1})]
    assert 'note' not in second


def test_a_shown_tool_runs_through_the_host_as_before(wave):
    state = _state(wave, loaded=[_name(1)])
    (result,), host = _execute(wave, [_call(_name(1), id='1')], state=state)

    assert host.calls == [(_name(1), {'id': '1'})]
    assert result['summary']


def test_memory_peek_needs_no_load(wave):
    memory = DictMemory()
    memory.put('wave-0.r0', {'rows': [{'city': 'Zurich'}]})
    state = _state(wave)

    (result,), host = _execute(
        wave, [_call('memory.peek', key='wave-0.r0', path='rows[0].city')], state=state, memory=memory
    )

    assert result['preview'] == 'Zurich'
    assert host.calls == []


def test_eager_mode_never_skips_and_sends_tools_load_to_the_host(wave):
    state = _state(wave, compact=False)
    results, host = _execute(wave, [_call(_name(1), id='1'), _call(LOAD, names=[_name(2)])], state=state)

    assert host.calls == [(_name(1), {'id': '1'}), (LOAD, {'names': [_name(2)]})]
    assert all('summary' in r for r in results)
    assert state.loaded_tools is None


def test_a_skipped_call_does_not_resolve_memory_references(wave):
    reads = []
    memory = DictMemory()
    memory.get = lambda key: reads.append(key) or {'ok': False}
    state = _state(wave)

    (result,), host = _execute(wave, [_call(_name(1), data='{{memory.ref:missing}}')], state=state, memory=memory)

    assert result['error'].startswith('Skipped:')
    assert reads == []
    assert host.calls == []


def _blocking_get(release, name='late.tool'):
    def get(tool):
        release.wait(5)
        return {'name': name}

    return get


def test_a_late_load_never_publishes(wave):
    release = threading.Event()
    state = _state(wave)
    try:
        (result,), _ = _execute(
            wave, [_call(LOAD, names=['late.tool'])], state=state, get=_blocking_get(release), timeout=0.05
        )
        assert result['error'].startswith('TimeoutError: looking up tools.load took longer than')
        assert state.loaded_tools == set()
    finally:
        release.set()
    assert state.background.wait(5) == 0
    assert state.loaded_tools == set(), 'a worker the wave gave up on never publishes'

    state.shown_tools = frozenset(state.loaded_tools)
    (later,), host = _execute(wave, [_call('late.tool')], state=state, get=lambda n: {'name': n}, wave_name='wave-1')
    assert later['error'].startswith('Skipped:')
    assert host.calls == []


def test_a_late_skip_lookup_never_publishes(wave):
    release = threading.Event()
    state = _state(wave)
    try:
        (result,), _ = _execute(wave, [_call('late.tool')], state=state, get=_blocking_get(release), timeout=0.05)
        assert result['error'].startswith('TimeoutError: looking up late.tool took longer than')
        assert result['error'].endswith('it did not run')
    finally:
        release.set()
    assert state.background.wait(5) == 0
    assert state.loaded_tools == set()


def test_a_timed_out_local_call_is_flagged_as_not_changing_work(wave):
    release = threading.Event()
    state = _state(wave)
    try:
        _execute(wave, [_call(LOAD, names=['late.tool'])], state=state, get=_blocking_get(release), timeout=0.05)
        assert state.background.snapshot() == (0, 0)
        assert state.background.running() == 1
    finally:
        release.set()
    assert state.background.wait(5) == 0
    assert state.background.snapshot() == (0, 0)


def test_a_timed_out_local_call_is_not_a_repeat_later(wave):
    release = threading.Event()
    state = _state(wave)
    try:
        (first,), _ = _execute(
            wave, [_call(LOAD, names=['late.tool'])], state=state, get=_blocking_get(release), timeout=0.05
        )
    finally:
        release.set()
    state.background.wait(5)

    assert first['error'].startswith('TimeoutError: looking up tools.load took longer than')
    assert state.seen_calls == {}
    (again,), _ = _execute(
        wave, [_call(LOAD, names=['late.tool'])], state=state, get=lambda n: {'name': n}, wave_name='wave-1'
    )
    assert again['summary'] == 'Loaded: late.tool'
    assert 'note' not in again


def test_an_unstarted_local_call_keeps_the_not_run_reason(wave, monkeypatch):
    monkeypatch.setattr(wave.executor, '_MAX_WORKERS', 1)
    release = threading.Event()

    class Host(_Host):
        def call_tool(self, context, tool, args):
            release.wait(5)
            return super().call_tool(context, tool, args)

    state = _state(wave, loaded=[_name(1)])
    try:
        results, _ = _execute(
            wave, [_call(_name(1), id='1'), _call(LOAD, names=[_name(2)])], state=state, host=Host(), timeout=0.05
        )
    finally:
        release.set()
    state.background.wait(5)

    assert results[1]['error'] == 'TimeoutError: not run, every worker was held by a call that timed out'
    assert len(state.seen_calls) == 1, 'only the shown call was recorded'


def test_a_timed_out_shown_tool_still_counts(wave):
    release = threading.Event()

    class Host(_Host):
        def call_tool(self, context, tool, args):
            release.wait(5)
            return super().call_tool(context, tool, args)

    state = _state(wave, loaded=[_name(1)])
    try:
        _execute(wave, [_call(_name(1), id='1')], state=state, host=Host(), timeout=0.05)
        assert state.background.snapshot() == (1, 0)
    finally:
        release.set()
    state.background.wait(5)
    assert state.background.snapshot() == (0, 1)


# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------


class _Run:
    """One driver run with the real planner, executor and call_tool, and a scripted model."""

    def __init__(self, wave, monkeypatch, *, tools, replies, budget=None, verify_tool='', max_waves=8, get=None):
        self.views, self.prompts, self.invoked, self.warnings = [], [], [], []
        self.states = []
        real_plan, real_state = wave.rocketride_agent.plan_wave, wave.run_state.RunState

        def plan_wave(**kw):
            self.views.append(kw.get('tool_view'))
            return real_plan(**kw)

        monkeypatch.setattr(wave.rocketride_agent, 'plan_wave', plan_wave)
        monkeypatch.setattr(
            wave.rocketride_agent, 'RunState', lambda: self.states.append(real_state()) or self.states[-1]
        )
        monkeypatch.setattr(wave.rocketride_agent, 'warning', self.warnings.append)
        self.driver = build_driver(wave, budget=budget, verify_tool=verify_tool)
        self.driver._max_waves = max_waves
        script = list(replies)

        def call_llm_json(context, question):
            self.prompts.append(question.getPrompt())
            reply = script.pop(0) if script else {'done': True, 'answer': 'OK'}
            return reply(self) if callable(reply) else reply

        self.driver.call_llm_json = call_llm_json
        self.driver.call_llm = lambda context, question: 'synthesized'

        def invoke(tool, args):
            self.invoked.append((tool, args))
            return {'ok': True, 'tool': tool}

        self.tools = tools
        self.context = build_context(wave, tools, invoke=invoke, get=get)

    def run(self, question=None):
        q = question or self.driver_question()
        self.answer, self.trace = self.driver._run(context=self.context, question=q)
        return self

    def driver_question(self):
        from ai.common.schema import Question

        q = Question()
        q.addQuestion('Do the task.')
        return q


def _calls(*calls, done=False, answer=''):
    reply = {'tool_calls': [_call(t, **a) for t, a in calls]}
    if done:
        reply.update(done=True, answer=answer)
    return reply


def _done(answer='OK'):
    return {'done': True, 'answer': answer}


def test_budget_decides_the_mode_per_run(wave, monkeypatch):
    tools = _tools(30)  # 8,699 characters
    for budget, mode in [(1000, 'compact'), (8699, 'full'), (100000, 'full'), (0, 'full')]:
        run = _Run(wave, monkeypatch, tools=tools, replies=[_done()], budget=budget).run()
        assert run.trace['tool_catalog'] == {'mode': mode, 'tools': 30, 'chars': 8699, 'budget': budget}
        assert (run.views[0] is not None) == (mode == 'compact')
        assert run.trace['loaded_tools'] == ([] if mode == 'compact' else None)


def test_default_is_off(wave, monkeypatch):
    glb = SimpleNamespace(logicalType='agent_rocketride', connConfig={})
    driver = wave.rocketride_agent.RocketRideDriver(SimpleNamespace(glb=glb))
    assert driver._tool_catalog_budget == 0

    run = _Run(wave, monkeypatch, tools=_tools(200), replies=[_done()]).run()
    assert run.trace['tool_catalog']['mode'] == 'full'
    assert run.views == [None]


@pytest.mark.parametrize('value, budget', [(24000, 24000), ('500', 500), (-5, 0), ('', 0), (None, 0), ('x', 0)])
def test_the_budget_setting_is_read_from_the_node_config(wave, value, budget):
    glb = SimpleNamespace(logicalType='agent_rocketride', connConfig={'tool_catalog_budget': value})
    driver = wave.rocketride_agent.RocketRideDriver(SimpleNamespace(glb=glb))

    assert driver._tool_catalog_budget == budget


def test_over_budget_renders_the_compact_catalog(wave, monkeypatch):
    tools = _tools(200)
    run = _Run(wave, monkeypatch, tools=tools, replies=[_done()], budget=24000).run()
    prompt = run.prompts[0]

    assert 'tools.load' in prompt and 'Load before you call' in prompt
    assert not any(json.dumps(td, ensure_ascii=False) in prompt for td in tools)
    assert prompt.count('"inputSchema"') == 2


def test_a_connected_tool_named_tools_load_keeps_the_run_eager(wave, monkeypatch):
    tools = [*_tools(30), {'name': LOAD, 'description': 'A real tool.', 'inputSchema': {'type': 'object'}}]
    run = _Run(wave, monkeypatch, tools=tools, replies=[_calls((LOAD, {'id': '1'})), _done()], budget=1).run()

    assert run.views == [None, None]
    assert run.trace['tool_catalog']['collision'] == LOAD
    assert run.trace['tool_catalog']['mode'] == 'full'
    assert 'fallback_step' not in run.trace['tool_catalog']
    assert run.invoked == [(LOAD, {'id': '1'})]
    assert len(run.warnings) == 1


def test_a_tools_load_connected_by_a_refresh_switches_the_run_to_eager(wave, monkeypatch):
    """A lookup during step 1 connects a tool named tools.load; step 2 on is eager, and it runs as a tool."""
    check = 'tools.check'
    tools = [
        {'name': 'tools.other', 'description': 'Other.', 'inputSchema': {'type': 'object'}},
        {'name': check, 'description': 'Check.', 'inputSchema': {'type': 'object'}},
    ]

    def get(name):
        # The host's refresh on a miss: the owning node now also publishes tools.new and tools.load.
        names = {td['name'] for td in tools}
        for new in ('tools.new', LOAD):
            if new not in names:
                tools.append({'name': new, 'description': 'New.', 'inputSchema': {'type': 'object'}})
        match = [td for td in tools if td['name'] == name]
        if not match:
            raise LookupError(name)
        return match[0]

    replies = [
        _calls((LOAD, {'names': ['tools.new']})),
        _calls((LOAD, {'id': '123'})),
        _done('early'),
        _calls((check, {})),
        _done('checked'),
    ]
    run = _Run(wave, monkeypatch, tools=tools, replies=replies, budget=1, verify_tool=check, get=get).run()

    assert run.views[0].shown == frozenset({check})
    assert run.views[1:] == [None, None, None, None]
    assert run.invoked == [(LOAD, {'id': '123'}), (check, {})]
    refusal = run.trace['waves'][2]['results'][-1]['error']
    assert refusal.startswith(f'Not finished: call {check} on its own')
    assert run.trace['tool_catalog'] == {
        'mode': 'full',
        'tools': 2,
        'chars': run.trace['tool_catalog']['chars'],
        'budget': 1,
        'collision': LOAD,
        'fallback_step': 2,
        'loaded_before_fallback': [check, 'tools.new'],
    }
    assert run.trace['loaded_tools'] is None
    assert run.trace['stop_reason'] == 'done'
    assert run.answer == 'checked'
    assert run.trace['planning_steps'] == 5
    assert len(run.warnings) == 1


def test_check_tool_is_loaded_from_the_start(wave, monkeypatch):
    run = _Run(wave, monkeypatch, tools=_tools(30), replies=[_done()], budget=1, verify_tool=CHECK).run()

    assert run.views[0].shown == frozenset({CHECK})
    assert json.dumps(_tools(30)[29], ensure_ascii=False) in run.prompts[0]


def test_the_view_is_built_before_each_planning_request(wave, monkeypatch):
    replies = [
        _calls((LOAD, {'names': [_name(1)]})),
        _calls((LOAD, {'names': [_name(2)]}), (_name(1), {'id': '1'})),
        _done(),
    ]
    run = _Run(wave, monkeypatch, tools=_tools(30), replies=replies, budget=1).run()

    assert [v.shown for v in run.views] == [
        frozenset(),
        frozenset({_name(1)}),
        frozenset({_name(1), _name(2)}),
    ]
    assert run.states[0].shown_tools == run.views[-1].shown
    assert run.invoked == [(_name(1), {'id': '1'})]
    assert run.trace['loaded_tools'] == [_name(1), _name(2)]


def test_eager_unknown_tools_load_counts_as_a_change_as_today(wave, monkeypatch):
    def invoke_fails(tool, args):
        raise LookupError(f'Tool {tool} not found')

    run = _Run(
        wave,
        monkeypatch,
        tools=_tools(30),
        replies=[_calls((LOAD, {'names': ['x']})), _done()],
        verify_tool=CHECK,
        max_waves=2,
    )
    run.context.tools.invoke = invoke_fails
    run.run()

    assert run.trace['waves'][1]['results'][-1]['error'].startswith('Not finished: call')
    assert run.trace['stop_reason'] == 'max_waves'


def test_skipped_calls_and_loads_do_not_undo_a_passing_check(wave, monkeypatch):
    write = _name(5)
    replies = [
        _calls((LOAD, {'names': [write]})),
        _calls((write, {'id': '5'})),
        _calls((CHECK, {})),
        _calls((_name(7), {'id': '7'}), (LOAD, {'names': [_name(8)]})),
        _done('done'),
    ]
    run = _Run(wave, monkeypatch, tools=_tools(30), replies=replies, budget=1, verify_tool=CHECK).run()

    assert run.trace['stop_reason'] == 'done'
    assert run.answer == 'done'
    assert run.invoked == [(write, {'id': '5'}), (CHECK, {})]


def test_a_real_write_after_loading_still_needs_a_later_check(wave, monkeypatch):
    write = _name(5)
    replies = [
        _calls((LOAD, {'names': [write]})),
        _calls((write, {'id': '5'})),
        _done('too early'),
        _calls((CHECK, {})),
        _done('checked'),
    ]
    run = _Run(wave, monkeypatch, tools=_tools(30), replies=replies, budget=1, verify_tool=CHECK).run()

    assert run.trace['waves'][2]['results'][0]['error'].startswith(f'Not finished: call {CHECK} on its own')
    assert run.answer == 'checked'


def test_with_verify_args_only_the_exact_check_counts_in_compact_mode(wave, monkeypatch):
    replies = [_calls((CHECK, {'id': 'other'})), _done('too early'), _calls((CHECK, {'id': 'build'})), _done('ok')]
    run = _Run(wave, monkeypatch, tools=_tools(30), replies=replies, budget=1, verify_tool=CHECK)
    run.driver._verify_args = {'id': 'build'}
    run.run()

    assert run.trace['waves'][1]['results'][0]['error'].startswith('Not finished: call')
    assert run.answer == 'ok'


def test_a_discovery_timeout_after_a_passing_check_does_not_block_done(wave, monkeypatch):
    release = threading.Event()

    def get(name):
        release.wait(10)
        return {'name': name}

    replies = [_calls((CHECK, {})), _calls((LOAD, {'names': ['late.tool']})), _done('done')]
    run = _Run(wave, monkeypatch, tools=_tools(30), replies=replies, budget=1, verify_tool=CHECK, get=get)
    run.driver._tool_timeout_s = 0.05
    finished = threading.Event()

    def release_after_done(msg):
        run.warnings.append(msg)
        finished.set()
        release.set()

    monkeypatch.setattr(wave.rocketride_agent, 'warning', release_after_done)
    try:
        run.run()
    finally:
        release.set()

    assert run.trace['stop_reason'] == 'done'
    assert run.answer == 'done'
    assert finished.is_set(), 'the run waited for the timed-out lookup before it ended'
    assert run.states[0].background.running() == 0


def _scripted(wave, monkeypatch, budget, *, max_waves=10):
    tools = _tools(30)
    needed = [(_name(3), {'id': '3'}), (_name(4), {'id': '4'})]
    return simulate_run(wave, tools, budget, needed=needed, answer='Both read.', max_waves=max_waves)


def test_compact_run_matches_eager_run_with_one_more_step(wave, monkeypatch):
    eager = _scripted(wave, monkeypatch, 0)
    compact = _scripted(wave, monkeypatch, 1)

    assert eager.answer == compact.answer == 'Both read.'
    assert eager.host_calls == compact.host_calls == [(_name(3), {'id': '3'}), (_name(4), {'id': '4'})]
    assert compact.planning_steps == eager.planning_steps + 1
    assert compact.loaded_tools == [_name(3), _name(4)]
    assert eager.loaded_tools is None


def test_compact_run_one_step_short_of_the_limit_ends_in_synthesis(wave, monkeypatch):
    steps = _scripted(wave, monkeypatch, 0).planning_steps

    assert _scripted(wave, monkeypatch, 0, max_waves=steps).stop_reason == 'done'
    assert _scripted(wave, monkeypatch, 1, max_waves=steps).stop_reason == 'max_waves'


def test_compact_run_with_one_more_wave_finishes(wave, monkeypatch):
    steps = _scripted(wave, monkeypatch, 0).planning_steps

    assert _scripted(wave, monkeypatch, 1, max_waves=steps + 1).stop_reason == 'done'
    assert _scripted(wave, monkeypatch, 0, max_waves=steps + 1).stop_reason == 'done'


def test_two_concurrent_runs_keep_their_own_loaded_and_shown_sets(wave, monkeypatch):
    tools = _tools(30)
    views = {'run-a': [], 'run-b': []}
    real_plan = wave.rocketride_agent.plan_wave
    barrier = threading.Barrier(2, timeout=5)

    def plan_wave(**kw):
        views[kw['context'].run_id].append(kw['tool_view'].shown)
        if len(views[kw['context'].run_id]) == 2:
            barrier.wait()  # both runs are between their first and second step at once
        return real_plan(**kw)

    monkeypatch.setattr(wave.rocketride_agent, 'plan_wave', plan_wave)
    planners = {
        'run-a': ScriptedPlanner([(_name(1), {'id': '1'})], 'A'),
        'run-b': ScriptedPlanner([(_name(2), {'id': '2'})], 'B'),
    }
    driver = build_driver(wave, budget=1)
    driver.call_llm_json = lambda context, question: planners[context.run_id](context, question)
    traces = {}

    def go(run_id):
        context = build_context(wave, tools)
        context = wave.rocketride_agent.dataclasses.replace(context, run_id=run_id)
        traces[run_id] = driver._run(context=context, question=_question())[1]

    threads = [threading.Thread(target=go, args=(r,)) for r in views]
    for t in threads:
        t.start()
    for t in threads:
        t.join(10)

    assert traces['run-a']['stop_reason'] == traces['run-b']['stop_reason'] == 'done'
    assert traces['run-a']['loaded_tools'] == [_name(1)]
    assert traces['run-b']['loaded_tools'] == [_name(2)]
    assert all(s <= {_name(1)} for s in views['run-a'])
    assert all(s <= {_name(2)} for s in views['run-b'])


def _question():
    from ai.common.schema import Question

    q = Question()
    q.addQuestion('Do the task.')
    return q


def _raise(exc):
    def reply(run):
        raise exc

    return reply


@pytest.mark.parametrize(
    'replies, stop_reason, steps',
    [
        ([_raise(RuntimeError('model down'))], 'error', 1),
        ([_calls((_name(1), {'id': '1'})), _raise(RuntimeError('model down'))], 'error', 2),
        ([_done('answer only')], 'done', 1),
        ([_calls((LOAD, {'names': [_name(1)]})), _calls((_name(1), {'id': '1'})), _done()], 'done', 3),
        ([_calls((LOAD, {'names': [_name(1)]})), _calls((_name(1), {'id': '1'}))], 'max_waves', 2),
    ],
    ids=['plan-error-nothing-gathered', 'plan-error-with-work', 'answer-only', 'done-after-calls', 'synthesis'],
)
def test_trace_has_loaded_tools_at_every_exit(wave, monkeypatch, replies, stop_reason, steps):
    max_waves = 2 if stop_reason == 'max_waves' else 5
    run = _Run(wave, monkeypatch, tools=_tools(30), replies=replies, budget=1, max_waves=max_waves).run()

    assert run.trace['stop_reason'] == stop_reason
    assert 'loaded_tools' in run.trace
    assert run.trace['planning_steps'] == len(run.views) == steps


@pytest.mark.slow
def test_measurement_table(wave, monkeypatch, tmp_path):
    """Print the bench table (run with -s). Bounds: compact is under half of eager for 200 tools on the first step."""
    import bench_tool_catalog as bench

    rows = []
    for n in (30, 200):
        tools = _tools(n)
        needed = [(_name(3), {'id': '3'}), (_name(4), {'id': '4'})]
        for budget in (0, 1):
            rows.append((f'{n} tools', budget, simulate_run(wave, tools, budget, needed=needed, answer='Done.')))
    print('\n' + bench.report(rows))

    first = {(label, budget): run.requests[0].prompt.chars for label, budget, run in rows}
    assert first[('200 tools', 1)] < 0.5 * first[('200 tools', 0)]
    fixture = json.loads((bench.Path(bench.__file__).parent / 'fixtures' / 'eager_prompts.json').read_text())
    assert first[('30 tools', 0)] == len(fixture['first_30']['prompt']), 'budget 0 sends the recorded eager prompt'

    monkeypatch.setenv('TIKTOKEN_CACHE_DIR', str(tmp_path))
    monkeypatch.setattr(bench, '_ENCODING', [])
    assert bench.count_tokens('hello') is None
    assert 'n/a' in bench.report(rows[:1])
