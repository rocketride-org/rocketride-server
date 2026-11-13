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


def test_instance_getpipe_sets_the_caller_on_the_sub_pipe(endpoint):
    """The opener's ``_caller`` is set on the sub-pipe, reaches its instances at construction, and dies at putPipe."""
    pipe = endpoint.getPipe('none')
    node = _Node(pipe.next, endpoint)
    node._caller = {'userId': 'u-1', 'params': {}}
    try:
        sub = node.getPipe()
        try:
            assert sub.caller == node._caller
            built = [n.pyInstance for n in _chain(sub) if n.pyInstance is not None]
            assert built, 'the response node is a Python instance'
            assert all(inst._caller == node._caller for inst in built)
        finally:
            node.putPipe(sub)
        assert sub.caller is None
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


# ---------------------------------------------------------------------------
# Per-binding instances (plan 4.1 rule 2, C.1b): the slot is pooled, the
# node's IInstance is not
# ---------------------------------------------------------------------------


def _node(pipe, component_id):
    """The filter of one component on a pipe's chain."""
    for node in _chain(pipe):
        if node.pipeType.id == component_id:
            return node
    raise AssertionError(f'{component_id} is not on the chain')


def _response_class():
    """The response node's IInstance class, the one object the engine constructs instances from."""
    import importlib

    return importlib.import_module('nodes.response.IInstance').IInstance


def test_two_bindings_of_one_slot_get_distinct_instances(endpoint):
    """What binding A put on its instance is not there for binding B of the same slot."""
    first = endpoint.getPipe('none')
    try:
        a = _node(first, 'response_1').pyInstance
        a.left_behind = 'from binding A'
        assert _node(first, 'response_1').pyInstance is a, 'one instance for the whole binding'
    finally:
        endpoint.putPipe(first)

    second = endpoint.getPipe('none')
    try:
        assert second.pipeId == first.pipeId, 'the slot is reused'
        b = _node(second, 'response_1').pyInstance
        assert b is not a
        assert not hasattr(b, 'left_behind')
    finally:
        endpoint.putPipe(second)


def test_components_are_constructed_on_first_touch_only(monkeypatch):
    """A component the binding never calls into is never constructed; the first touch constructs it once."""
    built = []
    cls = _response_class()
    original_init = cls.__init__

    def counting_init(self, *args, **kwargs):
        built.append(1)
        original_init(self, *args, **kwargs)

    monkeypatch.setattr(cls, '__init__', counting_init)

    loader = engLib.ILoader()
    loader.beginLoad(PIPELINE)
    try:
        endpoint = loader.target

        # A binding that never reaches the node builds nothing
        pipe = endpoint.getPipe('none')
        node = _node(pipe, 'response_1')
        assert not node.bound
        endpoint.putPipe(pipe)
        assert built == []

        # The first touch builds it, once for the whole binding
        pipe = endpoint.getPipe('none')
        try:
            assert not node.bound
            node.pyInstance
            node.pyInstance
            assert node.bound
            assert built == [1]
        finally:
            endpoint.putPipe(pipe)
        assert not node.bound, 'putPipe ended the binding'
    finally:
        loader.endLoad()


def test_the_caller_is_in_place_before_begin_instance(monkeypatch):
    """``_caller`` is set from the pipe before the node's beginInstance runs; putPipe clears the pipe's."""
    seen = []
    monkeypatch.setattr(_response_class(), 'beginInstance', lambda self: seen.append(dict(self._caller)))

    loader = engLib.ILoader()
    loader.beginLoad(PIPELINE)
    try:
        endpoint = loader.target
        pipe = endpoint.getPipe('none')
        try:
            pipe.caller = {'userId': 'u-1', 'params': {}}
            instance = _node(pipe, 'response_1').pyInstance
            assert instance._caller == {'userId': 'u-1', 'params': {}}
            assert seen == [{'userId': 'u-1', 'params': {}}]
        finally:
            endpoint.putPipe(pipe)
        assert pipe.caller is None
    finally:
        loader.endLoad()


def test_end_instance_runs_at_putpipe_for_every_instance_the_binding_built(monkeypatch):
    """The put ends the instance the binding built, once, before the slot is handed out again."""
    ended = []
    monkeypatch.setattr(_response_class(), 'endInstance', lambda self: ended.append(id(self)))

    loader = engLib.ILoader()
    loader.beginLoad(PIPELINE)
    try:
        endpoint = loader.target
        pipe = endpoint.getPipe('none')
        first = id(_node(pipe, 'response_1').pyInstance)
        endpoint.putPipe(pipe)
        assert ended == [first]

        # A binding that never touched the node has nothing to end
        pipe = endpoint.getPipe('none')
        endpoint.putPipe(pipe)
        assert ended == [first]

        # The endpoint closing under an open pipe runs the same release through
        # endFilterInstance; ILoader.endLoad() only drops its reference, so that
        # path is the engine's task teardown, not this harness
    finally:
        loader.endLoad()


def test_a_failing_begin_instance_is_the_calls_error_and_the_next_binding_starts_clean(monkeypatch):
    """A constructor that raises surfaces on the touch; the half-built instance is dropped, not reused."""
    attempts = []

    def boom(self):
        attempts.append(1)
        raise RuntimeError('no room')

    monkeypatch.setattr(_response_class(), 'beginInstance', boom)

    loader = engLib.ILoader()
    loader.beginLoad(PIPELINE)
    try:
        endpoint = loader.target
        pipe = endpoint.getPipe('none')
        try:
            with pytest.raises(Exception, match='no room'):
                _node(pipe, 'response_1').pyInstance
        finally:
            endpoint.putPipe(pipe)

        pipe = endpoint.getPipe('none')
        try:
            with pytest.raises(Exception, match='no room'):
                _node(pipe, 'response_1').pyInstance
        finally:
            endpoint.putPipe(pipe)
        assert attempts == [1, 1], 'one construction attempt per binding'
    finally:
        loader.endLoad()


def test_10000_bindings_on_one_slot_leave_no_instance_behind(endpoint):
    """Nothing holds a binding's instance once putPipe has run."""
    import gc
    import weakref

    refs = []
    for _ in range(10000):
        pipe = endpoint.getPipe('none')
        try:
            refs.append(weakref.ref(_node(pipe, 'response_1').pyInstance))
        finally:
            endpoint.putPipe(pipe)
    gc.collect()

    assert sum(1 for ref in refs if ref() is not None) == 0


def test_binding_construction_stays_cheap(endpoint):
    """Constructing a node's instance for a binding costs under 50 us on the C++ path."""
    import time

    pipe = endpoint.getPipe('none')
    node = _node(pipe, 'response_1')
    endpoint.putPipe(pipe)

    def cycle(touch, n=2000):
        started = time.perf_counter()
        for _ in range(n):
            pipe = endpoint.getPipe('none')
            if touch:
                node.pyInstance
            endpoint.putPipe(pipe)
        return (time.perf_counter() - started) / n

    # Warm up, then measure the difference the construction makes
    cycle(True, 200)
    without = cycle(False)
    with_instance = cycle(True)

    assert with_instance - without < 50e-6, f'{(with_instance - without) * 1e6:.1f} us per instance'


def test_a_failing_end_instance_is_the_puts_error_and_the_slot_is_still_free(monkeypatch):
    """An endInstance that raises surfaces on putPipe; the binding is ended all the same and the slot is reusable."""

    def boom(self):
        raise RuntimeError('cannot let go')

    monkeypatch.setattr(_response_class(), 'endInstance', boom)

    loader = engLib.ILoader()
    loader.beginLoad(PIPELINE)
    try:
        endpoint = loader.target
        pipe = endpoint.getPipe('none')
        node = _node(pipe, 'response_1')
        node.pyInstance
        with pytest.raises(Exception, match='cannot let go'):
            endpoint.putPipe(pipe)
        assert not node.bound

        again = endpoint.getPipe('none')
        try:
            assert again.pipeId == pipe.pipeId, 'the slot came back despite the failed teardown'
            assert not node.bound
        finally:
            # No touch this time: nothing to end, the put succeeds
            endpoint.putPipe(again)
    finally:
        loader.endLoad()
