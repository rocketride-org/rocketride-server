# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Base-level test: a node gets one persistent event loop and may write async ops.

``asyncio.run()`` per op builds and destroys a loop each call, so nothing bound to
that loop — a connection pool, a session, an ``asyncio.Lock`` — survives into the
next one. ``IGlobalBase`` now owns a single loop for the life of the node, and
``IInstanceBase`` completes any op that returns an awaitable on it.

These drive throwaway subclasses wired the way the engine wires them (attributes
assigned onto instances built with no arguments), so they pin the base behaviour
rather than any one node's.
"""

import asyncio
import concurrent.futures
import threading
from unittest.mock import MagicMock

import pytest

# engLib and depends are stubbed in conftest.py, which also makes rocketlib importable.
from rocketlib import APERR, AsyncBridge, Ec, IGlobalBase, IInstanceBase, invoke_function, tool_function


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _value(result=7):
    """A coroutine that simply produces a value."""
    return result


async def _boom():
    """A coroutine that fails with a distinctive type."""
    raise KeyError('boom')


async def _running_loop():
    """The loop the bridge is actually running this on."""
    return asyncio.get_running_loop()


async def _current_thread():
    """The thread the bridge is actually running this on."""
    return threading.current_thread()


class _Global(IGlobalBase):
    """A node global with nothing on it but the base behaviour."""


class _Pool:
    """Stands in for a loop-bound resource: records the loop it was built on."""

    def __init__(self):
        self.loop = asyncio.get_running_loop()


@pytest.fixture
def make_global():
    """Build IGlobals and guarantee every loop thread they start is stopped again."""
    made = []

    def _make(cls=_Global):
        glb = cls()
        made.append(glb)
        return glb

    yield _make

    for glb in made:
        glb._close_async_bridge()


# ---------------------------------------------------------------------------
# 1-4: the bridge itself
# ---------------------------------------------------------------------------


def test_loop_is_lazy_running_and_stable(make_global):
    """The loop appears only when asked for, runs on a daemon thread, and never changes."""
    glb = make_global()
    assert getattr(glb, '_rr_async_bridge', None) is None

    loop = glb.loop
    assert isinstance(getattr(glb, '_rr_async_bridge', None), AsyncBridge)
    assert loop.is_running()
    assert glb.loop is loop

    thread = glb.run_async(_current_thread())
    assert thread.daemon
    assert thread is not threading.current_thread()
    assert glb.run_async(_running_loop()) is loop


def test_run_async_returns_results_and_propagates_errors(make_global):
    """A result comes back as a plain value; a failure keeps its own type."""
    glb = make_global()

    assert glb.run_async(_value(42)) == 42

    with pytest.raises(KeyError):
        glb.run_async(_boom())


def test_run_async_timeout_raises_aperr_and_cancels(make_global):
    """A caller that walks away takes the coroutine with it."""
    glb = make_global()
    started = threading.Event()
    unwound = threading.Event()

    async def _slow():
        started.set()
        try:
            await asyncio.sleep(30)
        finally:
            unwound.set()

    # 0.5s, not 0.05: the assertions below need the body to have actually started,
    # and a cancel can otherwise land before the loop first schedules the task.
    with pytest.raises(APERR) as excinfo:
        glb.run_async(_slow(), timeout=0.5)

    assert excinfo.value.ec == Ec.Timeout
    assert started.is_set()
    # Cancellation is delivered on the loop, so the finally lands just after we return.
    assert unwound.wait(5)


def _off_thread(call, timeout=3.0):
    """
    Run *call* on a throwaway daemon thread so a hang fails the test instead of blocking it.

    Returns:
        tuple: (finished, outcome) where outcome holds 'value' or 'error'.
    """
    outcome = {}

    def _run():
        try:
            outcome['value'] = call()
        except BaseException as exc:  # noqa: BLE001 - the test inspects whatever came out
            outcome['error'] = exc

    thread = threading.Thread(target=_run, daemon=True)
    thread.start()
    thread.join(timeout)
    return not thread.is_alive(), outcome


def test_run_fails_fast_when_the_loop_thread_dies(make_global):
    """An untimed run() must not block an engine thread forever on a dead loop."""
    glb = make_global()
    loop = glb.loop
    thread = glb.run_async(_current_thread())

    # Stop the loop behind the bridge's back, the way an escaping error would.
    loop.call_soon_threadsafe(loop.stop)
    thread.join(3)
    assert not thread.is_alive()

    finished, outcome = _off_thread(lambda: glb.run_async(_value()))
    assert finished, 'run_async() hung after the loop thread died'
    assert isinstance(outcome.get('error'), RuntimeError)


def test_wait_returns_on_an_already_cancelled_future(make_global):
    """A cancelled future is finished, even though concurrent.futures.wait() disagrees."""
    glb = make_global()
    bridge = glb._async_bridge()
    assert bridge.loop.is_running()

    future = concurrent.futures.Future()
    assert future.cancel()  # plain CANCELLED: wait() never counts this as done

    finished, outcome = _off_thread(lambda: bridge._wait(future, None))
    assert finished, '_wait() spun on a cancelled future'
    assert 'error' not in outcome


def test_cancellation_on_a_live_bridge_is_not_reported_as_shutdown(make_global):
    """A coroutine cancelling itself is a cancellation, not the node closing."""
    glb = make_global()

    async def _cancels_itself():
        raise asyncio.CancelledError

    with pytest.raises(concurrent.futures.CancelledError):
        glb.run_async(_cancels_itself())

    # Still usable: nothing about this took the loop down.
    assert glb.run_async(_value()) == 7


def test_run_async_from_the_loop_thread_is_refused(make_global):
    """Blocking the loop on itself is a deadlock; it is reported instead."""
    glb = make_global()

    async def _reentrant():
        return glb.run_async(_value())

    with pytest.raises(RuntimeError, match='would deadlock'):
        glb.run_async(_reentrant())


# ---------------------------------------------------------------------------
# 5-8: dispatch
# ---------------------------------------------------------------------------


class _PoolNode(IInstanceBase):
    """An async op that builds a loop-bound resource once and reuses it."""

    def __init__(self):
        self.pool = None

    @invoke_function
    async def use_pool(self, param):
        """Return the loop this ran on and the pool, built on first use."""
        if self.pool is None:
            self.pool = _Pool()
        return {'loop': asyncio.get_running_loop(), 'pool': self.pool}


def test_async_op_reuses_loop_bound_state_across_calls(make_global):
    """The connection-pool-across-ops guarantee: one loop, one pool, many ops."""
    glb = make_global()
    inst = _PoolNode()
    inst.IGlobal = glb

    first = inst.invoke({'op': 'use_pool'})
    second = inst.invoke({'op': 'use_pool'})

    assert first['loop'] is glb.loop
    assert second['loop'] is glb.loop
    assert first['pool'] is second['pool']
    assert first['pool'].loop is glb.loop


class _ToolNode(IInstanceBase):
    """A tool node whose handler is async and whose timeout must stay private."""

    @tool_function(input_schema={'type': 'object'}, description='Echo the input.', timeout=5)
    async def echo(self, args):
        """Hand the input straight back."""
        await asyncio.sleep(0)
        return {'echoed': args}


def test_async_tool_function_dispatches_and_hides_its_timeout(make_global):
    """tool.invoke awaits the handler; tool.query says nothing about how long it may take."""
    glb = make_global()
    inst = _ToolNode()
    inst.IGlobal = glb

    param = {'op': 'tool.invoke', 'tool_name': 'echo', 'input': {'x': 1}}
    inst.invoke(param)
    assert param['output'] == {'echoed': {'x': 1}}

    query = {'op': 'tool.query', 'tools': []}
    with pytest.raises(APERR) as excinfo:
        inst.invoke(query)
    assert excinfo.value.ec == Ec.PreventDefault

    assert [d['name'] for d in query['tools']] == ['echo']
    assert all('timeout' not in descriptor for descriptor in query['tools'])


class _TimeoutNode(IInstanceBase):
    """One op with a declared timeout, one without, to pin both decorator forms."""

    @invoke_function(timeout=0.5)
    async def slow(self, param):
        """Take far longer than the op is allowed."""
        await asyncio.sleep(30)

    @invoke_function
    async def quick(self, param):
        """The bare decorator form, still async."""
        return 'ok'


def test_invoke_function_timeout_and_bare_form(make_global):
    """The declared timeout fires; the undecorated-with-arguments form is unaffected."""
    glb = make_global()
    inst = _TimeoutNode()
    inst.IGlobal = glb

    with pytest.raises(APERR) as excinfo:
        inst.invoke({'op': 'slow'})
    assert excinfo.value.ec == Ec.Timeout

    assert inst.invoke({'op': 'quick'}) == 'ok'


class _ConcurrentNode(IInstanceBase):
    """Two ops that can only both finish if they are on the loop at the same time."""

    def __init__(self):
        self.gate = None
        self.waiting = threading.Event()

    @invoke_function
    async def wait_for_gate(self, param):
        """Park on the gate until the other op opens it."""
        self.waiting.set()
        await asyncio.wait_for(self.gate.wait(), 10)
        return 'waited'

    @invoke_function
    async def open_gate(self, param):
        """Open the gate the other op is parked on."""
        self.gate.set()
        return 'opened'


def test_async_ops_overlap_across_threads(make_global):
    """Two engine threads invoking one instance: async ops on one loop overlap at await points."""
    glb = make_global()
    inst = _ConcurrentNode()
    inst.IGlobal = glb
    inst.gate = glb.run_async(_make_gate())

    results = {}

    def _call(op):
        results[op] = inst.invoke({'op': op})

    waiter = threading.Thread(target=_call, args=('wait_for_gate',))
    waiter.start()
    # The second op only proves anything once the first is genuinely parked.
    assert inst.waiting.wait(10)

    opener = threading.Thread(target=_call, args=('open_gate',))
    opener.start()

    waiter.join(10)
    opener.join(10)
    assert not waiter.is_alive()
    assert not opener.is_alive()
    assert results == {'wait_for_gate': 'waited', 'open_gate': 'opened'}


async def _make_gate():
    """An asyncio.Event built on the node loop, where both ops can use it."""
    return asyncio.Event()


class _SyncNode(IInstanceBase):
    """A plain synchronous op — the overwhelmingly common case."""

    @invoke_function
    def plain(self, param):
        """Return a value without touching asyncio at all."""
        return 42


def test_sync_ops_never_start_a_loop(make_global):
    """A node with no async op pays nothing: no bridge, no thread."""
    glb = make_global()
    inst = _SyncNode()
    inst.IGlobal = glb

    assert inst.invoke({'op': 'plain'}) == 42
    assert getattr(glb, '_rr_async_bridge', None) is None


# ---------------------------------------------------------------------------
# 10-12: teardown
# ---------------------------------------------------------------------------


class _RudeGlobal(IGlobalBase):
    """The common shape: an endGlobal override that never calls super()."""

    def endGlobal(self):
        """Clean up, forgetting the base entirely."""
        self.ran = True


def test_end_global_without_super_still_stops_the_loop(make_global):
    """The base guarantees teardown even when the override skips it."""
    glb = make_global(_RudeGlobal)
    loop = glb.loop
    thread = glb.run_async(_current_thread())

    glb.endGlobal()

    assert glb.ran is True
    assert not thread.is_alive()
    assert loop.is_closed()
    assert not glb._rr_async_bridge.is_running

    with pytest.raises(RuntimeError):
        glb.run_async(_value())


def test_end_global_base_and_repeat_and_never_started(make_global):
    """Teardown works undefined, twice over, and with nothing to tear down."""
    glb = make_global()
    loop = glb.loop
    glb.endGlobal()
    assert loop.is_closed()

    # Idempotent: the engine may well call it again on an error path.
    glb.endGlobal()

    never_started = make_global()
    never_started.endGlobal()
    assert getattr(never_started, '_rr_async_bridge', None) is None


class _NoGlobalNode(IInstanceBase):
    """A node shipping no IGlobal class at all — IGlobal stays None."""

    @invoke_function
    async def ping(self, param):
        """Run on whatever loop the base can find."""
        return asyncio.get_running_loop()


def test_async_op_without_an_iglobal_uses_the_fallback_loop():
    """Nodes with no IGlobal still get a persistent loop, shared process-wide."""
    inst = _NoGlobalNode()
    assert inst.IGlobal is None

    loop = inst.invoke({'op': 'ping'})
    assert loop is inst.loop
    assert loop.is_running()
    assert inst.invoke({'op': 'ping'}) is loop


class _MidGlobal(IGlobalBase):
    """An intermediate base that closes its own layer through super(), as packages/ai does."""

    def endGlobal(self):
        """Hand off to the base partway through the node's own teardown."""
        self.steps = getattr(self, 'steps', []) + ['mid']
        super().endGlobal()


class _LeafGlobal(_MidGlobal):
    """A node that calls super() first and still has loop work left to do."""

    def endGlobal(self):
        """Close the inherited layer, then close what this layer opened."""
        super().endGlobal()
        self.steps = getattr(self, 'steps', []) + ['leaf']
        self.closed = self.run_async(_value('leaf-closed'))


def test_super_first_then_run_async_still_works(make_global):
    """Only the outermost endGlobal frame tears the loop down."""
    glb = make_global(_LeafGlobal)
    loop = glb.loop

    glb.endGlobal()

    assert glb.steps == ['mid', 'leaf']
    assert glb.closed == 'leaf-closed'
    assert loop.is_closed()


def test_a_mock_iglobal_falls_back_instead_of_answering():
    """An IGlobal that only looks like one routes to the fallback loop, not to itself."""
    inst = _NoGlobalNode()
    inst.IGlobal = MagicMock()

    loop = inst.invoke({'op': 'ping'})
    assert loop is inst.loop
    assert loop.is_running()


class _ClosingGlobal(IGlobalBase):
    """A node that needs the loop during shutdown, to close what it opened."""

    def endGlobal(self):
        """Close the pool on the loop, the way a real node would."""
        self.closed = self.run_async(_value('pool-closed'))


def test_end_global_can_still_run_async(make_global):
    """The user's body runs first, with the loop alive; only then does it go."""
    glb = make_global(_ClosingGlobal)
    loop = glb.loop

    glb.endGlobal()

    assert glb.closed == 'pool-closed'
    assert loop.is_closed()
