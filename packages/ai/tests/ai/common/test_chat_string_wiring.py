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
        self.bound = None

    def bind(self, **kwargs):
        # The call's values (model, max_tokens); the request kwargs stay in self.kwargs
        self.bound = kwargs
        return self

    def stream(self, messages, **kwargs):
        self.kwargs = kwargs
        yield from self._pieces

    def invoke(self, messages, **kwargs):
        self.kwargs = kwargs
        return self._pieces[0]


class _Chat(ChatBase):
    # A chat whose model is config (a plain dict: no param flags), so its one
    # call shape is resolved at construction; wire only what chat_string reads.
    def __init__(self, llm):
        super().__init__('test', {'model': 'test-model', 'modelTotalTokens': 100000, 'modelOutputTokens': 4096}, {})
        self._llm = llm
        self._raw_client = None

    def getTokens(self, value):
        return len(value)


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
    # The call's model and output window ride on the binding, not on the object
    assert llm.bound == {'model': 'test-model', 'max_tokens': 4096}


def test_chat_nonstreaming_invokes_via_adapter():
    # _chat drains via collect() → invoke() (a different mechanism than stream(), so the
    # streaming fallback can recover); content is normalized (thinking dropped) and stop passes.
    from ai.common.llm_native_stream import STOP_SEQUENCES_VAR

    llm = _FakeLLM([_Piece([{'type': 'thinking', 'thinking': 'x'}, {'type': 'text', 'text': 'plain answer'}])])
    chat = _Chat(llm)
    token = STOP_SEQUENCES_VAR.set(['\nObservation:'])
    try:
        assert chat._chat('q') == 'plain answer'
    finally:
        STOP_SEQUENCES_VAR.reset(token)
    assert llm.kwargs == {'stop': ['\nObservation:']}


def test_responses_no_text_falls_back_to_invoke():
    # response.failed with no text → the no-text guard raises → non-streaming invoke fallback.
    class _FailEvent:
        type = 'response.failed'

    class _Responses:
        def create(self, **kwargs):
            return iter([_FailEvent()])

    class _RawClient:
        responses = _Responses()

    chat = _Chat(_FakeLLM([_Piece('fallback answer')]))
    chat._raw_client = _RawClient()
    result = chat._chat_string_responses('q', on_chunk=lambda t: None, emitted={'any': False})
    assert result == 'fallback answer'


def _out_of_budget_chat():
    """A chat whose Responses stream ends at max_output_tokens with no text, and whose fallback answers."""

    class _Details:
        reason = 'max_output_tokens'

    class _Response:
        status = 'incomplete'
        incomplete_details = _Details()
        usage = None

    class _IncompleteEvent:
        type = 'response.incomplete'
        response = _Response()

    class _Responses:
        def create(self, **kwargs):
            return iter([_IncompleteEvent()])

    class _RawClient:
        responses = _Responses()

    llm = _FakeLLM([_Piece('fallback answer')])
    chat = _Chat(llm)
    chat._raw_client = _RawClient()
    return chat, llm


def test_responses_out_of_budget_json_call_does_not_pay_for_a_second_call():
    """For a JSON call, a reply cut off by max_output_tokens before any text gets no non-streaming retry.

    The fallback exists for a failed stream. Here the stream worked and the model ran out of
    budget; resending the same request with the same budget gets the same nothing, so
    ChatBase.chat gets '' and names the cause.
    """
    from ai.common.chat import _EXPECT_JSON_VAR

    chat, llm = _out_of_budget_chat()
    finishes = []
    token = _EXPECT_JSON_VAR.set(True)
    try:
        result = chat._chat_string_responses('q', on_finish=finishes.append, emitted={'any': False})
    finally:
        _EXPECT_JSON_VAR.reset(token)

    assert result == ''
    assert llm.kwargs is None, 'the fallback invoke ran'
    assert finishes == ['max_output_tokens']


def test_responses_out_of_budget_plain_call_keeps_the_fallback():
    """A plain-text call is unchanged: it still gets the fallback's answer."""
    chat, _ = _out_of_budget_chat()

    assert chat._chat_string_responses('q', emitted={'any': False}) == 'fallback answer'


def test_chat_marks_only_json_calls():
    """chat() publishes expectJson to the model path for exactly the duration of its calls."""
    from ai.common.chat import _EXPECT_JSON_VAR
    from ai.common.schema import Question

    seen = []

    class _Recording(_Chat):
        def chat_string(self, prompt, **kwargs):
            seen.append(_EXPECT_JSON_VAR.get())
            return '{"a": 1}'

    json_q, text_q = Question(expectJson=True), Question()
    json_q.addQuestion('x')
    text_q.addQuestion('x')
    chat = _Recording(_FakeLLM([_Piece('')]))
    chat.chat(json_q)
    chat.chat(text_q)

    assert seen == [True, False]
    assert _EXPECT_JSON_VAR.get() is False
