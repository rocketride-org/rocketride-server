# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Pins NativeOpenAIResponsesAdapter: Responses stream → Events + finish mapping."""

from ai.common.llm_adapter import Event, NativeOpenAIResponsesAdapter
from ai.web.metrics.metrics import metrics


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


def test_failed_response_sets_error_finish():
    adapter = NativeOpenAIResponsesAdapter(_Chat([_Ev('response.failed')]))
    list(adapter.stream('q'))
    assert adapter.finish_reason == 'error'


def test_passes_store_false():
    chat = _Chat([_Ev('response.output_text.delta', delta='x')])
    list(NativeOpenAIResponsesAdapter(chat).stream('q'))
    assert chat._raw_client.responses.seen['store'] is False


class _ClosableStream:
    """Iterator that records close() and can raise mid-iteration."""

    def __init__(self, events, raise_at=None):
        self._events = list(events)
        self._i = 0
        self._raise_at = raise_at
        self.closed = False

    def __iter__(self):
        return self

    def __next__(self):
        if self._raise_at is not None and self._i == self._raise_at:
            raise RuntimeError('boom')
        if self._i >= len(self._events):
            raise StopIteration
        ev = self._events[self._i]
        self._i += 1
        return ev

    def close(self):
        self.closed = True


class _ChatStream:
    def __init__(self, stream):
        responses = type('R', (), {'create': lambda _self, **kw: stream})()
        self._raw_client = type('C', (), {'responses': responses})()
        self._model = 'gpt-5.6'
        self._modelOutputTokens = 4096


def test_closes_stream_on_exception():
    stream = _ClosableStream([_Ev('response.output_text.delta', delta='x')], raise_at=1)
    try:
        list(NativeOpenAIResponsesAdapter(_ChatStream(stream)).stream('q'))
    except RuntimeError:
        pass
    assert stream.closed is True


def test_closes_stream_on_early_break():
    stream = _ClosableStream([_Ev('response.output_text.delta', delta=str(i)) for i in range(5)])
    gen = NativeOpenAIResponsesAdapter(_ChatStream(stream)).stream('q')
    next(gen)  # consume one event, then abandon
    gen.close()  # GeneratorExit → finally closes the stream
    assert stream.closed is True


def test_reports_usage_on_failed_terminal_event():
    """A response.failed event that carries usage must still record tokens."""
    metrics.reset()

    class _Cached:
        cached_tokens = 4

    class _Usage:
        input_tokens = 30
        output_tokens = 7
        input_tokens_details = _Cached()

    class _FailedResp:
        usage = _Usage()

    events = [
        _Ev('response.output_text.delta', delta='partial'),
        _Ev('response.failed', response=_FailedResp()),
    ]
    adapter = NativeOpenAIResponsesAdapter(_Chat(events))
    out = list(adapter.stream('q'))

    assert adapter.finish_reason == 'error'
    assert out[-1].type == 'done'
    counters = metrics.report()['counters']
    # input 30 includes 4 cached -> fresh 26 + cache_read 4
    assert counters.get('llm_input_tokens') == 26
    assert counters.get('llm_cache_read_tokens') == 4
    assert counters.get('llm_output_tokens') == 7


def test_reports_usage_on_incomplete_terminal_event():
    """response.incomplete is a distinct terminal event: map its reason and record usage."""
    metrics.reset()

    class _Cached:
        cached_tokens = 2

    class _Usage:
        input_tokens = 20
        output_tokens = 100
        input_tokens_details = _Cached()

    class _IncompleteResp:
        usage = _Usage()
        incomplete_details = _Details('max_output_tokens')

    events = [
        _Ev('response.output_text.delta', delta='partial'),
        _Ev('response.incomplete', response=_IncompleteResp()),
    ]
    adapter = NativeOpenAIResponsesAdapter(_Chat(events))
    out = list(adapter.stream('q'))

    assert adapter.finish_reason == 'max_output_tokens'
    assert out[-1].type == 'done'
    counters = metrics.report()['counters']
    # input 20 includes 2 cached -> fresh 18 + cache_read 2
    assert counters.get('llm_input_tokens') == 18
    assert counters.get('llm_cache_read_tokens') == 2
    assert counters.get('llm_output_tokens') == 100
