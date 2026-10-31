# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""Lane counts for ``examples/cobalt-evaluation.pipe`` against a REAL engine.

Every other Cobalt test drives the node classes directly. That leaves one class
of bug invisible: anything that is only true of the engine boundary. Two were
found exactly there and neither was reachable from a unit test.

* The engine hands ``renderObject`` an ``IJson`` handle for ``objectTags``,
  where the unit tests hand it a ``dict``. ``merge_metadata`` ignores non-dicts,
  so the reference answer was dropped and every row scored 0.0 with "One of
  output or expected is empty".
* The engine forwards a lane handler's incoming argument after the handler
  returns unless the handler prevented it, so ``eval_cobalt`` put THREE answers
  downstream per input where it documents two.

This module pins both from the outside, over the SDK, with the shipped example.

WHERE IT RUNS. It needs ``ROCKETRIDE_URI`` to name a reachable engine, and the
``client`` fixture in ``nodes/test/conftest.py`` skips the session when that
engine does not answer. CI's ``nodes:test`` starts an engine with the same
provider mocks and sets ``ROCKETRIDE_URI`` for the pytest session, so this
module RUNS in CI; locally it skips unless you start one. That session is also
parallel, hence the ``xdist_group`` mark below. To run it the way it was run
for this change::

    cd <repo>/dist/server
    ROCKETRIDE_MOCK=<repo>/nodes/test/mocks ./engine --autoterm ai/eaas.py \\
        --host=127.0.0.1 --port=5567 --base_port=40000
    # then, from the repo root:
    ROCKETRIDE_URI=http://127.0.0.1:5567 pytest nodes/test/cobalt/test_live_pipeline_counts.py

``ROCKETRIDE_MOCK`` shadows ``langchain_openai``/``openai`` with
``nodes/test/mocks``, so no API key is needed and the literal
``${ROCKETRIDE_OPENAI_KEY}`` the example carries is never resolved.

THE MOCK LLM CAVEAT. Under ``ROCKETRIDE_MOCK`` the model returns one constant
string for every question, so the similarity scores are low and
``cobalt_passed`` is False by design. This module therefore asserts COUNTS and
PLUMBING - how many questions and answers crossed each hop, and whether the
reference reached the evaluator - never score quality. Scoring quality is what
``test_pipeline_metadata_hop.py`` covers offline, against the real evaluator.

COUNT EDGES, NOT TRAVERSALS. Each lane delivery appears in the trace as an
``enter`` and a ``leave`` on the same component, and a jq filter over the whole
document (``[.. | objects | select(has("cobalt_score"))] | length``) counts both
plus the object's ``end`` record - 18 for what is really 6 deliveries. The
helpers below count ``op == 'enter'`` on one component and one lane.
"""

import asyncio
import json
import os
import pathlib
import time

import pytest

_REPO_ROOT = pathlib.Path(__file__).resolve().parents[3]
_EXAMPLE_PIPE = _REPO_ROOT / 'examples' / 'cobalt-evaluation.pipe'

# The example's inline dataset holds three rows; read from the file so a row
# added there is a changed expectation here rather than a silent pass.
_SCAN_POLL_SECONDS = 2.0
_SCAN_TIMEOUT_SECONDS = float(os.getenv('ROCKETRIDE_COBALT_LIVE_TIMEOUT', '180'))
# The server clamps a log read to this many events per page.
_LOG_PAGE_EVENTS = 2000

# ONE WORKER FOR THE WHOLE MODULE. ``nodes:test`` sets ROCKETRIDE_URI itself
# (nodes/scripts/tasks.js), so this module is NOT skipped in CI, and that
# session runs pytest with ``-n <cpus> --dist loadgroup``. Every test here
# starts the same pipe, and the engine keys a running task on
# user+project_id+source, so a second worker's ``client.use()`` is refused with
# "Pipeline is already running." ``xdist_group`` puts all of them on one
# worker, the way ``nodes/test/conftest.py`` already groups the heavy dynamic
# node tests.
pytestmark = [
    pytest.mark.cobalt,
    pytest.mark.requires_server,
    pytest.mark.xdist_group('cobalt_live'),
    pytest.mark.skipif(
        not os.getenv('ROCKETRIDE_URI'),
        reason='live engine run: set ROCKETRIDE_URI to the engine to exercise the real pipeline',
    ),
]

# One pipeline run serves every assertion in this module: the run costs a
# scan plus four node hops, and re-running it per test would multiply that for
# no extra coverage.
_RUN_CACHE: dict = {}


def _example_pipe():
    """Parse the shipped example."""
    with _EXAMPLE_PIPE.open(encoding='utf-8') as handle:
        return json.load(handle)


def _dataset_rows(pipe):
    """Return the example's inline dataset rows."""
    for component in pipe['components']:
        if component.get('id') == 'dataset_cobalt_1':
            parameters = component['config']['parameters']
            profile = parameters[parameters['profile']]
            return json.loads(profile['items'])
    raise AssertionError(f'{_EXAMPLE_PIPE.name} has no dataset_cobalt_1 component')


def _arrivals(events, component, lane):
    """Return every payload delivered to ``component`` on ``lane``.

    Args:
        events: The trace events read back from the log.
        component: Component id, as the pipeline declares it.
        lane: Lane name, e.g. 'questions' or 'answers'.

    Returns:
        The ``trace.data`` of each ``enter`` record, in order.
    """
    delivered = []
    for event in events:
        if event.get('event') != 'apaevt_flow':
            continue
        body = event.get('body') or {}
        trace = body.get('trace') or {}
        if body.get('op') == 'enter' and body.get('component') == component and trace.get('lane') == lane:
            delivered.append(trace.get('data'))
    return delivered


def _lifecycle(events, component, hook):
    """Count how often a lifecycle hook ran on a component."""
    return len(_arrivals(events, component, hook))


def _payload(data, lane):
    """Unwrap one lane payload from a trace record."""
    return (data or {}).get(lane) or {}


def _is_score(data):
    """Whether a delivered answer is one of eval_cobalt's score answers."""
    answer = _payload(data, 'answers').get('answer')
    return isinstance(answer, dict) and 'cobalt_score' in answer


def _is_run_end(event):
    """Whether this event is the run's terminal record.

    The engine closes a run with ``apaevt_task`` ``end`` followed by
    ``apaevt_log_lifecycle`` ``run-end``; both are written after the last flow
    record of the run, so either one means the trace this module reads is
    complete.
    """
    body = event.get('body') or {}
    if event.get('event') == 'apaevt_log_lifecycle':
        return body.get('action') == 'run-end'
    if event.get('event') == 'apaevt_task':
        return body.get('action') == 'end'
    return False


async def _read_since(client, pipe, started_at):
    """Return every event this run has written so far.

    ``client.log.read`` answers with ONE page and the continuum keeps every
    earlier run of the same project and source, so on a machine that has run
    this pipe before, the first page can lie entirely in the past. Follow the
    ``nextSeq`` cursor to the end of the stream before deciding what the run
    has emitted.

    Args:
        client: A connected RocketRideClient.
        pipe: The parsed pipeline, for its project id and source.
        started_at: Epoch seconds; events older than this belong to a previous
            run and are dropped.

    Returns:
        This run's events, oldest first.
    """
    events = []
    cursor = None
    while True:
        options = {'from_time': started_at, 'max_events': _LOG_PAGE_EVENTS}
        if cursor is not None:
            options['cursor'] = cursor
        page = await client.log.read(pipe['project_id'], pipe['source'], **options)
        batch = page.get('events') or []
        events.extend(event for event in batch if (event.get('body') or {}).get('eventTime', 0) >= started_at)
        cursor = page.get('nextSeq')
        if not batch or cursor is None:
            return events


async def _run_once(client):
    """Start the example, wait for the run to finish, and return its trace events.

    Args:
        client: A connected RocketRideClient.

    Returns:
        Tuple of (parsed pipe, trace events produced by this run).
    """
    pipe = _example_pipe()
    started_at = time.time()

    # threads=1 is load-bearing: it puts every dataset row through ONE instance
    # chain, which is the arrangement that would collapse N rows into one if the
    # prompt node's closing() ran per instance rather than per object.
    started = await client.use(pipeline=pipe, threads=1, pipelineTraceLevel='full')
    token = started['token']

    try:
        # WAIT FOR THE RUN'S TERMINAL RECORD, NOT FOR QUIET. An earlier revision
        # treated "no new events for 5 s" as completion, which is a guess about
        # how fast the engine is: on a loaded machine - CI runs several pytest
        # workers and may be installing a node's dependencies at the same time -
        # a run that has only emitted its banner goes quiet for longer than that
        # and the assertions then run against a partial trace. Observed exactly
        # once while trialling this module under parallel load: a trace with one
        # question at prompt_1 instead of three. The run-end record cannot be
        # early, so the timeout below is the only failure bound.
        deadline = time.time() + _SCAN_TIMEOUT_SECONDS
        while time.time() < deadline:
            await asyncio.sleep(_SCAN_POLL_SECONDS)
            events = await _read_since(client, pipe, started_at)
            if any(_is_run_end(event) for event in events):
                return pipe, events

        pytest.fail(f'the example pipeline did not reach its run-end record within {_SCAN_TIMEOUT_SECONDS}s')
    finally:
        await client.terminate(token)


@pytest.fixture
async def live_run(client):
    """Run the example once per session and hand every test the same trace."""
    if 'result' not in _RUN_CACHE:
        _RUN_CACHE['result'] = await _run_once(client)
    return _RUN_CACHE['result']


@pytest.mark.asyncio
async def test_the_prompt_node_sees_one_question_per_dataset_row(live_run):
    """One shared prompt instance, opened and closed once per row."""
    pipe, events = live_run
    rows = _dataset_rows(pipe)

    assert len(_arrivals(events, 'prompt_1', 'questions')) == len(rows)
    assert _lifecycle(events, 'prompt_1', 'open') == len(rows)
    assert _lifecycle(events, 'prompt_1', 'closing') == len(rows), (
        'closing() must run once per object. Running it once per instance is the shape that '
        'would merge every dataset row into a single question and score only the last one'
    )
    assert _lifecycle(events, 'prompt_1', 'close') == len(rows)


@pytest.mark.asyncio
async def test_the_evaluator_emits_exactly_two_answers_per_answer_it_receives(live_run):
    """The enforced contract: the forwarded copy and the score, and nothing else."""
    _, events = live_run
    received = _arrivals(events, 'eval_cobalt_1', 'answers')
    delivered = _arrivals(events, 'response_answers_1', 'answers')

    assert received, 'no answers reached the evaluator'
    assert len(delivered) == 2 * len(received), (
        f'the sink saw {len(delivered)} answers for {len(received)} into the evaluator. Three per '
        f'input means the engine is still forwarding the incoming answer on top of the two the '
        f'node wrote'
    )


@pytest.mark.asyncio
async def test_every_evaluated_answer_produces_exactly_one_score(live_run):
    """Score answers and evaluated answers are one to one."""
    _, events = live_run
    received = _arrivals(events, 'eval_cobalt_1', 'answers')
    scores = [data for data in _arrivals(events, 'response_answers_1', 'answers') if _is_score(data)]

    assert len(scores) == len(received)


@pytest.mark.asyncio
async def test_the_reference_reaches_the_evaluator_over_the_real_engine(live_run):
    """Every score carries the dataset row's own reference on metadata.

    This is the assertion the source-mode ``objectTags`` handle broke: the rows
    arrived with their prompt intact and their metadata empty, so the scores
    were real-looking zeroes rather than an error.
    """
    pipe, events = live_run
    references = {row['expected'] for row in _dataset_rows(pipe)}
    scores = [data for data in _arrivals(events, 'response_answers_1', 'answers') if _is_score(data)]

    assert scores, 'no cobalt_score answer reached the sink'
    for data in scores:
        metadata = _payload(data, 'answers').get('metadata') or {}
        assert metadata.get('expected') in references, (
            f'a score answer reached the sink with metadata {metadata!r}. An empty metadata means '
            f'the reference was dropped between the dataset and the evaluator'
        )
        assert metadata.get('dataset_id'), 'the score cannot be joined back to its row without dataset_id'


@pytest.mark.asyncio
async def test_each_dataset_row_is_represented_in_the_scores(live_run):
    """No row is dropped and none collapses into another."""
    pipe, events = live_run
    rows = _dataset_rows(pipe)
    scores = [data for data in _arrivals(events, 'response_answers_1', 'answers') if _is_score(data)]

    seen = {(_payload(data, 'answers').get('metadata') or {}).get('dataset_id') for data in scores}
    assert len(seen) == len(rows), f'{len(seen)} distinct dataset ids among the scores, for {len(rows)} rows'
