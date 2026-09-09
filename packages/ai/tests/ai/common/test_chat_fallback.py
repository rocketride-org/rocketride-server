import pytest

from ai.common.llm_adapter import Event, LangChainAdapter, is_stop_rejection
from ai.common.llm_native_stream import (
    STOP_SEQUENCES_VAR,
    NativeAnthropicAdapter,
    try_openai_compat_reasoning_stream,
)


class _Piece:
    def __init__(self, content, response_metadata=None):
        self.content = content
        self.response_metadata = response_metadata


class _FakeApiError(Exception):
    """Minimal stand-in for openai.BadRequestError-shaped exceptions."""

    def __init__(self, message, *, status_code=None, code=None, param=None, body=None):
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.param = param
        self.body = body


class MockInvokeLLM:
    def __init__(self, should_fail_on_stop=True):
        self.should_fail_on_stop = should_fail_on_stop
        self.invoked_kwargs = []

    def invoke(self, prompt, **kwargs):
        self.invoked_kwargs.append(kwargs)
        if self.should_fail_on_stop and 'stop' in kwargs:
            raise ValueError("unsupported_parameter: 'stop'")
        return _Piece('success')

    def stream(self, messages, **kwargs):
        raise AssertionError('stream should not be used in collect tests')


class MockStreamLLM:
    def __init__(self, should_fail_on_stop=True):
        self.should_fail_on_stop = should_fail_on_stop
        self.streamed_kwargs = []

    def stream(self, messages, **kwargs):
        self.streamed_kwargs.append(kwargs)
        if self.should_fail_on_stop and 'stop' in kwargs:

            def failing_generator():
                raise ValueError("unsupported_parameter: 'stop' is invalid")
                yield _Piece('never')

            return failing_generator()

        def success_generator():
            yield _Piece('chunk1')
            yield _Piece('chunk2')

        return success_generator()


def test_is_stop_rejection_structured_nested_openai_body():
    """OpenAI nests code/param under body['error']; top-level .get misses them."""
    err = _FakeApiError(
        'ignored string',
        status_code=400,
        body={
            'error': {
                'message': "Unsupported parameter: 'stop' is not supported with this model.",
                'type': 'invalid_request_error',
                'param': 'stop',
                'code': 'unsupported_parameter',
            }
        },
    )
    assert is_stop_rejection(err, True) is True


def test_is_stop_rejection_structured_top_level_fields():
    err = _FakeApiError(
        'ignored',
        status_code=400,
        code='unsupported_parameter',
        param='stop',
    )
    assert is_stop_rejection(err, True) is True


def test_is_stop_rejection_string_heuristic_word_boundary():
    assert is_stop_rejection(ValueError("unsupported_parameter: 'stop'"), True) is True
    assert is_stop_rejection(ValueError('stop_sequences: Extra inputs are not permitted'), True) is True
    assert is_stop_rejection(ValueError('Invalid API key'), True) is False
    assert is_stop_rejection(ValueError('Request stopped by client'), True) is False
    assert is_stop_rejection(ValueError('invalid_request_error: unsupported model'), True) is False
    assert is_stop_rejection(ValueError('nonstop generation failed'), True) is False


def test_is_stop_rejection_anthropic_message_only_body():
    """Anthropic 400s often have no code/param — only a stop_sequences message."""
    err = _FakeApiError(
        'stop_sequences: Extra inputs are not permitted',
        status_code=400,
        body={
            'type': 'error',
            'error': {
                'type': 'invalid_request_error',
                'message': 'stop_sequences: Extra inputs are not permitted',
            },
        },
    )
    assert is_stop_rejection(err, True) is True


def test_is_stop_rejection_structured_nonmatch_skips_string_heuristic():
    """Present structured fields that are not a stop rejection must not retry."""
    rate_limited = _FakeApiError(
        'invalid stop: unsupported',
        status_code=429,
        body={'error': {'code': 'rate_limit_exceeded'}},
    )
    assert is_stop_rejection(rate_limited, True) is False

    wrong_param = _FakeApiError(
        "unsupported_parameter: 'stop'",
        status_code=400,
        param='messages',
    )
    assert is_stop_rejection(wrong_param, True) is False


def test_is_stop_rejection_requires_stop_sent():
    assert is_stop_rejection(ValueError("unsupported_parameter: 'stop'"), False) is False


def test_langchain_collect_retries_without_stop():
    llm = MockInvokeLLM(should_fail_on_stop=True)
    adapter = LangChainAdapter(llm, stream_kwargs={'stop': ['\nObservation:']})

    text, _items = adapter.collect('Hello')

    assert text == 'success'
    assert len(llm.invoked_kwargs) == 2
    assert 'stop' in llm.invoked_kwargs[0]
    assert 'stop' not in llm.invoked_kwargs[1]


def test_langchain_collect_retry_preserves_non_stop_kwargs():
    llm = MockInvokeLLM(should_fail_on_stop=True)
    adapter = LangChainAdapter(llm, stream_kwargs={'stop': ['\nObservation:'], 'temperature': 0.2})

    adapter.collect('Hello')

    assert llm.invoked_kwargs[0]['stop'] == ['\nObservation:']
    assert llm.invoked_kwargs[0]['temperature'] == 0.2
    assert 'stop' not in llm.invoked_kwargs[1]
    assert llm.invoked_kwargs[1] == {'temperature': 0.2}


def test_langchain_collect_success_with_stop():
    llm = MockInvokeLLM(should_fail_on_stop=False)
    adapter = LangChainAdapter(llm, stream_kwargs={'stop': ['\nObservation:']})

    text, _items = adapter.collect('Hello')

    assert text == 'success'
    assert len(llm.invoked_kwargs) == 1
    assert 'stop' in llm.invoked_kwargs[0]


def test_langchain_stream_retries_without_stop():
    llm = MockStreamLLM(should_fail_on_stop=True)
    adapter = LangChainAdapter(llm, stream_kwargs={'stop': ['\nObservation:']})

    text = ''.join(e.text for e in adapter.stream('Hello') if e.type == 'text')

    assert text == 'chunk1chunk2'
    assert len(llm.streamed_kwargs) == 2
    assert 'stop' in llm.streamed_kwargs[0]
    assert 'stop' not in llm.streamed_kwargs[1]


def test_langchain_stream_success_with_stop():
    llm = MockStreamLLM(should_fail_on_stop=False)
    adapter = LangChainAdapter(llm, stream_kwargs={'stop': ['\nObservation:']})

    events = list(adapter.stream('Hello'))

    assert Event('text', 'chunk1') in events
    assert Event('text', 'chunk2') in events
    assert len(llm.streamed_kwargs) == 1
    assert 'stop' in llm.streamed_kwargs[0]


def test_langchain_collect_empty_stop_does_not_retry():
    llm = MockInvokeLLM()

    def failing_invoke(prompt, **kwargs):
        llm.invoked_kwargs.append(kwargs)
        raise ValueError("unsupported_parameter: 'stop'")

    llm.invoke = failing_invoke
    adapter = LangChainAdapter(llm, stream_kwargs={})

    with pytest.raises(ValueError, match="unsupported_parameter: 'stop'"):
        adapter.collect('Hello')

    assert len(llm.invoked_kwargs) == 1


def test_langchain_collect_unrelated_error_does_not_retry():
    llm = MockInvokeLLM()

    def failing_invoke(prompt, **kwargs):
        llm.invoked_kwargs.append(kwargs)
        raise ValueError('Rate limit exceeded')

    llm.invoke = failing_invoke
    adapter = LangChainAdapter(llm, stream_kwargs={'stop': ['\nObservation:']})

    with pytest.raises(ValueError, match='Rate limit exceeded'):
        adapter.collect('Hello')

    assert len(llm.invoked_kwargs) == 1


def test_langchain_stream_empty_stop_does_not_retry():
    llm = MockStreamLLM()

    def failing_stream(messages, **kwargs):
        llm.streamed_kwargs.append(kwargs)

        def gen():
            raise ValueError("unsupported_parameter: 'stop'")
            yield _Piece('never')

        return gen()

    llm.stream = failing_stream
    adapter = LangChainAdapter(llm, stream_kwargs={})

    with pytest.raises(ValueError, match="unsupported_parameter: 'stop'"):
        list(adapter.stream('Hello'))

    assert len(llm.streamed_kwargs) == 1


def test_langchain_stream_unrelated_error_does_not_retry():
    llm = MockStreamLLM()

    def failing_stream(messages, **kwargs):
        llm.streamed_kwargs.append(kwargs)

        def gen():
            raise ValueError('Rate limit exceeded')
            yield _Piece('never')

        return gen()

    llm.stream = failing_stream
    adapter = LangChainAdapter(llm, stream_kwargs={'stop': ['\nObservation:']})

    with pytest.raises(ValueError, match='Rate limit exceeded'):
        list(adapter.stream('Hello'))

    assert len(llm.streamed_kwargs) == 1


def test_langchain_stream_mid_stream_error_does_not_retry():
    """Error after the first chunk must not restart the stream (no duplicate emit)."""
    llm = MockStreamLLM()

    def failing_stream(messages, **kwargs):
        llm.streamed_kwargs.append(kwargs)

        def gen():
            yield _Piece('chunk1')
            raise ValueError("unsupported_parameter: 'stop'")

        return gen()

    llm.stream = failing_stream
    adapter = LangChainAdapter(llm, stream_kwargs={'stop': ['\nObservation:']})

    with pytest.raises(ValueError, match="unsupported_parameter: 'stop'"):
        list(adapter.stream('Hello'))

    assert len(llm.streamed_kwargs) == 1


class _FakeCompletions:
    def __init__(self, create_fn):
        self.create = create_fn


class _FakeChat:
    def __init__(self, create_fn):
        self.completions = _FakeCompletions(create_fn)


class _FakeOpenAIClient:
    def __init__(self, create_fn):
        self.chat = _FakeChat(create_fn)


class _FakeDelta:
    def __init__(self, content=None, reasoning_content=None):
        self.content = content
        self.reasoning_content = reasoning_content


class _FakeChoice:
    def __init__(self, content, finish_reason=None):
        self.delta = _FakeDelta(content=content)
        self.finish_reason = finish_reason


class _FakeChunk:
    def __init__(self, content, finish_reason=None):
        self.choices = [_FakeChoice(content, finish_reason)]


def test_openai_compat_native_stream_retries_without_stop():
    calls = []

    def create(**kwargs):
        calls.append(dict(kwargs))
        if 'stop' in kwargs:
            raise _FakeApiError(
                "Unsupported parameter: 'stop'",
                status_code=400,
                body={'error': {'code': 'unsupported_parameter', 'param': 'stop'}},
            )
        return iter([_FakeChunk('hello', finish_reason='stop')])

    chat = type(
        'Chat',
        (),
        {
            '_raw_openai_client': _FakeOpenAIClient(create),
            '_model': 'deepseek-reasoner',
            '_modelOutputTokens': 128,
            '_reasoning_kwargs': {},
        },
    )()

    token = STOP_SEQUENCES_VAR.set(['\nObservation:'])
    try:
        chunks = []
        text = try_openai_compat_reasoning_stream(chat, 'prompt', chunks.append, None, None)
    finally:
        STOP_SEQUENCES_VAR.reset(token)

    assert text == 'hello'
    assert chunks == ['hello']
    assert len(calls) == 2
    assert calls[0].get('stop') == ['\nObservation:']
    assert 'stop' not in calls[1]


def test_openai_compat_native_stream_retries_on_message_only_body():
    """Third-party openai_compat 400s are often message-only, with no code/param."""
    calls = []

    def create(**kwargs):
        calls.append(dict(kwargs))
        if 'stop' in kwargs:
            raise _FakeApiError(
                "Unsupported parameter: 'stop' is not supported with this model.",
                status_code=400,
                body={'error': {'message': "Unsupported parameter: 'stop' is not supported with this model."}},
            )
        return iter([_FakeChunk('hello', finish_reason='stop')])

    chat = type(
        'Chat',
        (),
        {
            '_raw_openai_client': _FakeOpenAIClient(create),
            '_model': 'deepseek-reasoner',
            '_modelOutputTokens': 128,
            '_reasoning_kwargs': {},
        },
    )()

    token = STOP_SEQUENCES_VAR.set(['\nObservation:'])
    try:
        text = try_openai_compat_reasoning_stream(chat, 'prompt', lambda _: None, None, None)
    finally:
        STOP_SEQUENCES_VAR.reset(token)

    assert text == 'hello'
    assert len(calls) == 2
    assert 'stop' in calls[0]
    assert 'stop' not in calls[1]


def test_openai_compat_native_stream_unrelated_error_does_not_retry():
    calls = []

    def create(**kwargs):
        calls.append(dict(kwargs))
        raise ValueError('authentication failed')

    chat = type(
        'Chat',
        (),
        {
            '_raw_openai_client': _FakeOpenAIClient(create),
            '_model': 'deepseek-reasoner',
            '_modelOutputTokens': 128,
            '_reasoning_kwargs': {},
        },
    )()

    token = STOP_SEQUENCES_VAR.set(['\nObservation:'])
    try:
        text = try_openai_compat_reasoning_stream(chat, 'prompt', lambda _: None, None, None)
    finally:
        STOP_SEQUENCES_VAR.reset(token)

    assert text is None
    assert len(calls) == 1


def test_anthropic_native_stream_retries_without_stop(monkeypatch):
    """Retry native Anthropic create without stop_sequences on a real Anthropic 400.

    Production rejections are message-only (``stop_sequences: Extra inputs are
    not permitted``) with no ``code``/``param``. Fabricating OpenAI's structured
    fields would let this pass without exercising the string branch.
    """
    from ai.common import llm_native_stream as ns

    payloads = []
    open_calls = []

    class _FakeLLM:
        def _get_request_payload(self, prompt, stop=None, stream=False):
            payloads.append({'stop': stop, 'stream': stream})
            out = {'model': 'claude', 'messages': [], 'max_tokens': 16, 'stream': True}
            if stop:
                out['stop_sequences'] = stop
            return out

        def _client(self):
            return object()

    class _Evt:
        type = 'content_block_delta'

        class delta:
            type = 'text_delta'
            text = 'ok'

    def fake_open(client, payload):
        open_calls.append(dict(payload))
        if payload.get('stop_sequences'):
            raise _FakeApiError(
                'stop_sequences: Extra inputs are not permitted',
                status_code=400,
                body={
                    'type': 'error',
                    'error': {
                        'type': 'invalid_request_error',
                        'message': 'stop_sequences: Extra inputs are not permitted',
                    },
                },
            )
        return [_Evt()]

    monkeypatch.setattr(ns, '_open_raw_message_stream', fake_open)

    chat = type('Chat', (), {'_llm': _FakeLLM(), '_thinking_mode_kwargs': {}})()
    token = STOP_SEQUENCES_VAR.set(['\nObservation:'])
    try:
        events = list(NativeAnthropicAdapter(chat).stream('prompt'))
    finally:
        STOP_SEQUENCES_VAR.reset(token)

    assert Event('text', 'ok') in events
    assert len(payloads) == 2
    assert payloads[0]['stop'] == ['\nObservation:']
    assert payloads[1]['stop'] is None
    assert len(open_calls) == 2
    assert open_calls[0].get('stop_sequences') == ['\nObservation:']
    assert 'stop_sequences' not in open_calls[1]
