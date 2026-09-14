# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Repeated-result detection through the real agent_rocketride wave loop (#2032).

The observed failure rephrased its query every wave while the result stayed
identical, so argument-based deduplication would have missed it entirely. The
fingerprint is taken of the result instead.

It signals, it never blocks: the call still runs and the result is still stored,
with a `deduplicated` flag and a note naming the earlier key.

The planner is scripted, call_tool is real, and invocations are recorded.
"""

from typing import Any, Dict, List

from ai.common.schema import Question
from nodes.agent_rocketride.rocketride_agent import RocketRideDriver


class _RepeatingTools:
    """Host Tools channel whose search returns the same rows whatever it is asked."""

    def __init__(self) -> None:
        self.list: List[Dict[str, Any]] = [
            {
                'name': 'drive.file_search',
                'description': 'Search files.',
                'inputSchema': {'type': 'object', 'properties': {'query': {'type': 'string'}}},
            }
        ]
        self.invocations: List[tuple] = []
        self.rows = [{'id': f'f{i}', 'name': f'Document {i}.docx'} for i in range(25)]

    def invoke(self, tool_name: str, args: Dict[str, Any]) -> Any:
        self.invocations.append((tool_name, args))
        return {'files': self.rows}


class _CountingTools(_RepeatingTools):
    """Returns a different result on every call, so nothing should be flagged."""

    def invoke(self, tool_name: str, args: Dict[str, Any]) -> Any:
        self.invocations.append((tool_name, args))
        return {'files': self.rows[: len(self.invocations)]}


class _DictMemory:
    """Dict-backed Memory channel mirroring the {ok, value} contract."""

    def __init__(self) -> None:
        self.store: Dict[str, Any] = {}

    def put(self, key: str, value: Any) -> Dict[str, Any]:
        self.store[key] = value
        return {'ok': True}

    def get(self, key: str) -> Dict[str, Any]:
        if key in self.store:
            return {'ok': True, 'value': self.store[key]}
        return {'ok': False}

    def clear(self, key: str = None) -> Dict[str, Any]:
        if key is None:
            self.store.clear()
        else:
            self.store.pop(key, None)
        return {'ok': True}

    def list(self) -> Dict[str, Any]:
        return {'ok': True, 'keys': list(self.store)}


class _FakeHost:
    def __init__(self, tools) -> None:
        self.llm = object()
        self.tools = tools
        self.memory = _DictMemory()


class _FakeInner:
    def __init__(self) -> None:
        self.pipeId = 1
        self.written: List[Any] = []

    def writeAnswers(self, answer: Any) -> None:
        self.written.append(answer)

    def sendSSE(self, *args: Any, **kwargs: Any) -> None:
        pass


class _FakeIInstance:
    def __init__(self, tools) -> None:
        self._agent_host = _FakeHost(tools)
        self.instance = _FakeInner()


def _driver(plans: List[Dict[str, Any]]) -> RocketRideDriver:
    """
    A RocketRideDriver with __init__ bypassed and the planner scripted.

    Args:
        plans: One planner response per wave, returned in order.

    Returns:
        The driver, with call_tool left real so dispatches are recorded.
    """
    d = RocketRideDriver.__new__(RocketRideDriver)
    d._instructions = []
    d._agent_description = ''
    d._require_tool_call = False
    d._max_waves = 10
    plan_iter = iter(plans)
    d.call_llm_json = lambda context, prompt, **kw: next(plan_iter)
    return d


def _question() -> Question:
    q = Question()
    q.addQuestion('Find the email template in my Drive.')
    return q


def _search(query: str) -> Dict[str, Any]:
    """One wave that searches with the given query."""
    return {'tool_calls': [{'tool': 'drive.file_search', 'args': {'query': query}}], 'scratch': ''}


def _results(trace: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Flatten every result entry across the trace's waves."""
    return [r for w in trace.get('waves', []) for r in w.get('results', [])]


def test_repeated_result_is_flagged_but_never_blocked():
    """The second identical result is flagged, and the tool still ran."""
    plans = [_search('email template'), _search('template document'), {'done': True, 'answer': 'x', 'scratch': ''}]
    tools = _RepeatingTools()
    ii = _FakeIInstance(tools)
    d = _driver(plans)
    payload = d.run_agent(ii, _question(), emit_answers_lane=False)

    entries = _results(payload['stack'][0]['payload'])
    assert len(entries) == 2, f'expected one result per wave, got {len(entries)}'

    assert 'deduplicated' not in entries[0], 'the first result is new and must not be flagged'
    assert entries[1].get('deduplicated') is True, (
        'the second search returned identical rows from a different query, which is the '
        'no-progress signal the planner was missing'
    )
    assert entries[0]['key'] in entries[1]['note'], 'the note must name the key already holding the data'

    assert len(tools.invocations) == 2, 'the repeated call must still execute; this signals, it does not block'
    assert tools.invocations[0][1] != tools.invocations[1][1], 'the queries differed, so only the result matched'


def test_distinct_results_are_not_flagged():
    """A tool making genuine progress is never marked as repeating."""
    plans = [_search('a'), _search('b'), {'done': True, 'answer': 'x', 'scratch': ''}]
    ii = _FakeIInstance(_CountingTools())
    d = _driver(plans)
    payload = d.run_agent(ii, _question(), emit_answers_lane=False)

    entries = _results(payload['stack'][0]['payload'])
    assert all('deduplicated' not in e for e in entries), 'distinct results must not be flagged'


def test_removed_key_lets_an_identical_result_store_again():
    """A cleared key drops its fingerprint, so no note can point at a dead key."""
    plans = [
        _search('email template'),
        {
            'tool_calls': [{'tool': 'drive.file_search', 'args': {'query': 'again'}}],
            'remove': ['wave-0.r0'],
            'scratch': '',
        },
        {'done': True, 'answer': 'x', 'scratch': ''},
    ]
    ii = _FakeIInstance(_RepeatingTools())
    d = _driver(plans)
    payload = d.run_agent(ii, _question(), emit_answers_lane=False)

    entries = _results(payload['stack'][0]['payload'])
    assert entries, 'the surviving wave should still carry its result'
    assert all('deduplicated' not in e for e in entries), (
        'the earlier key was removed, so its fingerprint must be forgotten rather than '
        'pointing the planner at a key that no longer resolves'
    )


def test_two_identical_calls_in_one_wave_flag_exactly_one():
    """
    A wave dispatches its calls on a thread pool, so the check and the write race.

    Both could read an empty slot and neither would be flagged. Exactly one entry
    should stay unflagged as the original.
    """
    plans = [
        {
            'tool_calls': [
                {'tool': 'drive.file_search', 'args': {'query': 'a'}},
                {'tool': 'drive.file_search', 'args': {'query': 'b'}},
            ],
            'scratch': '',
        },
        {'done': True, 'answer': 'x', 'scratch': ''},
    ]
    tools = _RepeatingTools()
    ii = _FakeIInstance(tools)
    d = _driver(plans)
    payload = d.run_agent(ii, _question(), emit_answers_lane=False)

    entries = _results(payload['stack'][0]['payload'])
    assert len(entries) == 2
    flagged = [e for e in entries if e.get('deduplicated')]
    assert len(flagged) == 1, (
        f'{len(flagged)} of 2 identical in-wave results were flagged; the fingerprint check and write must not race'
    )
    assert len(tools.invocations) == 2, 'both calls still run'


class _FailingThenRepeatingTools(_RepeatingTools):
    """Fails the first call, then returns the same rows for every later call."""

    def invoke(self, tool_name: str, args: Dict[str, Any]) -> Any:
        self.invocations.append((tool_name, args))
        if len(self.invocations) == 1:
            raise RuntimeError('upstream unavailable')
        return {'files': self.rows}


def test_a_failed_call_does_not_poison_the_fingerprint_index():
    """
    An error never reaches the store path, so a retry is not mistaken for a repeat.

    A failure followed by a successful call is progress, and flagging that first
    success as a duplicate would tell the planner the opposite.
    """
    plans = [_search('a'), _search('b'), _search('c'), {'done': True, 'answer': 'x', 'scratch': ''}]
    ii = _FakeIInstance(_FailingThenRepeatingTools())
    d = _driver(plans)
    payload = d.run_agent(ii, _question(), emit_answers_lane=False)

    entries = _results(payload['stack'][0]['payload'])
    errored = [e for e in entries if e.get('error')]
    assert len(errored) == 1, 'the first call should have failed'
    first_success = next(e for e in entries if not e.get('error'))
    assert 'deduplicated' not in first_success, 'the first successful result is new information'


def test_identical_results_from_different_tools_are_still_flagged():
    """
    The fingerprint is of the result, not the call, so a match across tools counts.

    Two tools returning the same data means the second added nothing, which is the
    signal regardless of which tool produced it.
    """
    tools = _RepeatingTools()
    tools.list.append(
        {
            'name': 'drive.file_list',
            'description': 'List files.',
            'inputSchema': {'type': 'object', 'properties': {}},
        }
    )
    plans = [
        _search('a'),
        {'tool_calls': [{'tool': 'drive.file_list', 'args': {}}], 'scratch': ''},
        {'done': True, 'answer': 'x', 'scratch': ''},
    ]
    ii = _FakeIInstance(tools)
    d = _driver(plans)
    payload = d.run_agent(ii, _question(), emit_answers_lane=False)

    entries = _results(payload['stack'][0]['payload'])
    assert len(entries) == 2
    assert entries[1].get('deduplicated') is True
    assert entries[0]['key'] in entries[1]['note']
