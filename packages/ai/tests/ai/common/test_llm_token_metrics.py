# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Tests for LLM token accounting: report_llm_tokens + the usage/cache split."""

from ai.common.llm_adapter import _split_input_cache, report_llm_tokens

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
