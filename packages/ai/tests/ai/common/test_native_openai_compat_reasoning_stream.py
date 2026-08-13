# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Pins try_openai_compat_reasoning_stream: the OpenAI-compatible reasoning capture point.

Covers the three behaviours this handler adds and that no other test reached: the
``stream_options.include_usage`` injection, reading ``usage`` off the final chunk BEFORE
the empty-``choices`` guard skips it, and the ``prompt_tokens - cached_tokens`` split
(Chat Completions names it ``prompt_tokens_details.cached_tokens``, not the Responses
field). Plus the retry-without-the-flag path for an endpoint that 400s on it.
"""

from ai.common.llm_native_stream import try_openai_compat_reasoning_stream
from ai.web.metrics.metrics import metrics


def setup_function(_):
    metrics.reset()


def _counters():
    return metrics.report()['counters']


class _Delta:
    def __init__(self, content=None, reasoning_content=None):
        self.content = content
        self.reasoning_content = reasoning_content


class _Choice:
    def __init__(self, content=None, reasoning_content=None, finish_reason=None):
        self.delta = _Delta(content, reasoning_content)
        self.finish_reason = finish_reason


class _Chunk:
    def __init__(self, choices=(), usage=None):
        self.choices = list(choices)
        self.usage = usage


class _PromptDetails:
    def __init__(self, cached_tokens):
        self.cached_tokens = cached_tokens


class _Usage:
    def __init__(self, prompt_tokens, completion_tokens, cached=0):
        self.prompt_tokens = prompt_tokens
        self.completion_tokens = completion_tokens
        self.prompt_tokens_details = _PromptDetails(cached) if cached else None


class _Completions:
    """Fake ``client.chat.completions``. Records each create() call's kwargs; optionally
    raises when asked with ``stream_options`` and serves a different chunk set on retry.
    """

    def __init__(self, chunks, *, raise_on_stream_options=False, retry_chunks=None):
        self._chunks = chunks
        self._raise_on_stream_options = raise_on_stream_options
        self._retry_chunks = retry_chunks
        self.calls: list = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        if self._raise_on_stream_options and 'stream_options' in kwargs:
            raise RuntimeError('400 stream_options.include_usage unsupported')
        chunks = self._chunks if 'stream_options' in kwargs else (self._retry_chunks or self._chunks)
        return iter(chunks)


class _ChatNS:
    def __init__(self, completions):
        self.completions = completions


class _Client:
    def __init__(self, completions):
        self.chat = _ChatNS(completions)


class _Chat:
    def __init__(self, completions):
        self._raw_openai_client = _Client(completions)
        self._model = 'deepseek-reasoner'
        self._modelOutputTokens = 4096


def _run(chat):
    text_out: list = []
    reasoning_out: list = []
    finish: list = []
    result = try_openai_compat_reasoning_stream(
        chat,
        'q',
        on_chunk=text_out.append,
        on_finish=finish.append,
        on_reasoning_chunk=reasoning_out.append,
    )
    return result, ''.join(text_out), ''.join(reasoning_out), finish


def test_streams_content_and_reasoning_and_asks_for_usage():
    comp = _Completions(
        [
            _Chunk([_Choice(reasoning_content='thinking')]),
            _Chunk([_Choice(content='Hello')]),
            _Chunk([_Choice(content=' world', finish_reason='stop')]),
            # Final usage-only chunk: choices is empty, so usage must be read before the guard.
            _Chunk(choices=[], usage=_Usage(prompt_tokens=90, completion_tokens=20, cached=30)),
        ]
    )
    result, text, reasoning, finish = _run(_Chat(comp))

    assert result == 'Hello world'
    assert text == 'Hello world'
    assert reasoning == 'thinking'
    assert finish == ['stop']
    # The usage flag was injected.
    assert comp.calls[0]['stream_options'] == {'include_usage': True}
    # And the prompt/cache split lands on the right counters (Chat Completions naming).
    c = _counters()
    assert c['llm_input_tokens'] == 60  # 90 prompt - 30 cached
    assert c['llm_output_tokens'] == 20
    assert c['llm_cache_read_tokens'] == 30


def test_a_stream_without_usage_reports_nothing():
    comp = _Completions(
        [
            _Chunk([_Choice(content='hi', finish_reason='stop')]),
        ]
    )
    result, text, _, _ = _run(_Chat(comp))

    assert result == 'hi'
    # No usage chunk -> the `if usage is not None` skip fires, nothing billed.
    assert _counters() == {}


def test_retries_without_stream_options_when_the_endpoint_rejects_it():
    comp = _Completions(
        [],  # never served: the flagged call raises
        raise_on_stream_options=True,
        retry_chunks=[_Chunk([_Choice(content='hi', finish_reason='stop')])],
    )
    result, text, _, finish = _run(_Chat(comp))

    # The stream survived on the retry.
    assert result == 'hi'
    assert text == 'hi'
    assert finish == ['stop']
    # First call carried the flag, retry dropped it.
    assert 'stream_options' in comp.calls[0]
    assert 'stream_options' not in comp.calls[1]
    # No usage without the flag: that endpoint goes unmetered.
    assert _counters() == {}
