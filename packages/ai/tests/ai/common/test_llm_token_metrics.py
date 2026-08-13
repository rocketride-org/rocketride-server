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
    report_llm_tokens,
    turn_usage,
    usage_since,
)

# Same singleton report_llm_tokens reports into; imported from the module (not the
# package) to avoid pulling the taskhook side of ai.web.metrics into the test.
from ai.web.metrics.metrics import metrics


def setup_function(_):
    metrics.reset()
    # The turn collector is a module global; clear it so a leaked scope from one
    # test can't seed the next.
    with _adapter._USAGE_LOCK:
        _adapter._USAGE_CALLS.clear()
        _adapter._TURN_DEPTH = 0


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


def test_stream_keeps_the_final_total_not_the_sum_of_chunks():
    """Chunk counts are cumulative, so the reader takes max(), never a running sum."""
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
    # Bounded to one turn: a second turn does not inherit the first's calls.
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
    # the outer scope shows the whole turn (sub-agent included), and the collector is
    # cleared only when the outermost scope exits.
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
    # CrewAI/deepagent run kickoffs on a worker thread under a copied context, where a
    # ContextVar write would never propagate back to the reader. The module-global
    # collector does, so the agent's answer still carries the total.
    import threading

    with turn_usage() as read_usage:
        t = threading.Thread(target=lambda: report_llm_tokens(200, 60, model='crew'))
        t.start()
        t.join()  # the agent blocks on the kickoff before reading
        assert read_usage() == {'input': 200, 'output': 60, 'cache_read': 0, 'cache_creation': 0, 'model': 'crew'}


# ---------------------------------------------------------------------------
# usage_since — one invoke row's own slice of the turn
# ---------------------------------------------------------------------------


def test_usage_since_returns_only_the_calls_made_after_the_mark():
    # An agent's 7th invoke must show its own cost, not the running turn total.
    with turn_usage():
        report_llm_tokens(10, 5, model='m1')  # collector index 0
        report_llm_tokens(30, 7, model='m2')  # collector index 1
        assert usage_since(1) == {'input': 30, 'output': 7, 'cache_read': 0, 'cache_creation': 0, 'model': 'm2'}


def test_usage_since_a_single_call_has_no_redundant_breakdown():
    # One call renders as plain chips; a breakdown of itself would be noise.
    with turn_usage():
        report_llm_tokens(10, 5, model='m1')
        assert 'breakdown' not in usage_since(0)
        assert 'calls' not in usage_since(0)


def test_usage_since_sums_when_one_invoke_made_several_calls():
    with turn_usage():
        report_llm_tokens(10, 5, model='m1', cache_read_tokens=1)
        report_llm_tokens(30, 7, model='m2', cache_creation_tokens=2)
        assert usage_since(0) == {
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


def test_usage_since_is_none_when_no_call_came_after_the_mark():
    # A cached/failed call adds no entry, so the invoke row shows no grid at all.
    with turn_usage():
        report_llm_tokens(10, 5, model='m1')
        assert usage_since(1) is None
