# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Tests for LLM token accounting: report_llm_tokens + the usage/cache split."""

import pytest

import ai.common.llm_adapter as _adapter
from ai.common.llm_adapter import (
    LangChainAdapter,
    _split_input_cache,
    aggregate_usage,
    report_llm_tokens,
    turn_usage,
)

# Same singleton report_llm_tokens reports into; imported from the module (not the
# package) to avoid pulling the taskhook side of ai.web.metrics into the test.
from ai.web.metrics.metrics import metrics


def setup_function(_):
    metrics.reset()
    # No turn is open between tests; reset the per-turn collector to its default so a
    # leaked scope from one test cannot seed the next.
    _adapter._TURN_CALLS.set(None)


def _counters():
    return metrics.report()['counters']


def _events():
    return metrics.report()['events']


def test_reports_input_and_output_counters():
    report_llm_tokens(23, 37, model='claude-haiku-4-5')
    c = _counters()
    assert c['llm_input_tokens'] == 23
    assert c['llm_output_tokens'] == 37
    # No cache activity -> no cache counters.
    assert 'llm_cache_read_tokens' not in c
    assert 'llm_cache_creation_tokens' not in c


def test_no_per_call_event_is_emitted():
    # The per-call llm_tokens event fed an unbounded events list that taskMetricsObjectEnd
    # re-serialized in full after every object (O(N^2), multi-MB lines on long chat tasks).
    # It was dropped — the counters carry the billable totals, the turn collector the detail.
    report_llm_tokens(5, 9, model='gpt-5.4-mini')
    assert _events() == []
    assert _counters()['llm_input_tokens'] == 5


def test_reports_cache_counters_separately():
    report_llm_tokens(10, 4, model='m', cache_read_tokens=100, cache_creation_tokens=20)
    c = _counters()
    assert c['llm_input_tokens'] == 10
    assert c['llm_cache_read_tokens'] == 100
    assert c['llm_cache_creation_tokens'] == 20


def test_zero_usage_is_a_noop():
    report_llm_tokens(0, 0)
    assert _counters() == {}
    assert _events() == []


def test_counters_accumulate_across_calls():
    report_llm_tokens(3, 0)
    report_llm_tokens(4, 0)
    assert _counters()['llm_input_tokens'] == 7


def test_metrics_failure_is_suppressed(monkeypatch):
    def boom(*_a, **_k):
        raise RuntimeError('metrics down')

    monkeypatch.setattr(metrics, 'counter', boom)
    # Best-effort accounting must never break the chat turn.
    report_llm_tokens(1, 1)


def test_split_input_cache_subtracts_cache_from_total():
    # LangChain reports input_tokens as the full prompt; cache splits back out.
    um = {'input_tokens': 100, 'output_tokens': 20, 'input_token_details': {'cache_read': 30, 'cache_creation': 10}}
    assert _split_input_cache(um) == (60, 20, 30, 10)


def test_split_input_cache_without_details():
    assert _split_input_cache({'input_tokens': 40, 'output_tokens': 5}) == (40, 5, 0, 0)


# ---------------------------------------------------------------------------
# LangChainAdapter — the capture point every llm_* provider goes through
# ---------------------------------------------------------------------------

# Cumulative usage as LangChain reports it on the final chunk: input_tokens is the
# whole prompt, so the four counters below are 60/20/30/10 once cache splits out.
_USAGE = {'input_tokens': 100, 'output_tokens': 20, 'input_token_details': {'cache_read': 30, 'cache_creation': 10}}


class _Chunk:
    def __init__(self, content='', usage_metadata=None):
        self.content = content
        self.usage_metadata = usage_metadata
        self.response_metadata = None


class _FakeChatBedrock:
    """Declares no ``stream_usage``: the flag would reach it as an unknown kwarg."""

    model = 'anthropic.claude-sonnet-4-6'

    def __init__(self, chunks, *, raise_after=None, result=None):
        self._chunks = chunks
        self._raise_after = raise_after
        self._result = result
        self.kwargs = None

    def stream(self, messages, **kwargs):
        self.kwargs = kwargs
        for i, chunk in enumerate(self._chunks):
            yield chunk
            if self._raise_after is not None and i >= self._raise_after:
                raise RuntimeError('connection dropped')

    def invoke(self, messages, **kwargs):
        self.kwargs = kwargs
        return self._result


class _FakeChatOpenAI(_FakeChatBedrock):
    """OpenAI-family: declares the flag and defaults it off, so it must be asked."""

    model = 'gpt-5.4'
    stream_usage = None


class _FakeChatXAI(_FakeChatOpenAI):
    """Inherits the flag from the OpenAI base without 'OpenAI' in its class name."""

    model = 'grok-4'


class _FakeRejectsUsageFlag(_FakeChatOpenAI):
    """An old vLLM/strict proxy: rejects the usage flag before any chunk, streams without it.

    ``REJECT_STATUS`` is the openai SDK's BadRequestError shape (400); a FastAPI-based
    server answers the same rejection with UnprocessableEntityError (422).
    """

    model = 'vllm-local'
    REJECT_STATUS = 400

    def stream(self, messages, **kwargs):
        self.kwargs = kwargs
        if kwargs.get('stream_usage'):
            err = RuntimeError('stream_options.include_usage unsupported')
            err.status_code = self.REJECT_STATUS
            raise err
        yield from self._chunks


class _FakeRejectsUsageFlag422(_FakeRejectsUsageFlag):
    """vLLM's OpenAI-compatible server is FastAPI: request validation fails with 422."""

    REJECT_STATUS = 422


class _FakeRaises401(_FakeChatOpenAI):
    """A bad key: the failure carries status_code 401, so the flag retry must NOT fire."""

    model = 'gpt-401'
    RAISE_STATUS = 401

    def stream(self, messages, **kwargs):
        self.kwargs = kwargs
        err = RuntimeError(f'{self.RAISE_STATUS} rejected')
        err.status_code = self.RAISE_STATUS
        raise err
        yield  # unreachable — makes this a generator so the raise fires on first next()


class _FakeRaises429(_FakeRaises401):
    """A rate limit: a client error, but not a flag rejection — no second round trip."""

    model = 'gpt-429'
    RAISE_STATUS = 429


class _FakeRaisesTransient(_FakeChatOpenAI):
    """A connection error/timeout: no status_code, so it must NOT be mistaken for a flag
    rejection and retried unmetered — it re-raises.
    """

    model = 'gpt-transient'

    def stream(self, messages, **kwargs):
        self.kwargs = kwargs
        raise RuntimeError('connection reset')
        yield  # unreachable — generator so the raise fires on first next()


def _assert_four_counters():
    c = _counters()
    assert c['llm_input_tokens'] == 60
    assert c['llm_output_tokens'] == 20
    assert c['llm_cache_read_tokens'] == 30
    assert c['llm_cache_creation_tokens'] == 10


@pytest.mark.parametrize('cls', [_FakeChatOpenAI, _FakeChatXAI])
def test_stream_asks_for_usage_wherever_the_model_declares_the_flag(cls):
    """The gate is the declared field, not the class name: ChatXAI needs the flag
    just as much as ChatOpenAI, and silently reported nothing while it was named.
    """
    llm = cls([_Chunk('Hi'), _Chunk(' there', _USAGE)])

    list(LangChainAdapter(llm).stream('q'))

    assert llm.kwargs == {'stream_usage': True}
    _assert_four_counters()


def test_stream_omits_the_flag_for_a_model_that_lacks_it():
    llm = _FakeChatBedrock([_Chunk('Hi'), _Chunk(' there', _USAGE)])

    list(LangChainAdapter(llm).stream('q'))

    # An unknown kwarg would break the provider, so it must not be sent — and the
    # usage such a model volunteers is still read.
    assert 'stream_usage' not in llm.kwargs
    _assert_four_counters()


@pytest.mark.parametrize('cls', [_FakeRejectsUsageFlag, _FakeRejectsUsageFlag422])
def test_stream_retries_without_the_usage_flag_when_the_endpoint_rejects_it(cls):
    # A custom base URL that rejects include_usage (old vLLM/strict proxy) must not lose the
    # stream: we ask, the endpoint rejects it before any chunk, and we retry once without it.
    # 400 is the openai SDK's shape; a FastAPI-based server says 422 for the same rejection,
    # and gating on 400 alone dropped every such endpoint to the two-round-trip path.
    llm = cls([_Chunk('Hi'), _Chunk(' there')])

    events = list(LangChainAdapter(llm).stream('q'))

    # Streamed on the retry, with the flag dropped. That endpoint goes unmetered (no usage
    # chunk without the flag) but reasoning/text still flows.
    assert ''.join(e.text for e in events if e.type == 'text') == 'Hi there'
    assert 'stream_usage' not in llm.kwargs


@pytest.mark.parametrize('cls', [_FakeRaises401, _FakeRaises429])
def test_stream_does_not_retry_an_excluded_client_error(cls):
    # A 401/429 is a client error, but never the usage-flag rejection: it must surface
    # without a second identical round trip. The flag stays on and the error propagates.
    llm = cls([_Chunk('x')])

    with pytest.raises(RuntimeError):
        list(LangChainAdapter(llm).stream('q'))

    assert llm.kwargs == {'stream_usage': True}  # one attempt only; the flag was not stripped


def test_stream_does_not_retry_a_transient_error_without_a_status_code():
    # A connection error/timeout carries no status_code; the old broad retry would drop the
    # flag and succeed unmetered with a misleading warning. It must re-raise instead.
    llm = _FakeRaisesTransient([_Chunk('x')])

    with pytest.raises(RuntimeError):
        list(LangChainAdapter(llm).stream('q'))

    assert llm.kwargs == {'stream_usage': True}  # not stripped, not retried


def test_stream_keeps_the_final_total_not_the_sum_of_chunks():
    """Every provider reached today reports usage on one chunk, so max() returns that
    chunk's total; a delta-reporting provider would instead need the deltas summed.
    """
    llm = _FakeChatBedrock(
        [
            _Chunk('Hi', {'input_tokens': 100, 'output_tokens': 5}),
            _Chunk(' there', {'input_tokens': 100, 'output_tokens': 20}),
        ]
    )

    list(LangChainAdapter(llm).stream('q'))

    c = _counters()
    assert c['llm_input_tokens'] == 100
    assert c['llm_output_tokens'] == 20


def test_stream_reports_usage_when_the_stream_raises_mid_way():
    """A dropped stream is still chargeable: usage already seen must not be lost."""
    llm = _FakeChatBedrock([_Chunk('Hi', _USAGE), _Chunk(' there')], raise_after=0)

    with pytest.raises(RuntimeError):
        list(LangChainAdapter(llm).stream('q'))

    _assert_four_counters()


def test_stream_without_usage_metadata_reports_nothing():
    llm = _FakeChatBedrock([_Chunk('Hi'), _Chunk(' there')])

    list(LangChainAdapter(llm).stream('q'))

    assert _counters() == {}


def test_collect_reports_usage_from_the_invoke_result():
    llm = _FakeChatBedrock([], result=_Chunk('Hi there', _USAGE))

    text, _ = LangChainAdapter(llm).collect('q')

    assert text == 'Hi there'
    _assert_four_counters()


def test_turn_reader_returns_a_single_call():
    # The node reads its scope to hang usage on the Answer (Trace "Tokens" grid).
    with turn_usage() as read_usage:
        report_llm_tokens(14, 81, model='claude-haiku-4-5', cache_read_tokens=2, cache_creation_tokens=3)
        assert read_usage() == {
            'input': 14,
            'output': 81,
            'cache_read': 2,
            'cache_creation': 3,
            'model': 'claude-haiku-4-5',
        }


def test_turn_reader_sums_a_many_call_turn():
    # An agentic turn calls the model repeatedly; the Trace shows the turn total AND
    # every call's cost. Counters stay per-call (billing unchanged).
    with turn_usage() as read_usage:
        report_llm_tokens(10, 5, model='m1', cache_read_tokens=1, cache_creation_tokens=2)
        report_llm_tokens(30, 7, model='m2', cache_read_tokens=3, cache_creation_tokens=4)
        c1 = {'input': 10, 'output': 5, 'cache_read': 1, 'cache_creation': 2, 'model': 'm1'}
        c2 = {'input': 30, 'output': 7, 'cache_read': 3, 'cache_creation': 4, 'model': 'm2'}
        assert read_usage() == {
            'input': 40,
            'output': 12,
            'cache_read': 4,
            'cache_creation': 6,
            'model': 'm2',  # last model that actually reported usage
            'calls': 2,
            'breakdown': [c1, c2],  # each call's cost, in order, for the action history
        }


def test_turn_is_cleared_when_the_outermost_scope_exits():
    # Bounded to one turn: the second turn opens a fresh list, so it never inherits the
    # first's calls.
    with turn_usage() as r1:
        report_llm_tokens(10, 5, model='m1')
        assert r1()['input'] == 10
    with turn_usage() as r2:
        report_llm_tokens(30, 7, model='m2')
        assert r2() == {'input': 30, 'output': 7, 'cache_read': 0, 'cache_creation': 0, 'model': 'm2'}


def test_zero_usage_leaves_the_turn_empty():
    # No usage reported -> nothing to attach, so the Answer carries no tokens.
    with turn_usage() as read_usage:
        report_llm_tokens(0, 0)
        assert read_usage() is None


def test_nested_scope_reads_its_own_calls_while_the_outer_reads_all():
    # An agent can drive a sub-agent: the sub-agent's scope shows only its own calls,
    # the outer scope shows the whole turn (sub-agent included), and the list is freed
    # only when the outermost scope exits.
    with turn_usage() as outer:
        report_llm_tokens(10, 5, model='a')
        with turn_usage() as inner:
            report_llm_tokens(20, 7, model='b')
            report_llm_tokens(30, 9, model='b')
            assert inner()['calls'] == 2 and inner()['input'] == 50
        report_llm_tokens(1, 1, model='a')
        assert outer()['calls'] == 4 and outer()['input'] == 61 and outer()['output'] == 22
    with turn_usage() as fresh:
        assert fresh() is None


def test_calls_from_a_worker_thread_land_in_the_open_turn():
    # CrewAI/deepagent (and the rocketride tool wave) run kickoffs on a worker thread under
    # copy_context().run(...). copy_context copies the mapping, not the values, so the thread
    # inherits the SAME list object and its appends reach the reader that opened the turn.
    import threading
    from contextvars import copy_context

    with turn_usage() as read_usage:
        ctx = copy_context()  # snapshots the context WITH this turn's list bound
        t = threading.Thread(target=lambda: ctx.run(report_llm_tokens, 200, 60, model='crew'))
        t.start()
        t.join()  # the agent blocks on the kickoff before reading
        assert read_usage() == {'input': 200, 'output': 60, 'cache_read': 0, 'cache_creation': 0, 'model': 'crew'}


def test_two_overlapping_turns_do_not_read_each_others_calls():
    # Concurrent turns are normal (a ThreadPoolExecutor tool wave, one pipeline per inbound
    # message). Each opens its own list, so neither reads the other's calls — the bug a
    # single process-wide collector had.
    import threading

    results: dict = {}
    # timeout so a thread that dies before wait() fails the test with BrokenBarrierError
    # instead of parking the other one until the CI job hits its own limit.
    open_barrier = threading.Barrier(2, timeout=10)  # both scopes open before either reports
    report_barrier = threading.Barrier(2, timeout=10)  # both reported while both scopes still open

    def run_turn(name, n):
        with turn_usage() as read_usage:
            open_barrier.wait()
            report_llm_tokens(n, n, model=name)
            report_barrier.wait()
            results[name] = read_usage()

    a = threading.Thread(target=run_turn, args=('A', 10))
    b = threading.Thread(target=run_turn, args=('B', 9000))
    a.start()
    b.start()
    a.join()
    b.join()

    assert results['A'] == {'input': 10, 'output': 10, 'cache_read': 0, 'cache_creation': 0, 'model': 'A'}
    assert results['B'] == {'input': 9000, 'output': 9000, 'cache_read': 0, 'cache_creation': 0, 'model': 'B'}


def test_two_sibling_scopes_in_one_turn_do_not_read_each_others_calls():
    # A parallel tool wave: two invokes open nested scopes inside ONE turn (each worker runs
    # under copy_context().run, so both carry this turn's list). Each per-invoke reader must
    # show only its own call — a single turn list sliced by an offset could not, since both
    # siblings open at offset 0 — while the outer turn, after the wave joins, sees both.
    import threading
    from contextvars import copy_context

    results: dict = {}
    both_open = threading.Barrier(2, timeout=10)  # see the timeout note above

    with turn_usage() as outer:

        def make_worker(name, n):
            ctx = copy_context()  # snapshots the outer turn as this worker's parent

            def body():
                with turn_usage() as read_invoke:
                    both_open.wait()  # force both nested scopes open before either reports
                    report_llm_tokens(n, n, model=name)
                    results[name] = read_invoke()

            return lambda: ctx.run(body)

        ta = threading.Thread(target=make_worker('A', 10))
        tb = threading.Thread(target=make_worker('B', 9000))
        ta.start()
        tb.start()
        ta.join()
        tb.join()

        assert results['A'] == {'input': 10, 'output': 10, 'cache_read': 0, 'cache_creation': 0, 'model': 'A'}
        assert results['B'] == {'input': 9000, 'output': 9000, 'cache_read': 0, 'cache_creation': 0, 'model': 'B'}
        total = outer()
        assert total['calls'] == 2 and total['input'] == 9010


# ---------------------------------------------------------------------------
# aggregate_usage — how one scope's calls render on its row
# ---------------------------------------------------------------------------


def test_aggregate_usage_a_single_call_has_no_redundant_breakdown():
    # One call renders as plain chips; a breakdown of itself would be noise.
    with turn_usage():
        report_llm_tokens(10, 5, model='m1')
        assert 'breakdown' not in aggregate_usage()
        assert 'calls' not in aggregate_usage()


def test_aggregate_usage_sums_when_one_invoke_made_several_calls():
    with turn_usage():
        report_llm_tokens(10, 5, model='m1', cache_read_tokens=1)
        report_llm_tokens(30, 7, model='m2', cache_creation_tokens=2)
        assert aggregate_usage() == {
            'input': 40,
            'output': 12,
            'cache_read': 1,
            'cache_creation': 2,
            'model': 'm2',
            'calls': 2,
            'breakdown': [
                {'input': 10, 'output': 5, 'cache_read': 1, 'cache_creation': 0, 'model': 'm1'},
                {'input': 30, 'output': 7, 'cache_read': 0, 'cache_creation': 2, 'model': 'm2'},
            ],
        }


def test_aggregate_usage_is_none_when_the_scope_made_no_call():
    # A cached/failed call adds no entry, so the invoke row shows no grid at all.
    with turn_usage() as read_usage:
        assert read_usage() is None
        assert aggregate_usage() is None
