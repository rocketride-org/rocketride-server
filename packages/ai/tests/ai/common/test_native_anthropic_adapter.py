# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Pins NativeAnthropicAdapter: native Messages stream → Events, same payload path."""

from ai.common.llm_adapter import Event
from ai.common.llm_native_stream import (
    NativeAnthropicAdapter,
    build_anthropic_thinking_kwargs,
    try_anthropic_native_chat_stream,
)


class _Delta:
    def __init__(self, type, thinking='', text='', stop_reason=None):
        self.type = type
        self.thinking = thinking
        self.text = text
        self.stop_reason = stop_reason


class _RawEvent:
    def __init__(self, type, delta=None):
        self.type = type
        self.delta = delta


class _Messages:
    def __init__(self, events):
        self._events = events
        self.seen = None

    def create(self, **kwargs):
        self.seen = kwargs
        return iter(self._events)


class _Client:
    def __init__(self, events):
        self.messages = _Messages(events)


class _LLM:
    def __init__(self, payload, client):
        self._payload = payload
        self._client = client

    def _get_request_payload(self, prompt, stop=None, stream=False):
        return {**self._payload, 'messages': [{'role': 'user', 'content': prompt}]}


class _Chat:
    def __init__(self, llm, thinking_mode=None):
        self._llm = llm
        self._extended_thinking = True
        self._thinking_mode_kwargs = thinking_mode or {}


def _chat_with(events, payload=None):
    return _Chat(_LLM(payload or {'model': 'claude-sonnet-4-6', 'max_tokens': 1000}, _Client(events)))


def test_native_adapter_yields_events_and_maps_finish():
    events = [
        _RawEvent('content_block_delta', _Delta('thinking_delta', thinking='cot')),
        _RawEvent('content_block_delta', _Delta('text_delta', text='answer')),
        _RawEvent('message_delta', _Delta('message_delta', stop_reason='end_turn')),
    ]
    adapter = NativeAnthropicAdapter(_chat_with(events))
    out = list(adapter.stream('q'))

    assert Event('thinking', 'cot') in out
    assert Event('text', 'answer') in out
    assert out[-1].type == 'done'
    assert out[-1].items == [{'role': 'assistant', 'content': 'answer'}]
    assert adapter.finish_reason == 'stop'


def test_handler_drives_adapter_and_reports_finish():
    events = [
        _RawEvent('content_block_delta', _Delta('text_delta', text='hi')),
        _RawEvent('message_delta', _Delta('message_delta', stop_reason='max_tokens')),
    ]
    finishes = []
    text = try_anthropic_native_chat_stream(
        _chat_with(events), 'q', on_chunk=lambda t: None, on_finish=finishes.append, on_reasoning_chunk=lambda t: None
    )
    assert text == 'hi'
    assert finishes == ['length']  # max_tokens → length


def test_thinking_mode_injected_into_payload_per_call():
    client = _Client([_RawEvent('content_block_delta', _Delta('text_delta', text='ok'))])
    chat = _Chat(
        _LLM({'model': 'claude-sonnet-4-6', 'max_tokens': 1000}, client),
        thinking_mode={'thinking': {'type': 'adaptive', 'display': 'summarized'}},
    )
    list(NativeAnthropicAdapter(chat).stream('q'))
    assert client.messages.seen['thinking'] == {'type': 'adaptive', 'display': 'summarized'}


def test_no_thinking_in_payload_when_mode_empty():
    client = _Client([_RawEvent('content_block_delta', _Delta('text_delta', text='ok'))])
    chat = _Chat(_LLM({'model': 'm', 'max_tokens': 10}, client))  # no thinking mode
    list(NativeAnthropicAdapter(chat).stream('q'))
    assert 'thinking' not in client.messages.seen


def test_haiku_45_gets_extended_thinking():
    kw = build_anthropic_thinking_kwargs('claude-haiku-4-5', 8192)
    assert kw.get('thinking', {}).get('type') == 'enabled'
    assert kw['thinking']['budget_tokens'] >= 1024


def test_haiku_latest_gets_extended_thinking():
    assert build_anthropic_thinking_kwargs('claude-haiku-latest', 8192).get('thinking')


def test_legacy_claude3_haiku_has_no_thinking():
    assert build_anthropic_thinking_kwargs('claude-3-haiku', 8192) == {}
