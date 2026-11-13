# Unit tests for the rocketlib package (the engine-side node library).
#
# These run inside the engine (engine.exe -m pytest) because rocketlib imports
# engLib: a real endpoint is built through ILoader on a one-node pipeline and
# bindings are taken from it exactly as data_conn and a node's sub-pipe do.
#

"""The binding seam (plan §7.4 / §14 Step 2b): ``getPipe(traceLevel, traceId)`` from Python."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

engLib = pytest.importorskip('engLib')

from rocketlib.filters import BindingLogger, IInstanceBase  # noqa: E402


PIPELINE = {
    'pipeline': {
        'source': 'prompt_1',
        'components': [
            {'id': 'prompt_1', 'provider': 'prompt', 'config': {}},
            {'id': 'response_1', 'provider': 'response', 'config': {}, 'input': [{'lane': 'text', 'from': 'prompt_1'}]},
        ],
    }
}


@pytest.fixture
def endpoint():
    """A live target endpoint on a prompt-to-response pipeline (one Python instance in the chain)."""
    loader = engLib.ILoader()
    loader.beginLoad(PIPELINE)
    try:
        yield loader.target
    finally:
        loader.endLoad()


# ---------------------------------------------------------------------------
# engLib.IServiceEndpoint.getPipe
# ---------------------------------------------------------------------------


def test_two_bindings_none_and_full_on_one_engine(endpoint):
    """Two new trees held at once carry their own level and distinct, monotonic ids."""
    quiet = endpoint.getPipe('none')
    loud = endpoint.getPipe('full')
    try:
        assert quiet.traceLevel == 'none'
        assert loud.traceLevel == 'full'
        assert quiet.traceId != loud.traceId
        assert loud.traceId > quiet.traceId
        # Two pipes, two slots
        assert quiet.pipeId != loud.pipeId
    finally:
        endpoint.putPipe(loud)
        endpoint.putPipe(quiet)


def test_trace_id_is_never_reused_across_10000_cycles(endpoint):
    """The slot is reused every cycle; the trace id never is."""
    seen = set()
    last = 0
    slots = set()
    for _ in range(10000):
        pipe = endpoint.getPipe('none')
        try:
            assert pipe.traceId > last
            assert pipe.traceId not in seen
            seen.add(pipe.traceId)
            slots.add(pipe.pipeId)
            last = pipe.traceId
        finally:
            endpoint.putPipe(pipe)
    assert slots == {0}


def test_default_level_is_the_endpoint_default(endpoint):
    """No level named binds at the task file's pipelineTraceLevel (none for the loader)."""
    pipe = endpoint.getPipe()
    try:
        assert pipe.traceLevel == 'none'
    finally:
        endpoint.putPipe(pipe)


def test_unknown_level_is_refused(endpoint):
    """A level outside none/metadata/summary/full never reaches the engine."""
    with pytest.raises(Exception, match='Unknown trace level'):
        endpoint.getPipe('verbose')


def test_joining_a_trace_shares_the_id_and_inherits_the_level(endpoint):
    """A pipe taken with an existing traceId reports that id and the tree's level."""
    first = endpoint.getPipe('full')
    joined = endpoint.getPipe('none', first.traceId)
    third = endpoint.getPipe('none', joined.traceId)
    try:
        assert joined.traceId == first.traceId
        assert joined.traceLevel == 'full'
        assert third.traceId == first.traceId
        assert third.traceLevel == 'full'
    finally:
        endpoint.putPipe(third)
        endpoint.putPipe(joined)
        endpoint.putPipe(first)


def test_two_pipes_with_one_trace_id_differ_only_in_slot(endpoint):
    """Pipes of one tree share the traceId; the slot tells them apart."""
    first = endpoint.getPipe('none')
    second = endpoint.getPipe('none', traceId=first.traceId)
    try:
        assert second.traceId == first.traceId
        assert second.pipeId != first.pipeId
    finally:
        endpoint.putPipe(second)
        endpoint.putPipe(first)


def test_released_or_unknown_trace_id_is_refused(endpoint):
    """A released trace id cannot be joined: nothing may attach to the next holder of its slot."""
    pipe = endpoint.getPipe('full')
    released = pipe.traceId
    endpoint.putPipe(pipe)

    with pytest.raises(Exception, match='Trace is not live'):
        endpoint.getPipe('none', released)
    with pytest.raises(Exception, match='Trace is not live'):
        endpoint.getPipe('none', 0xFFFFFFFF)


def test_every_instance_of_a_binding_reports_the_same_ids(endpoint):
    """The chain shares one pipe object, so the node's instance sees the pipe's ids."""
    pipe = endpoint.getPipe('summary')
    try:
        node = pipe.next
        while node is not None:
            assert node.traceId == pipe.traceId
            assert node.traceLevel == 'summary'
            node = node.next
    finally:
        endpoint.putPipe(pipe)


# ---------------------------------------------------------------------------
# rocketlib.filters.IInstanceBase - the node-facing wrapper
# ---------------------------------------------------------------------------


class _Node(IInstanceBase):
    """A node instance the way the engine wires it: instance + IEndpoint set."""

    def __init__(self, instance, endpoint):
        self.instance = instance
        self.IEndpoint = SimpleNamespace(endpoint=endpoint)


def test_instance_getpipe_joins_its_own_trace(endpoint):
    """``self.getPipe()`` from a node opens a sub-pipe in the node's tree without naming it."""
    pipe = endpoint.getPipe('full')
    node = _Node(pipe.next, endpoint)
    try:
        assert node.traceId == pipe.traceId

        sub = node.getPipe()
        try:
            assert sub.traceId == pipe.traceId
            assert sub.traceLevel == 'full'
            assert sub.pipeId != pipe.pipeId
        finally:
            node.putPipe(sub)
    finally:
        endpoint.putPipe(pipe)


def test_instance_getpipe_stamps_and_clears_the_caller(endpoint):
    """The opener's ``_caller`` rides down the sub-pipe's chain and is cleared at putPipe."""
    pipe = endpoint.getPipe('none')
    node = _Node(pipe.next, endpoint)
    node._caller = {'userId': 'u-1', 'params': {}}
    try:
        sub = node.getPipe()
        try:
            stamped = [n.pyInstance for n in _chain(sub) if n.pyInstance is not None]
            assert stamped, 'the response node is a Python instance'
            assert all(inst._caller == node._caller for inst in stamped)
            assert all(inst._settings is None for inst in stamped)
        finally:
            node.putPipe(sub)
        assert all(inst._caller is None for inst in stamped)
    finally:
        endpoint.putPipe(pipe)


def test_logger_captures_the_binding(endpoint, monkeypatch):
    """``self.logger()`` keeps the ids of the binding it was taken in, and sendSSE tags them."""
    import rocketlib.engine as engine

    # monitorSSE calls the engine module's function directly
    sent = []
    monkeypatch.setattr(engine.engLib, 'monitorOther', lambda key, payload: sent.append((key, payload)))

    pipe = endpoint.getPipe('metadata')
    node = _Node(pipe.next, endpoint)
    try:
        log = node.logger()
        assert isinstance(log, BindingLogger)
        assert (log.pipeId, log.traceId) == (pipe.pipeId, pipe.traceId)
    finally:
        endpoint.putPipe(pipe)

    # The pipe has moved on; the logger still speaks for its binding
    later = endpoint.getPipe('none')
    try:
        assert later.traceId != log.traceId
        log.sendSSE('thinking', message='still mine')
    finally:
        endpoint.putPipe(later)

    import json

    key, payload = sent[-1]
    body = json.loads(payload)
    assert key == 'SSE'
    assert body['pipe_id'] == log.pipeId
    assert body['traceId'] == log.traceId
    assert body['type'] == 'thinking'
    assert body['data'] == {'message': 'still mine'}


def _chain(pipe):
    """Walk a pipe's filter chain from the head down."""
    node = pipe
    while node is not None:
        yield node
        node = node.next
