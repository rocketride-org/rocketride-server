# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Pins OpenAIAdapter: Responses deltas → Events, opaque output items in done.items."""

from ai.common.llm_adapter import Event, OpenAIAdapter


class _Ev:
    def __init__(self, type, delta=''):
        self.type = type
        self.delta = delta


class _Item:
    def __init__(self, dump):
        self._dump = dump

    def model_dump(self):
        return self._dump


class _Final:
    def __init__(self, output):
        self.output = output


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

    def get_final_response(self):
        return self._final


class _Responses:
    def __init__(self, stream):
        self._stream = stream
        self.seen = None

    def stream(self, **kwargs):
        self.seen = {**kwargs, 'input': list(kwargs['input'])}
        return self._stream


class _Client:
    def __init__(self, stream):
        self.responses = _Responses(stream)


def test_deltas_to_events_and_opaque_output_items():
    events = [
        _Ev('response.reasoning_summary_text.delta', 'think'),
        _Ev('response.output_text.delta', 'ans'),
    ]
    output = [
        _Item({'type': 'reasoning', 'encrypted_content': 'enc'}),
        _Item({'type': 'message', 'content': 'ans'}),
    ]
    client = _Client(_Stream(events, _Final(output)))
    adapter = OpenAIAdapter(client, model='gpt-5.6')

    out = list(adapter.stream('q'))

    assert Event('thinking', 'think') in out
    assert Event('text', 'ans') in out
    done = out[-1]
    assert done.type == 'done'
    assert done.items == [
        {'type': 'reasoning', 'encrypted_content': 'enc'},
        {'type': 'message', 'content': 'ans'},
    ]

    # history: user turn, then output items extended verbatim
    assert adapter.history == [
        {'role': 'user', 'content': 'q'},
        {'type': 'reasoning', 'encrypted_content': 'enc'},
        {'type': 'message', 'content': 'ans'},
    ]
    assert client.responses.seen['store'] is False
    assert client.responses.seen['input'] == [{'role': 'user', 'content': 'q'}]
