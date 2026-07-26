# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Pins LangChainAdapter: normalizes LangChain content to Events and records history."""

from ai.common.llm_adapter import Event, LangChainAdapter


class _Piece:
    def __init__(self, content, response_metadata=None):
        self.content = content
        self.response_metadata = response_metadata


class _FakeLLM:
    def __init__(self, pieces):
        self._pieces = pieces
        self.seen = None
        self.kwargs = None

    def stream(self, messages, **kwargs):
        self.seen = list(messages)
        self.kwargs = kwargs
        for p in self._pieces:
            yield p if isinstance(p, _Piece) else _Piece(p)


def test_normalizes_blocks_and_records_history():
    llm = _FakeLLM([[{'type': 'thinking', 'thinking': 'r'}, {'type': 'text', 'text': 'Hi there'}]])
    adapter = LangChainAdapter(llm)

    events = list(adapter.stream('q'))

    assert Event('thinking', 'r') in events
    assert ''.join(e.text for e in events if e.type == 'text') == 'Hi there'

    done = events[-1]
    assert done.type == 'done'
    assert done.items == [{'role': 'assistant', 'content': 'Hi there'}]

    # history: user turn seen by the model, assistant turn appended after
    assert llm.seen == [{'role': 'user', 'content': 'q'}]
    assert adapter.history == [
        {'role': 'user', 'content': 'q'},
        {'role': 'assistant', 'content': 'Hi there'},
    ]


def test_str_content_flushes_buffered_tail():
    # str content rides the think-splitter, which buffers a possible partial tag.
    llm = _FakeLLM(['hello world'])
    adapter = LangChainAdapter(llm)
    text = ''.join(e.text for e in adapter.stream('q') if e.type == 'text')
    assert text == 'hello world'


def test_passes_stream_kwargs_and_tracks_finish_reason():
    llm = _FakeLLM([_Piece([{'type': 'text', 'text': 'done'}], response_metadata={'finish_reason': 'stop'})])
    adapter = LangChainAdapter(llm, stream_kwargs={'stop': ['\nObservation:']})
    list(adapter.stream('q'))
    assert llm.kwargs == {'stop': ['\nObservation:']}
    assert adapter.finish_reason == 'stop'
