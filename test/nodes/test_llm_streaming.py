# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""
Tests for LLM token streaming support.

Covers StreamingHandler, streaming_config helpers, SSE event emission,
provider-specific chunk extraction, error fallback, and edge cases.
"""

import importlib.util
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

# ---------------------------------------------------------------------------
# Direct module loading — bypass the heavy ``nodes`` and ``rocketlib``
# package __init__.py chains that require the C++ engine runtime.
#
# ``streaming_config.py`` has zero engine dependencies.
# ``streaming.py`` uses a relative import from ``streaming_config`` and a
#   lazy ``from ai.common.schema import Answer`` inside ``stream_response``.
#   The lazy import is patched in tests that exercise that path.
# ---------------------------------------------------------------------------

_REPO = Path(__file__).resolve().parent.parent.parent
_LLM_BASE = _REPO / 'nodes' / 'src' / 'nodes' / 'llm_base'


def _load_module(name: str, path: Path):
    """Load a single .py file as a top-level module, skipping package init chains."""
    spec = importlib.util.spec_from_file_location(name, str(path))
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


# 1) streaming_config — no dependencies at all
streaming_config = _load_module(
    'nodes.llm_base.streaming_config',
    _LLM_BASE / 'streaming_config.py',
)

STREAMING_CAPABLE_PROVIDERS = streaming_config.STREAMING_CAPABLE_PROVIDERS
get_provider_name = streaming_config.get_provider_name
is_provider_streaming_capable = streaming_config.is_provider_streaming_capable
is_streaming_enabled = streaming_config.is_streaming_enabled

# 2) streaming — has ``from .streaming_config import ...``.
#    Since we already registered ``nodes.llm_base.streaming_config`` in
#    sys.modules the relative import resolves correctly *only if* we also
#    register a minimal ``nodes.llm_base`` package entry.
_pkg = type(sys)('nodes.llm_base')
_pkg.__path__ = [str(_LLM_BASE)]
_pkg.__package__ = 'nodes.llm_base'
sys.modules.setdefault('nodes', type(sys)('nodes'))
sys.modules['nodes.llm_base'] = _pkg

streaming_mod = _load_module(
    'nodes.llm_base.streaming',
    _LLM_BASE / 'streaming.py',
)

StreamingHandler = streaming_mod.StreamingHandler


# ===========================================================================
# Helpers
# ===========================================================================


def _make_instance(send_sse=None):
    """Return a minimal instance-like object whose ``instance.sendSSE`` is mockable."""
    mock_sse = send_sse or MagicMock()
    inst = SimpleNamespace(
        instance=SimpleNamespace(sendSSE=mock_sse),
    )
    return inst, mock_sse


def _make_question(prompt='Hello', expect_json=False):
    return SimpleNamespace(getPrompt=lambda: prompt, expectJson=expect_json)


# ===========================================================================
# streaming_config tests
# ===========================================================================


class TestStreamingConfig:
    """Tests for ``streaming_config`` module."""

    # -- STREAMING_CAPABLE_PROVIDERS --

    def test_known_providers_present(self):
        """All documented providers are in the capability set."""
        expected = {'openai', 'anthropic', 'gemini', 'mistral', 'deepseek', 'xai', 'perplexity', 'ollama'}
        assert expected == STREAMING_CAPABLE_PROVIDERS

    # -- is_streaming_enabled --

    def test_streaming_enabled_true_via_streaming_key(self):
        assert is_streaming_enabled({'streaming': True}) is True

    def test_streaming_enabled_true_via_stream_key(self):
        assert is_streaming_enabled({'stream': True}) is True

    def test_streaming_enabled_false_when_absent(self):
        assert is_streaming_enabled({}) is False

    def test_streaming_enabled_false_when_falsy(self):
        assert is_streaming_enabled({'streaming': False}) is False
        assert is_streaming_enabled({'stream': 0}) is False
        assert is_streaming_enabled({'stream': ''}) is False

    def test_streaming_enabled_non_dict(self):
        assert is_streaming_enabled(None) is False
        assert is_streaming_enabled('yes') is False
        assert is_streaming_enabled(42) is False

    # -- get_provider_name --

    def test_get_provider_simple(self):
        assert get_provider_name('llm_openai') == 'openai'

    def test_get_provider_dotted(self):
        assert get_provider_name('nodes.llm_anthropic.IInstance') == 'anthropic'

    def test_get_provider_none(self):
        assert get_provider_name(None) is None

    def test_get_provider_empty(self):
        assert get_provider_name('') is None

    def test_get_provider_no_llm_prefix(self):
        assert get_provider_name('embedding_openai') is None

    def test_get_provider_deep_dotted(self):
        assert get_provider_name('a.b.llm_gemini.c') == 'gemini'

    # -- is_provider_streaming_capable --

    def test_provider_capable_openai(self):
        assert is_provider_streaming_capable('openai') is True

    def test_provider_capable_case_insensitive(self):
        assert is_provider_streaming_capable('OpenAI') is True
        assert is_provider_streaming_capable('ANTHROPIC') is True

    def test_provider_not_capable(self):
        assert is_provider_streaming_capable('unknown_provider') is False

    def test_provider_empty(self):
        assert is_provider_streaming_capable('') is False

    def test_provider_none(self):
        assert is_provider_streaming_capable(None) is False


# ===========================================================================
# StreamingHandler initialisation
# ===========================================================================


class TestStreamingHandlerInit:
    """Tests for ``StreamingHandler.__init__``."""

    def test_explicit_provider(self):
        inst, _ = _make_instance()
        h = StreamingHandler(inst, provider='openai')
        assert h._provider == 'openai'

    def test_provider_from_logical_type(self):
        inst, _ = _make_instance()
        h = StreamingHandler(inst, logical_type='llm_anthropic')
        assert h._provider == 'anthropic'

    def test_provider_fallback_empty(self):
        inst, _ = _make_instance()
        h = StreamingHandler(inst)
        assert h._provider == ''

    def test_config_default_empty_dict(self):
        inst, _ = _make_instance()
        h = StreamingHandler(inst)
        assert h._config == {}


# ===========================================================================
# Chunk text extraction
# ===========================================================================


class TestExtractChunkText:
    """Tests for ``StreamingHandler._extract_chunk_text``."""

    def test_openai_chunk(self):
        """OpenAI-format: chunk.choices[0].delta.content."""
        delta = SimpleNamespace(content='Hello')
        choice = SimpleNamespace(delta=delta)
        chunk = SimpleNamespace(choices=[choice])
        assert StreamingHandler._extract_chunk_text(chunk, 'openai') == 'Hello'

    def test_openai_chunk_none_content(self):
        """When content is None (role-only delta) return empty string."""
        delta = SimpleNamespace(content=None)
        choice = SimpleNamespace(delta=delta)
        chunk = SimpleNamespace(choices=[choice])
        assert StreamingHandler._extract_chunk_text(chunk, 'openai') == ''

    def test_openai_empty_choices(self):
        chunk = SimpleNamespace(choices=[])
        assert StreamingHandler._extract_chunk_text(chunk, 'openai') == ''

    def test_anthropic_delta_text(self):
        """Anthropic ContentBlockDelta: chunk.delta.text."""
        chunk = SimpleNamespace(delta=SimpleNamespace(text='world'), text=None)
        assert StreamingHandler._extract_chunk_text(chunk, 'anthropic') == 'world'

    def test_anthropic_text_fallback(self):
        """Anthropic fallback: chunk.text when delta is absent."""
        chunk = SimpleNamespace(delta=None, text='fallback')
        assert StreamingHandler._extract_chunk_text(chunk, 'anthropic') == 'fallback'

    def test_anthropic_empty(self):
        chunk = SimpleNamespace(delta=SimpleNamespace(text=None), text=None)
        assert StreamingHandler._extract_chunk_text(chunk, 'anthropic') == ''

    def test_gemini_chunk(self):
        """Gemini: chunk.text."""
        chunk = SimpleNamespace(text='foo')
        assert StreamingHandler._extract_chunk_text(chunk, 'gemini') == 'foo'

    def test_gemini_none(self):
        chunk = SimpleNamespace(text=None)
        assert StreamingHandler._extract_chunk_text(chunk, 'gemini') == ''

    def test_deepseek_uses_openai_path(self):
        delta = SimpleNamespace(content='ds')
        choice = SimpleNamespace(delta=delta)
        chunk = SimpleNamespace(choices=[choice])
        assert StreamingHandler._extract_chunk_text(chunk, 'deepseek') == 'ds'

    def test_xai_uses_openai_path(self):
        delta = SimpleNamespace(content='xai')
        choice = SimpleNamespace(delta=delta)
        chunk = SimpleNamespace(choices=[choice])
        assert StreamingHandler._extract_chunk_text(chunk, 'xai') == 'xai'

    def test_perplexity_uses_openai_path(self):
        delta = SimpleNamespace(content='pp')
        choice = SimpleNamespace(delta=delta)
        chunk = SimpleNamespace(choices=[choice])
        assert StreamingHandler._extract_chunk_text(chunk, 'perplexity') == 'pp'

    def test_mistral_choices_path(self):
        """Mistral newer SDK: chunk.choices[0].delta.content."""
        delta = SimpleNamespace(content='mi')
        choice = SimpleNamespace(delta=delta)
        chunk = SimpleNamespace(choices=[choice], data=None)
        assert StreamingHandler._extract_chunk_text(chunk, 'mistral') == 'mi'

    def test_ollama_dict_chunk(self):
        chunk = {'message': {'content': 'ol'}}
        assert StreamingHandler._extract_chunk_text(chunk, 'ollama') == 'ol'

    def test_ollama_response_key(self):
        chunk = {'response': 'r'}
        assert StreamingHandler._extract_chunk_text(chunk, 'ollama') == 'r'

    def test_ollama_object_text(self):
        chunk = SimpleNamespace(text='obj')
        assert StreamingHandler._extract_chunk_text(chunk, 'ollama') == 'obj'

    def test_generic_fallback_text_attr(self):
        chunk = SimpleNamespace(text='generic')
        assert StreamingHandler._extract_chunk_text(chunk, 'unknown') == 'generic'

    def test_generic_fallback_str(self):
        assert StreamingHandler._extract_chunk_text('raw', 'unknown') == 'raw'

    def test_none_chunk(self):
        assert StreamingHandler._extract_chunk_text(None, 'openai') == ''

    def test_empty_provider(self):
        """Empty/None provider falls through to the generic path."""
        chunk = SimpleNamespace(text='t')
        assert StreamingHandler._extract_chunk_text(chunk, '') == 't'


# ===========================================================================
# SSE event emission
# ===========================================================================


class TestSSEEmission:
    """Tests for SSE helper methods."""

    def test_emit_stream_start(self):
        inst, mock_sse = _make_instance()
        h = StreamingHandler(inst, provider='openai')
        h._emit_stream_start()
        mock_sse.assert_called_once_with('stream_start', provider='openai')

    def test_emit_token(self):
        inst, mock_sse = _make_instance()
        h = StreamingHandler(inst, provider='openai')
        h._emit_token('hi')
        mock_sse.assert_called_once_with('token', text='hi')

    def test_emit_stream_end(self):
        inst, mock_sse = _make_instance()
        h = StreamingHandler(inst, provider='openai')
        h._emit_stream_end({'input_tokens': 10, 'output_tokens': 20})
        mock_sse.assert_called_once_with('stream_end', input_tokens=10, output_tokens=20)

    def test_sse_failure_swallowed(self):
        """SSE delivery errors must not propagate."""
        mock_sse = MagicMock(side_effect=RuntimeError('boom'))
        inst, _ = _make_instance(send_sse=mock_sse)
        h = StreamingHandler(inst, provider='openai')
        # Should not raise
        h._emit_token('safe')


# ===========================================================================
# Full streaming flow
# ===========================================================================


class TestStreamResponse:
    """Tests for ``StreamingHandler.stream_response``."""

    def _openai_chunks(self, texts):
        """Build a list of OpenAI-shaped chunk objects."""
        chunks = []
        for t in texts:
            delta = SimpleNamespace(content=t)
            choice = SimpleNamespace(delta=delta)
            chunks.append(SimpleNamespace(choices=[choice], usage=None, message=None))
        return chunks

    def test_full_streaming_flow(self):
        """Tokens are emitted via SSE and the full text is accumulated."""
        inst, mock_sse = _make_instance()
        h = StreamingHandler(inst, provider='openai')
        question = _make_question('test')

        chunks = self._openai_chunks(['Hello', ' ', 'world'])
        chat_fn = MagicMock(return_value=iter(chunks))

        with patch.dict('sys.modules', {'ai.common.schema': _fake_schema_module()}):
            answer = h.stream_response(chat_fn, question)

        chat_fn.assert_called_once_with('test', stream=True)
        assert answer.getText() == 'Hello world'

        # Verify SSE call sequence: stream_start, token*3, stream_end
        types = [c.args[0] for c in mock_sse.call_args_list]
        assert types[0] == 'stream_start'
        assert types[-1] == 'stream_end'
        assert types.count('token') == 3

    def test_empty_chunks_produce_empty_answer(self):
        inst, mock_sse = _make_instance()
        h = StreamingHandler(inst, provider='openai')
        question = _make_question('test')

        chat_fn = MagicMock(return_value=iter([]))

        with patch.dict('sys.modules', {'ai.common.schema': _fake_schema_module()}):
            answer = h.stream_response(chat_fn, question)

        assert answer.getText() == ''

    def test_none_content_chunks_skipped(self):
        """Chunks with None content should not emit tokens."""
        inst, mock_sse = _make_instance()
        h = StreamingHandler(inst, provider='openai')
        question = _make_question('test')

        # Mix of real and None-content chunks
        delta_ok = SimpleNamespace(content='ok')
        delta_none = SimpleNamespace(content=None)
        chunks = [
            SimpleNamespace(choices=[SimpleNamespace(delta=delta_none)], usage=None, message=None),
            SimpleNamespace(choices=[SimpleNamespace(delta=delta_ok)], usage=None, message=None),
        ]
        chat_fn = MagicMock(return_value=iter(chunks))

        with patch.dict('sys.modules', {'ai.common.schema': _fake_schema_module()}):
            answer = h.stream_response(chat_fn, question)

        assert answer.getText() == 'ok'
        token_calls = [c for c in mock_sse.call_args_list if c.args[0] == 'token']
        assert len(token_calls) == 1

    def test_fallback_on_non_capable_provider(self):
        """Non-streaming-capable provider triggers the fallback path."""
        inst, mock_sse = _make_instance()
        h = StreamingHandler(inst, provider='unknown_provider')
        question = _make_question('test')

        result_obj = SimpleNamespace(content='fallback_text')
        chat_fn = MagicMock(return_value=result_obj)

        with patch.dict('sys.modules', {'ai.common.schema': _fake_schema_module()}):
            answer = h.stream_response(chat_fn, question)

        assert answer.getText() == 'fallback_text'
        # stream kwarg should NOT be passed for non-capable providers
        chat_fn.assert_called_once_with('test')
        # No SSE events should be emitted
        mock_sse.assert_not_called()

    def test_fallback_on_streaming_error(self):
        """If streaming raises, fall back to non-streaming."""
        inst, mock_sse = _make_instance()
        h = StreamingHandler(inst, provider='openai')
        question = _make_question('test')

        # First call (streaming) raises; second call (fallback) succeeds
        result_obj = SimpleNamespace(content='recovered')
        chat_fn = MagicMock(side_effect=[RuntimeError('stream broke'), result_obj])

        with patch.dict('sys.modules', {'ai.common.schema': _fake_schema_module()}):
            answer = h.stream_response(chat_fn, question)

        assert answer.getText() == 'recovered'
        assert chat_fn.call_count == 2

    def test_expect_json_propagated(self):
        """The ``expectJson`` flag from the question is carried to the Answer."""
        inst, _ = _make_instance()
        h = StreamingHandler(inst, provider='openai')
        question = _make_question('test', expect_json=True)

        chunks = self._openai_chunks(['{"key": "val"}'])
        chat_fn = MagicMock(return_value=iter(chunks))

        with patch.dict('sys.modules', {'ai.common.schema': _fake_schema_module()}):
            answer = h.stream_response(chat_fn, question)

        assert answer.isJson() is True

    def test_kwargs_forwarded(self):
        """Extra kwargs are forwarded to chat_fn."""
        inst, _ = _make_instance()
        h = StreamingHandler(inst, provider='openai')
        question = _make_question('test')

        chat_fn = MagicMock(return_value=iter([]))

        with patch.dict('sys.modules', {'ai.common.schema': _fake_schema_module()}):
            h.stream_response(chat_fn, question, temperature=0.5)

        chat_fn.assert_called_once_with('test', stream=True, temperature=0.5)

    def test_question_without_getPrompt(self):
        """A plain string question should still work via str()."""
        inst, _ = _make_instance()
        h = StreamingHandler(inst, provider='openai')

        chat_fn = MagicMock(return_value=iter([]))

        with patch.dict('sys.modules', {'ai.common.schema': _fake_schema_module()}):
            h.stream_response(chat_fn, 'raw prompt')

        chat_fn.assert_called_once_with('raw prompt', stream=True)


# ===========================================================================
# Token counting from stream metadata
# ===========================================================================


class TestTokenCounting:
    """Tests for ``StreamingHandler._update_token_counts``."""

    def test_openai_usage(self):
        usage = SimpleNamespace(prompt_tokens=10, completion_tokens=20, input_tokens=None, output_tokens=None)
        chunk = SimpleNamespace(usage=usage, message=None)
        inp, out = StreamingHandler._update_token_counts(chunk, 0, 0)
        assert inp == 10
        assert out == 20

    def test_anthropic_usage(self):
        msg_usage = SimpleNamespace(input_tokens=5, output_tokens=15)
        msg = SimpleNamespace(usage=msg_usage)
        chunk = SimpleNamespace(usage=None, message=msg)
        inp, out = StreamingHandler._update_token_counts(chunk, 0, 0)
        assert inp == 5
        assert out == 15

    def test_no_usage_returns_unchanged(self):
        chunk = SimpleNamespace(usage=None, message=None)
        inp, out = StreamingHandler._update_token_counts(chunk, 3, 7)
        assert inp == 3
        assert out == 7

    def test_partial_usage(self):
        """Only output_tokens present."""
        usage = SimpleNamespace(prompt_tokens=None, completion_tokens=42, input_tokens=None, output_tokens=None)
        chunk = SimpleNamespace(usage=usage, message=None)
        inp, out = StreamingHandler._update_token_counts(chunk, 1, 0)
        assert inp == 1  # unchanged
        assert out == 42

    def test_exception_in_usage_swallowed(self):
        """Errors in usage extraction should be silently caught."""
        chunk = 'not an object'
        inp, out = StreamingHandler._update_token_counts(chunk, 5, 10)
        assert inp == 5
        assert out == 10


# ===========================================================================
# Stream interruption
# ===========================================================================


class TestStreamInterruption:
    """Tests for interrupted or partial streams."""

    def test_generator_raises_mid_stream(self):
        """If the generator raises mid-stream, fall back and recover."""
        inst, mock_sse = _make_instance()
        h = StreamingHandler(inst, provider='openai')
        question = _make_question('test')

        def _broken_gen(*a, **kw):
            delta = SimpleNamespace(content='partial')
            yield SimpleNamespace(choices=[SimpleNamespace(delta=delta)], usage=None, message=None)
            raise ConnectionError('lost')

        fallback_obj = SimpleNamespace(content='recovered after interrupt')
        chat_fn = MagicMock(side_effect=[_broken_gen(), fallback_obj])

        with patch.dict('sys.modules', {'ai.common.schema': _fake_schema_module()}):
            answer = h.stream_response(chat_fn, question)

        # Should have fallen back
        assert answer.getText() == 'recovered after interrupt'


# ===========================================================================
# Fake Answer class for test isolation
# ===========================================================================


def _fake_schema_module():
    """Build a minimal ``ai.common.schema`` replacement for tests.

    Returns a module-like namespace with an ``Answer`` class that
    mirrors the real Answer's ``setAnswer`` / ``getText`` / ``isJson``
    interface without needing Pydantic or the client SDK.
    """

    class FakeAnswer:
        def __init__(self, expectJson=False):
            self.expectJson = expectJson
            self.answer = None

        def setAnswer(self, value):
            if self.expectJson:
                import json

                if isinstance(value, (dict, list)):
                    self.answer = value
                elif isinstance(value, str):
                    try:
                        self.answer = json.loads(value)
                    except json.JSONDecodeError:
                        self.answer = value
                else:
                    self.answer = value
            else:
                self.answer = value

        def getText(self):
            if self.answer is None:
                return ''
            if isinstance(self.answer, (dict, list)):
                import json

                return json.dumps(self.answer)
            return str(self.answer)

        def isJson(self):
            return self.expectJson

    mod = type(sys)('ai.common.schema')
    mod.Answer = FakeAnswer
    return mod
