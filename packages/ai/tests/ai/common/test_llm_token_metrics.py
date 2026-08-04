# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Tests for LLM token accounting: report_llm_tokens + the usage/cache split."""

import pytest

from ai.common.llm_adapter import LAST_LLM_USAGE_VAR, LangChainAdapter, _split_input_cache, report_llm_tokens

# Same singleton report_llm_tokens reports into; imported from the module (not the
# package) to avoid pulling the taskhook side of ai.web.metrics into the test.
from ai.web.metrics.metrics import metrics


def setup_function(_):
    metrics.reset()


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


def test_emits_llm_tokens_event_payload():
    report_llm_tokens(5, 9, model='gpt-5.4-mini')
    payload = {'input': 5, 'output': 9, 'cache_read': 0, 'cache_creation': 0, 'model': 'gpt-5.4-mini'}
    assert {'llm_tokens': payload} in _events()


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


def test_publishes_last_usage_on_the_contextvar():
    # The node reads this to hang the usage on the Answer (Trace "Tokens" grid).
    LAST_LLM_USAGE_VAR.set(None)
    report_llm_tokens(14, 81, model='claude-haiku-4-5', cache_read_tokens=2, cache_creation_tokens=3)
    assert LAST_LLM_USAGE_VAR.get() == {
        'input': 14,
        'output': 81,
        'cache_read': 2,
        'cache_creation': 3,
        'model': 'claude-haiku-4-5',
    }


def test_all_zero_usage_leaves_the_contextvar_unset():
    # No usage reported -> nothing to attach, so the Answer carries no tokens.
    LAST_LLM_USAGE_VAR.set(None)
    report_llm_tokens(0, 0)
    assert LAST_LLM_USAGE_VAR.get() is None
