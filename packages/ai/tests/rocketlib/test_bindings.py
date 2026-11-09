# Unit tests for the rocketlib package (the engine-side node library).
#
# These run inside the engine (engine.exe -m pytest) because rocketlib imports
# engLib: a real endpoint is built through ILoader on a one-node pipeline and
# bindings are taken from it exactly as data_conn and a node's sub-pipe do.
#

"""The binding seam (plan §7.4 / §14 Step 2b): ``getPipe(traceLevel, parentBindingId)`` from Python."""

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
    """Two bindings held at once carry their own level and distinct, monotonic ids."""
    quiet = endpoint.getPipe('none')
    loud = endpoint.getPipe('full')
    try:
        assert quiet.traceLevel == 'none'
        assert loud.traceLevel == 'full'
        assert quiet.bindingId != loud.bindingId
        assert loud.bindingId > quiet.bindingId
        # Each root binding is its own root
        assert quiet.rootBindingId == quiet.bindingId
        assert loud.rootBindingId == loud.bindingId
        # Two pipes, two slots
        assert quiet.pipeId != loud.pipeId
    finally:
        endpoint.putPipe(loud)
        endpoint.putPipe(quiet)


def test_binding_id_is_never_reused_across_10000_cycles(endpoint):
    """The slot is reused every cycle; the binding id never is."""
    seen = set()
    last = 0
    slots = set()
    for _ in range(10000):
        pipe = endpoint.getPipe('none')
        try:
            assert pipe.bindingId > last
            assert pipe.bindingId not in seen
            seen.add(pipe.bindingId)
            slots.add(pipe.pipeId)
            last = pipe.bindingId
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


def test_child_binding_inherits_root_and_level(endpoint):
    """A sub-pipe opened from inside a binding reports the parent's root and level."""
    parent = endpoint.getPipe('full')
    child = endpoint.getPipe('none', parent.bindingId)
    grandchild = endpoint.getPipe('none', child.bindingId)
    try:
        assert child.bindingId != parent.bindingId
        assert child.rootBindingId == parent.bindingId
        assert child.traceLevel == 'full'
        assert grandchild.rootBindingId == parent.bindingId
        assert grandchild.traceLevel == 'full'
    finally:
        endpoint.putPipe(grandchild)
        endpoint.putPipe(child)
        endpoint.putPipe(parent)


def test_released_parent_is_refused(endpoint):
    """A released binding id is not a parent: nothing may attach to the next holder of its slot."""
    parent = endpoint.getPipe('full')
    released = parent.bindingId
    endpoint.putPipe(parent)

    with pytest.raises(Exception, match='Parent binding is not live'):
        endpoint.getPipe('none', released)


def test_every_instance_of_a_binding_reports_the_same_ids(endpoint):
    """The chain shares one pipe object, so the node's instance sees the pipe's ids."""
    pipe = endpoint.getPipe('summary')
    try:
        node = pipe.next
        while node is not None:
            assert node.bindingId == pipe.bindingId
            assert node.rootBindingId == pipe.rootBindingId
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


def test_instance_getpipe_passes_its_own_binding_as_parent(endpoint):
    """``self.getPipe()`` from a node opens a child of the node's binding without naming it."""
    pipe = endpoint.getPipe('full')
    node = _Node(pipe.next, endpoint)
    try:
        assert node.bindingId == pipe.bindingId
        assert node.rootBindingId == pipe.bindingId

        sub = node.getPipe()
        try:
            assert sub.rootBindingId == pipe.bindingId
            assert sub.traceLevel == 'full'
            assert sub.bindingId > pipe.bindingId
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
        assert (log.pipeId, log.bindingId, log.rootBindingId) == (pipe.pipeId, pipe.bindingId, pipe.rootBindingId)
    finally:
        endpoint.putPipe(pipe)

    # The pipe has moved on; the logger still speaks for its binding
    later = endpoint.getPipe('none')
    try:
        assert later.bindingId != log.bindingId
        log.sendSSE('thinking', message='still mine')
    finally:
        endpoint.putPipe(later)

    import json

    key, payload = sent[-1]
    body = json.loads(payload)
    assert key == 'SSE'
    assert body['bindingId'] == log.bindingId
    assert body['rootBindingId'] == log.rootBindingId
    assert body['type'] == 'thinking'
    assert body['data'] == {'message': 'still mine'}


def _chain(pipe):
    """Walk a pipe's filter chain from the head down."""
    node = pipe
    while node is not None:
        yield node
        node = node.next
