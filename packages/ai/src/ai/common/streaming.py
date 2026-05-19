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
LLM token streaming handler.

Provides ``StreamingHandler``, a utility that individual LLM nodes can
opt into for token-by-token output via the engine's SSE transport.

Usage from an LLM node's ``IInstance``::

    from ai.common.streaming import StreamingHandler

    handler = StreamingHandler(self, config)
    answer = handler.stream_response(chat_fn, question)

Activation contract (ADR 0003 — LLM Token Streaming)
----------------------------------------------------
``stream_response`` only enters the streaming path when **all** of the
following are true:

1. The node opts in — either ``config['streaming']`` / ``config['stream']``
   is truthy, **or** the caller passes ``streaming_enabled=True`` to the
   constructor.
2. The provider adapter is listed as streaming-capable in
   :mod:`streaming_config`.
3. The wrapped engine instance exposes a callable ``sendSSE`` transport.

When any gate fails the handler silently falls back to a normal
non-streaming call and still returns a complete ``Answer``.  Missing SSE
transports are not an error so pipelines remain runnable from CLI,
tests, and other non-interactive clients.

The handler is intentionally **not** wired into ``IInstanceGenericLLM``
so that adoption is incremental and per-provider.
"""

from __future__ import annotations

import logging
from typing import Any, Callable, Dict, Optional, Protocol

from .streaming_config import (
    get_provider_name,
    is_provider_streaming_capable,
    is_streaming_enabled,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Lightweight protocol so we don't import heavy engine types at module level
# ---------------------------------------------------------------------------


class _InstanceLike(Protocol):
    """Minimal interface expected from the ``IInstance`` reference.

    Only ``instance.sendSSE`` is required.  This keeps the module
    importable in test environments that don't have ``engLib``.
    """

    class _Instance(Protocol):
        def sendSSE(self, event_type: str, **data) -> None: ...

    instance: _Instance


class _AnswerLike(Protocol):
    """Minimal interface for the Answer object we construct."""

    def setAnswer(self, value: Any) -> None: ...


# ---------------------------------------------------------------------------
# StreamingHandler
# ---------------------------------------------------------------------------


class StreamingHandler:
    """Emit LLM response tokens as SSE events while accumulating the full answer.

    Parameters
    ----------
    instance:
        The ``IInstance`` (or any object whose ``.instance.sendSSE``
        method matches the engine's SSE interface).
    config:
        Node configuration dict.  Used to resolve the provider name for
        chunk-text extraction and to check streaming eligibility.
    provider:
        Explicit provider override.  When ``None`` the provider is
        inferred from ``config`` / ``logical_type``.
    logical_type:
        The engine logical type (e.g. ``'llm_openai'``).  Used as a
        fallback to derive the provider name.
    """

    def __init__(
        self,
        instance: Any,
        config: Optional[Dict[str, Any]] = None,
        *,
        provider: Optional[str] = None,
        logical_type: Optional[str] = None,
        streaming_enabled: Optional[bool] = None,
    ) -> None:
        """Initialise with an IInstance reference for SSE access.

        Parameters
        ----------
        streaming_enabled:
            Optional explicit override for the activation gate.  When
            ``True`` the handler treats streaming as opted-in even if the
            node config does not carry a ``streaming``/``stream`` flag;
            when ``False`` streaming is force-disabled regardless of
            config.  When ``None`` (default) the gate is driven purely
            by ``is_streaming_enabled(config)``.  This lets a provider
            node attach a listener programmatically without round-
            tripping through the YAML config.
        """
        self._instance = instance
        self._config = config or {}
        self._streaming_enabled_override = streaming_enabled

        # Resolve provider
        if provider:
            self._provider = provider.lower()
        elif logical_type:
            self._provider = (get_provider_name(logical_type) or '').lower()
        else:
            self._provider = ''

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def stream_response(
        self,
        chat_fn: Callable[..., Any],
        question: Any,
        **kwargs: Any,
    ) -> Any:
        """Call *chat_fn* with ``stream=True`` and relay tokens via SSE.

        If the provider does not support streaming, or if the streaming
        call raises, the method falls back to a regular (non-streaming)
        call transparently.

        Parameters
        ----------
        chat_fn:
            A callable that accepts at least a prompt string and an
            optional ``stream`` keyword.  For LangChain-style drivers
            this is typically ``self._llm.invoke`` / ``self._llm.stream``;
            for raw SDK drivers it is the SDK's chat/completions call.
        question:
            A ``Question`` object (or anything with a ``.getPrompt()``
            method).
        **kwargs:
            Extra keyword arguments forwarded to *chat_fn*.

        Returns
        -------
        Answer
            A fully-populated ``Answer`` object with the accumulated
            response text and ``expectJson`` matching the question.
        """
        # Late import to avoid import-time dependency on engine internals.
        # The test suite injects its own Answer mock, so the import only
        # needs to succeed at runtime inside the engine.
        from ai.common.schema import Answer  # type: ignore[import-untyped]

        prompt = question.getPrompt() if hasattr(question, 'getPrompt') else str(question)
        expect_json = getattr(question, 'expectJson', False)

        # Activation gate (ADR 0003). Streaming requires ALL of:
        #   1. Node config opts in via ``streaming``/``stream`` flag, OR an
        #      SSE listener is explicitly attached to the handler.
        #   2. Provider is streaming-capable.
        #   3. Engine instance exposes a callable ``sendSSE`` transport.
        # When any condition fails we fall back to a normal non-streaming
        # call.  This keeps existing nodes backward-compatible and lets
        # pipelines run unchanged from CLI / tests / non-interactive
        # clients that have no SSE consumer attached.
        if not self._streaming_opted_in():
            return self._fallback(chat_fn, prompt, expect_json, Answer, **kwargs)

        if not is_provider_streaming_capable(self._provider):
            return self._fallback(chat_fn, prompt, expect_json, Answer, **kwargs)

        if not self._has_sse_transport():
            return self._fallback(chat_fn, prompt, expect_json, Answer, **kwargs)

        try:
            self._emit_stream_start()

            accumulated_text = ''
            input_tokens: int = 0
            output_tokens: int = 0

            stream = chat_fn(prompt, stream=True, **kwargs)

            for chunk in stream:
                text = self._extract_chunk_text(chunk, self._provider)
                if text:
                    accumulated_text += text
                    # Fallback chunk count: incremented per chunk as a rough
                    # approximation until _update_token_counts overwrites it
                    # with real usage data from the provider SDK (if available).
                    output_tokens += 1
                    self._emit_token(text)

                # Try to pull token usage from stream metadata
                input_tokens, output_tokens = self._update_token_counts(
                    chunk,
                    input_tokens,
                    output_tokens,
                )

            total_tokens = {'input_tokens': input_tokens, 'output_tokens': output_tokens}
            self._emit_stream_end(total_tokens)

            answer = Answer(expectJson=expect_json)
            answer.setAnswer(accumulated_text)
            return answer

        except Exception as exc:
            logger.debug(
                'Streaming failed for provider=%s, falling back to non-streaming', self._provider, exc_info=True
            )
            try:
                result = self._fallback(chat_fn, prompt, expect_json, Answer, **kwargs)
            except Exception as fallback_exc:
                self._emit_stream_error(str(fallback_exc))
                raise fallback_exc from exc
            self._emit_stream_end({'input_tokens': 0, 'output_tokens': 0})
            return result

    # ------------------------------------------------------------------
    # Activation gate helpers
    # ------------------------------------------------------------------

    def _streaming_opted_in(self) -> bool:
        """Return ``True`` if the caller has explicitly opted into streaming.

        Per ADR 0003 (LLM Token Streaming Activation Contract), streaming
        is opt-in.  The explicit ``streaming_enabled`` constructor flag
        wins over the config dict so that provider nodes can attach a
        listener programmatically.  When the override is ``None`` we
        fall back to the config-driven check via
        :func:`is_streaming_enabled`.
        """
        if self._streaming_enabled_override is not None:
            return bool(self._streaming_enabled_override)
        return is_streaming_enabled(self._config)

    def _has_sse_transport(self) -> bool:
        """Return ``True`` if the wrapped instance exposes a callable SSE sink.

        The ADR requires a working SSE transport for streaming to start;
        when the transport is missing the handler must fall back to a
        non-streaming call so CLI / test / non-interactive runs continue
        to work.
        """
        inner = getattr(self._instance, 'instance', None)
        send = getattr(inner, 'sendSSE', None) if inner is not None else None
        return callable(send)

    # ------------------------------------------------------------------
    # Chunk text extraction
    # ------------------------------------------------------------------

    @staticmethod
    def _extract_chunk_text(chunk: Any, provider: str) -> str:
        """Extract the token text from a provider-specific chunk object.

        Each provider SDK returns chunks in a different shape.  This
        method tries the known attribute paths in order and falls back to
        ``str(chunk)`` for unknown providers.

        Args:
            chunk: The streaming chunk object from the provider SDK.
            provider: Bare provider name (e.g. ``'openai'``).

        Returns:
            The extracted text fragment, or an empty string when the
            chunk carries no textual content (e.g. role-only deltas).
        """
        try:
            p = provider.lower() if provider else ''

            # OpenAI / DeepSeek / XAI / Perplexity (OpenAI-compatible)
            if p in ('openai', 'deepseek', 'xai', 'perplexity'):
                choices = getattr(chunk, 'choices', [{}])
                if choices and len(choices) > 0:
                    choice = choices[0]
                    d = getattr(choice, 'delta', None)
                    if d is not None:
                        content = getattr(d, 'content', None)
                        return content or ''
                return ''

            # Anthropic
            if p == 'anthropic':
                # anthropic SDK: ContentBlockDelta has .delta.text
                delta = getattr(chunk, 'delta', None)
                if delta is not None:
                    text = getattr(delta, 'text', None)
                    return text or ''
                # Also handle RawContentBlockDelta / text attribute
                text = getattr(chunk, 'text', None)
                return text or ''

            # Gemini (google-genai)
            if p == 'gemini':
                text = getattr(chunk, 'text', None)
                return text or ''

            # Mistral
            if p == 'mistral':
                data = getattr(chunk, 'data', {})
                if hasattr(data, 'choices') and data.choices:
                    delta = getattr(data.choices[0], 'delta', None)
                    if delta:
                        return getattr(delta, 'content', '') or ''
                # Fallback: newer Mistral SDK shapes
                choices = getattr(chunk, 'choices', None)
                if choices and len(choices) > 0:
                    delta = getattr(choices[0], 'delta', None)
                    if delta:
                        return getattr(delta, 'content', '') or ''
                return ''

            # Ollama
            if p == 'ollama':
                # Ollama returns dict-like chunks
                if isinstance(chunk, dict):
                    return chunk.get('message', {}).get('content', '') or chunk.get('response', '')
                text = getattr(chunk, 'text', None) or getattr(chunk, 'content', None)
                return text or ''

            # Generic fallback
            text = getattr(chunk, 'text', None) or getattr(chunk, 'content', None)
            if text:
                return text
            return str(chunk) if chunk else ''

        except Exception:
            return ''

    # ------------------------------------------------------------------
    # SSE helpers
    # ------------------------------------------------------------------

    def _emit_token(self, text: str) -> None:
        """Send a single token SSE event."""
        self._send_sse('token', text=text)

    def _emit_stream_start(self) -> None:
        """Send an SSE event indicating that streaming has begun."""
        self._send_sse('stream_start', provider=self._provider)

    def _emit_stream_end(self, total_tokens: Dict[str, int]) -> None:
        """Send an SSE event with final token statistics."""
        self._send_sse('stream_end', **total_tokens)

    def _emit_stream_error(self, error: str) -> None:
        """Send an SSE event indicating a streaming error."""
        self._send_sse('stream_error', error=error)

    def _send_sse(self, event_type: str, **data: Any) -> None:
        """Dispatch an SSE event via the engine's ``sendSSE`` interface.

        Silently swallows errors so that SSE failures never break the
        main response flow.
        """
        try:
            self._instance.instance.sendSSE(event_type, **data)
        except Exception:
            # SSE delivery is best-effort; never let it break the
            # chat response path.
            logger.debug('SSE send failed for event=%s', event_type, exc_info=True)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _update_token_counts(
        chunk: Any,
        input_tokens: int,
        output_tokens: int,
    ) -> tuple[int, int]:
        """Try to extract token-usage metadata from a streaming chunk.

        Different SDKs embed usage data in different places.  This
        helper is best-effort: if nothing is found the counts are
        returned unchanged.
        """
        try:
            # OpenAI-style: chunk.usage.{prompt_tokens, completion_tokens}
            usage = getattr(chunk, 'usage', None)
            if usage is not None:
                pt = getattr(usage, 'prompt_tokens', None) or getattr(usage, 'input_tokens', None)
                ct = getattr(usage, 'completion_tokens', None) or getattr(usage, 'output_tokens', None)
                if pt is not None:
                    input_tokens = int(pt)
                if ct is not None:
                    output_tokens = int(ct)

            # Anthropic-style: chunk.message.usage
            msg = getattr(chunk, 'message', None)
            if msg is not None:
                msg_usage = getattr(msg, 'usage', None)
                if msg_usage is not None:
                    it = getattr(msg_usage, 'input_tokens', None)
                    ot = getattr(msg_usage, 'output_tokens', None)
                    if it is not None:
                        input_tokens = int(it)
                    if ot is not None:
                        output_tokens = int(ot)
        except Exception:
            pass

        return input_tokens, output_tokens

    def _fallback(
        self,
        chat_fn: Callable[..., Any],
        prompt: str,
        expect_json: bool,
        answer_cls: type,
        **kwargs: Any,
    ) -> Any:
        """Execute a non-streaming call as a fallback.

        Strips the ``stream`` kwarg (if present) before calling
        *chat_fn* so that providers that don't support it won't choke.
        """
        kwargs.pop('stream', None)
        result = chat_fn(prompt, **kwargs)

        # If the result is already an Answer, return it directly.
        if isinstance(result, answer_cls):
            return result

        # The result may be a raw string or a content-bearing object.
        content = result
        if hasattr(result, 'content'):
            content = result.content

        answer = answer_cls(expectJson=expect_json)
        answer.setAnswer(content)
        return answer
