# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Pins NativeOpenAIResponsesAdapter: Responses stream → Events + finish mapping."""

from ai.common.llm_adapter import Event, NativeOpenAIResponsesAdapter


class _Ev:
    def __init__(self, type, delta='', response=None):
        self.type = type
        self.delta = delta
        self.response = response


class _Resp:
    def __init__(self, status, incomplete_details=None):
        self.status = status
        self.incomplete_details = incomplete_details


class _Details:
    def __init__(self, reason):
        self.reason = reason


class _Responses:
    def __init__(self, events):
        self._events = events
        self.seen = None

    def create(self, **kwargs):
        self.seen = kwargs
        return iter(self._events)


class _RawClient:
    def __init__(self, events):
        self.responses = _Responses(events)


class _Chat:
    def __init__(self, events):
        self._raw_client = _RawClient(events)
        self._model = 'gpt-5.6'
        self._modelOutputTokens = 4096


def test_yields_events_and_completed_maps_to_stop():
    events = [
        _Ev('response.reasoning_summary_text.delta', delta='think'),
        _Ev('response.output_text.delta', delta='ans'),
        _Ev('response.completed', response=_Resp('completed')),
    ]
    adapter = NativeOpenAIResponsesAdapter(_Chat(events))
    out = list(adapter.stream('q'))

    assert Event('thinking', 'think') in out
    assert Event('text', 'ans') in out
    assert out[-1].type == 'done'
    assert out[-1].items == [{'role': 'assistant', 'content': 'ans'}]
    assert adapter.finish_reason == 'stop'


def test_incomplete_maps_to_reason():
    events = [
        _Ev('response.output_text.delta', delta='x'),
        _Ev('response.completed', response=_Resp('incomplete', _Details('max_output_tokens'))),
    ]
    adapter = NativeOpenAIResponsesAdapter(_Chat(events))
    list(adapter.stream('q'))
    assert adapter.finish_reason == 'max_output_tokens'
