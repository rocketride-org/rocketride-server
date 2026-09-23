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

    def invoke(self, messages, **kwargs):
        # Recorded verbatim: collect() hands a str on a single turn, a message list after.
        self.seen = messages if isinstance(messages, str) else list(messages)
        self.kwargs = kwargs
        p = self._pieces[0]
        return p if isinstance(p, _Piece) else _Piece(p)


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


def test_collect_uses_invoke_and_normalizes():
    # collect() is the non-streaming drain: invoke() + shared normalization, thinking dropped.
    llm = _FakeLLM([[{'type': 'thinking', 'thinking': 'r'}, {'type': 'text', 'text': 'answer'}]])
    adapter = LangChainAdapter(llm, stream_kwargs={'stop': ['x']})

    text, items = adapter.collect('q')

    assert text == 'answer'
    assert items == [{'role': 'assistant', 'content': 'answer'}]
    assert llm.seen == 'q'  # single turn: the backend gets the prompt string, as before
    assert llm.kwargs == {'stop': ['x']}  # stop kwargs threaded to invoke
    assert adapter.history == [
        {'role': 'user', 'content': 'q'},
        {'role': 'assistant', 'content': 'answer'},
    ]


def test_collect_sends_the_history_once_the_turn_is_not_the_first():
    # Multi-turn: the prior turns are the point, so invoke() gets the message list.
    llm = _FakeLLM([[{'type': 'text', 'text': 'second'}]])
    adapter = LangChainAdapter(llm, history=[{'role': 'assistant', 'content': 'first'}])

    text, _items = adapter.collect('q2')

    assert text == 'second'
    assert llm.seen == [
        {'role': 'assistant', 'content': 'first'},
        {'role': 'user', 'content': 'q2'},  # the current turn is included
    ]
