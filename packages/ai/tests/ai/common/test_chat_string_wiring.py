# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Integration: chat_string streams the LangChain path through the normalized adapter."""

from ai.common.chat import ChatBase


class _Piece:
    def __init__(self, content, response_metadata=None):
        self.content = content
        self.response_metadata = response_metadata


class _FakeLLM:
    def __init__(self, pieces):
        self._pieces = pieces
        self.kwargs = None

    def stream(self, messages, **kwargs):
        self.kwargs = kwargs
        yield from self._pieces


class _Chat(ChatBase):
    # Bypass the config-driven __init__; wire only what chat_string reads.
    def __init__(self, llm):
        self._llm = llm
        self._model = 'test-model'
        self._modelTotalTokens = 100000
        self._modelOutputTokens = 4096
        self._is_reasoning = False
        self._raw_client = None
        self._native_stream_provider = ''
        self._raw_openai_client = None

    def getTokens(self, value):
        return len(value)

    def _ensure_openai_compat_reasoning_stream(self):
        pass


def test_streams_text_and_reasoning_via_adapter():
    llm = _FakeLLM(
        [
            _Piece([{'type': 'thinking', 'thinking': 'cot'}, {'type': 'text', 'text': 'the answer'}]),
        ]
    )
    chat = _Chat(llm)
    chunks, thinks, finishes = [], [], []

    result = chat.chat_string('hi', on_chunk=chunks.append, on_finish=finishes.append, on_reasoning_chunk=thinks.append)

    assert result == 'the answer'
    assert ''.join(chunks) == 'the answer'
    assert ''.join(thinks) == 'cot'


def test_stop_sequences_reach_the_model():
    from ai.common.llm_native_stream import STOP_SEQUENCES_VAR

    llm = _FakeLLM([_Piece('plain answer here')])
    chat = _Chat(llm)
    token = STOP_SEQUENCES_VAR.set(['\nObservation:'])
    try:
        chat.chat_string('hi', on_chunk=lambda t: None)
    finally:
        STOP_SEQUENCES_VAR.reset(token)
    assert llm.kwargs == {'stop': ['\nObservation:']}


def test_chat_nonstreaming_drains_adapter():
    # The unify: _chat (no display callbacks) drains the same adapter and returns text.
    llm = _FakeLLM([_Piece([{'type': 'thinking', 'thinking': 'x'}, {'type': 'text', 'text': 'plain answer'}])])
    chat = _Chat(llm)
    assert chat._chat('q') == 'plain answer'
