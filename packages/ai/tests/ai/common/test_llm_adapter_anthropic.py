# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Pins AnthropicAdapter: thinking/text deltas → Events, opaque content in done.items."""

from ai.common.llm_adapter import AnthropicAdapter, Event


class _Delta:
    def __init__(self, type, thinking='', text=''):
        self.type = type
        self.thinking = thinking
        self.text = text


class _Ev:
    def __init__(self, type, delta=None):
        self.type = type
        self.delta = delta


class _Final:
    def __init__(self, content):
        self.content = content


class _Stream:
    def __init__(self, events, final):
        self._events = events
        self._final = final

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def __iter__(self):
        return iter(self._events)

    def get_final_message(self):
        return self._final


class _Messages:
    def __init__(self, stream):
        self._stream = stream
        self.seen = None

    def stream(self, **kwargs):
        self.seen = {**kwargs, 'messages': list(kwargs['messages'])}
        return self._stream


class _Client:
    def __init__(self, stream):
        self.messages = _Messages(stream)


def test_deltas_to_events_and_opaque_done_items():
    final_content = [
        {'type': 'thinking', 'thinking': 'reasoning', 'signature': 'sig'},
        {'type': 'text', 'text': 'answer'},
    ]
    events = [
        _Ev('content_block_delta', _Delta('thinking_delta', thinking='reasoning')),
        _Ev('content_block_delta', _Delta('text_delta', text='answer')),
        _Ev('message_stop'),
    ]
    client = _Client(_Stream(events, _Final(final_content)))
    adapter = AnthropicAdapter(
        client, model='claude-sonnet-4-6', thinking={'type': 'adaptive', 'display': 'summarized'}
    )

    out = list(adapter.stream('q'))

    assert Event('thinking', 'reasoning') in out
    assert Event('text', 'answer') in out
    done = out[-1]
    assert done.type == 'done'
    assert done.items == final_content  # opaque, verbatim (signature intact)

    assert adapter.history == [
        {'role': 'user', 'content': 'q'},
        {'role': 'assistant', 'content': final_content},
    ]
    assert client.messages.seen['thinking'] == {'type': 'adaptive', 'display': 'summarized'}
    assert client.messages.seen['messages'] == [{'role': 'user', 'content': 'q'}]


def test_thinking_omitted_when_none():
    client = _Client(_Stream([_Ev('content_block_delta', _Delta('text_delta', text='hi'))], _Final([])))
    adapter = AnthropicAdapter(client, model='claude-3-haiku')
    list(adapter.stream('q'))
    assert 'thinking' not in client.messages.seen
