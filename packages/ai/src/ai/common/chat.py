"""
ChatBase - Abstract Base Class for AI Chat Drivers.

This module provides the foundation for all chat-based AI drivers in the system.
It handles token management, configuration loading, and provides a consistent
interface for interacting with different AI providers.

The ChatBase class is designed to be subclassed by specific AI provider
implementations (e.g., OpenAI, Anthropic, etc.) that handle the actual
communication with their respective APIs.
"""

import time
import json
import importlib
from typing import Dict, Any, Callable, Optional
from rocketlib import debug, warning
from ai.common.schema import Answer, Question
from ai.common.config import Config
from ai.common.util import parseJson
from ai.common.validation import validate_model_name, validate_max_tokens, validate_prompt
from ai.common.llm_native_stream import dispatch_native_chat_stream


def _make_think_tag_splitter():
    """Split ``<think>...</think>`` CoT out of the content stream (Ollama, Perplexity).

    Returns a ``feed(text) -> (visible, reasoning)`` closure; tags may span deltas.
    """
    OPEN, CLOSE = '<think>', '</think>'
    state = {'mode': 'visible', 'buf': ''}

    def feed(text: str):
        if not text:
            return '', ''
        buf = state['buf'] + text
        visible_parts: list = []
        reasoning_parts: list = []
        while buf:
            if state['mode'] == 'visible':
                idx = buf.find(OPEN)
                if idx < 0:
                    # Hold back trailing chars that could be a partial '<think>'.
                    safe = len(buf) - (len(OPEN) - 1)
                    if safe > 0:
                        visible_parts.append(buf[:safe])
                        buf = buf[safe:]
                    break
                if idx:
                    visible_parts.append(buf[:idx])
                buf = buf[idx + len(OPEN) :]
                state['mode'] = 'thinking'
            else:
                idx = buf.find(CLOSE)
                if idx < 0:
                    safe = len(buf) - (len(CLOSE) - 1)
                    if safe > 0:
                        reasoning_parts.append(buf[:safe])
                        buf = buf[safe:]
                    break
                if idx:
                    reasoning_parts.append(buf[:idx])
                buf = buf[idx + len(CLOSE) :]
                state['mode'] = 'visible'
        state['buf'] = buf
        return ''.join(visible_parts), ''.join(reasoning_parts)

    def flush():
        """Emit anything buffered at end-of-stream (e.g. an unterminated tag)."""
        tail = state['buf']
        state['buf'] = ''
        if state['mode'] == 'thinking':
            return '', tail
        return tail, ''

    feed.flush = flush  # type: ignore[attr-defined]
    return feed


class ChatBase:
    """
    Abstract base class for all chat drivers with configurable token allocation.

    This class provides the foundation for AI chat implementations by handling:
    - Token counting and management
    - Configuration loading and validation
    - Input validation and sanitization
    - Consistent interface for chat operations
    - Warning systems for token limits

    Subclasses must implement the abstract methods _chat() and getTokens()
    to provide provider-specific functionality.

    Attributes:
        _model (str): The model identifier/name being used
        _modelTotalTokens (int): Maximum tokens the model can handle in total
    """

    # Provider block-shape selector for Question.attachments dispatch.
    # Subclasses override; default 'openai' because most providers in the catalog
    # are OpenAI-compatible. Recognized values: 'openai' | 'anthropic' | 'gemini'
    # | 'bedrock'. The non-OpenAI shapes each supply their own translator, and
    # per-provider Chat subclasses override this value.
    provider_shape: str = 'openai'

    # Reasoning capability from services.json (capabilities.reasoning), stamped by
    # the model sync. Read once in __init__ so no driver has to.
    _is_reasoning: bool = False
    # Opt-in: subclass sets True + sets self._raw_client to route through the
    # OpenAI Responses API for reasoning-summary streaming.
    SUPPORTS_REASONING_STREAMING: bool = False
    _raw_client = None

    # Native stream handler key, set by non-OpenAI drivers (e.g. Anthropic);
    # left empty for OpenAI-compatible drivers, which ChatBase auto-wires.
    _native_stream_provider: str = ''
    # Raw openai SDK client for the generic reasoning handler; built lazily by ChatBase.
    _raw_openai_client = None

    def __init__(self, provider: str, connConfig: Dict[str, Any], bag: Dict[str, Any]):
        """
        Initialize the ChatBase instance with provider configuration.

        This constructor loads the configuration for the specified provider,
        extracts model settings, and sets up token management parameters.

        Args:
            provider (str): The name of the AI provider (e.g., 'openai', 'anthropic')
            connConfig (Dict[str, Any]): Connection configuration dictionary containing
                                       provider-specific settings
            bag (Dict[str, Any]): Additional context/state bag that may be used by
                                subclasses for passing runtime information

        Raises:
            ConfigurationError: If the provider configuration is invalid or missing
        """
        # Remember the provider name for drop-and-warn telemetry tagging when
        # a Question carries attachments the shape cannot represent.
        self._provider = provider

        # Load the provider-specific configuration using the Config utility
        # This will merge default settings with provider-specific overrides
        config = Config.getNodeConfig(provider, connConfig)

        # Extract model configuration - these are the core settings that control
        # how the chat driver behaves with respect to token limits
        self._model = validate_model_name(config.get('model'))
        self._modelTotalTokens = config.get('modelTotalTokens', 16384)  # Default to 16K if not specified
        self._modelOutputTokens = config.get('modelOutputTokens', 4096)  # Default to 4K if not specified

        # Validate and clamp output tokens against known safe maximums
        self._modelOutputTokens = validate_max_tokens(self._modelOutputTokens, self._modelTotalTokens)

        # We really can't work with a model that has a very small output window
        if self._modelOutputTokens < 1024:
            raise ValueError(f'Model output tokens ({self._modelOutputTokens}) must be at least 1024')

        # Log the configuration for debugging and monitoring purposes
        # This helps track which model and limits are being used in production
        debug(f'    Model                    : {self._model}')
        debug(f'    Total tokens             : {self._modelTotalTokens}')
        debug(f'    Output tokens            : {self._modelOutputTokens}')

        # Reasoning capability comes from services.json (stamped by the model sync).
        self._is_reasoning = bool((config.get('capabilities') or {}).get('reasoning'))

    def _ensure_openai_compat_reasoning_stream(self) -> None:
        """Lazily build the raw openai client used to stream reasoning for
        OpenAI-compatible drivers (built here, since _llm exists after super().__init__).
        """
        if self._native_stream_provider or self._raw_openai_client is not None:
            return
        if not self._is_reasoning:
            return
        llm = getattr(self, '_llm', None)
        base_url = getattr(llm, 'openai_api_base', None)
        if llm is None or not base_url:
            return  # not an OpenAI-compatible driver (e.g. plain OpenAI, Anthropic)
        key = getattr(llm, 'openai_api_key', None)
        api_key = key.get_secret_value() if hasattr(key, 'get_secret_value') else key
        try:
            from openai import OpenAI

            self._raw_openai_client = OpenAI(api_key=api_key, base_url=str(base_url))
            self._native_stream_provider = 'openai_compat_reasoning'
        except Exception as e:  # openai SDK missing / bad client → fall back to generic stream
            debug(f'    Native reasoning stream unavailable: {type(e).__name__}: {e}')

    def getTotalTokens(self) -> int:
        """
        Return the total number of tokens that the model can handle.

        This represents the maximum context window size for the model,
        including both input prompt and output response tokens.

        Returns:
            int: Maximum total tokens supported by the model
        """
        return self._modelTotalTokens

    def getOutputTokens(self) -> int:
        """
        Return the number of tokens allocated for model output.

        This represents the maximum context window size for the model,
        including both input prompt and output response tokens.

        Returns:
            int: Maximum total tokens that can be output by the model
        """
        return self._modelOutputTokens

    def _chat(self, prompt: str) -> str:
        """
        Send prompt, recieve response.

        This method is pretty common since we are using langchain.

        This method, if implemented by subclasses, should provide the actual
        communication with the AI provider's API. It should handle:
        - Authentication with the provider
        - Request formatting
        - Response parsing
        - Error handling for API failures

        Args:
            prompt (str): The complete prompt to send to the AI model

        Returns:
            str: The raw response from the AI model

        Raises:
            Should raise appropriate exceptions for API failures, authentication
            errors, or other provider-specific issues
        """
        # Ask the LLM
        results = self._llm.invoke(prompt)

        # Return the results
        return results.content

    def getTokens(self, value: str) -> int:
        """
        Determine how many tokens the given string contains.

        This method, if implemented by subclasses, should provide accurate
        token counting for the specific model being used. Different providers
        and models use different tokenization schemes.

        Token counting is crucial for:
        - Ensuring prompts don't exceed model limits
        - Detecting potential response truncation
        - Cost estimation for API usage

        Args:
            value (str): The string to count tokens for

        Returns:
            int: Number of tokens in the input string

        Note:
            Implementation should use the same tokenizer as the target model
            to ensure accuracy
        """
        return self._llm.get_num_tokens(value)

    def map_exception(self, error: Exception) -> Exception:
        """
        Call to map llm specific exceptions to friendlier messages.

        Args:
            error (Exception): The original exception raised by the LLM provider
        Returns:
            Exception: A mapped exception with a clearer message, or the original error
        """
        return error

    def is_retryable_error(self, error: Exception) -> bool:
        """
        Determine if an error is retryable based on common API and network error patterns.

        This method checks for various types of transient errors that are typically
        worth retrying, such as network timeouts, rate limits, and temporary server issues.

        Args:
            error (Exception): The exception to evaluate

        Returns:
            bool: True if the error is retryable, False otherwise
        """
        error_str = str(error).lower()
        error_type = type(error).__name__.lower()

        # Network-related errors (typically retryable)
        retryable_patterns = [
            # Network timeouts and connection issues
            'timeout',
            'timed out',
            'connection',
            'network',
            'socket',
            'connection reset',
            'connection refused',
            'connection aborted',
            'broken pipe',
            'network is unreachable',
            # Rate limiting (common across providers)
            'rate limit',
            'rate_limit',
            'ratelimit',
            'too many requests',
            'quota exceeded',
            'throttled',
            'throttling',
            # Server errors (5xx HTTP status codes)
            'internal server error',
            'bad gateway',
            'service unavailable',
            'gateway timeout',
            'server error',
            '502',
            '503',
            '504',
            '500',
            # Common API temporary errors
            'temporary',
            'temporarily',
            'unavailable',
            'overloaded',
            'maintenance',
            'service degraded',
            # Provider-specific retryable errors
            'openai',
            'anthropic',
            'model overloaded',
            'capacity',
        ]

        # Exception types that are typically retryable
        retryable_types = ['timeouterror', 'connectionerror', 'httperror', 'requestexception', 'urlerror', 'sslerror']

        # Check if error message contains retryable patterns
        for pattern in retryable_patterns:
            if pattern in error_str:
                return True

        # Check if error type is retryable
        if error_type in retryable_types:
            return True

        # Check for HTTP status codes in error messages
        if any(code in error_str for code in ['429', '502', '503', '504', '500']):
            return True

        # Non-retryable errors (authentication, validation, etc.)
        non_retryable_patterns = [
            'authentication',
            'unauthorized',
            'forbidden',
            'invalid api key',
            'permission denied',
            'access denied',
            '401',
            '403',
            'not found',
            '404',
            'method not allowed',
            '405',
            'bad request',
            '400',
            'unprocessable entity',
            '422',
        ]

        for pattern in non_retryable_patterns:
            if pattern in error_str:
                return False

        # Default to retryable for unknown errors (conservative approach)
        return True

    def _chat_with_retries(self, prompt: str) -> str:
        """
        Handle chat requests with retries for transient errors.

        This method wraps the actual chat implementation with robust retry logic
        for handling network failures, rate limits, and other transient errors
        using exponential backoff.

        Args:
            prompt (str): The complete prompt to send to the AI model

        Returns:
            str: The raw response from the AI model

        Raises:
            Exception: If network/API retries are exhausted or non-retryable
                      errors occur
        """
        from ai.constants import CONST_CHAT_MAX_RETRIES, CONST_CHAT_BASE_DELAY, CONST_CHAT_MAX_DELAY

        max_network_retries = CONST_CHAT_MAX_RETRIES
        base_delay = CONST_CHAT_BASE_DELAY
        max_delay = CONST_CHAT_MAX_DELAY

        for attempt in range(max_network_retries):
            try:
                # Call the actual chat implementation provided by the subclass
                return self._chat(prompt)

            except Exception as e:
                # Determine if this is a retryable error
                is_retryable = self.is_retryable_error(e)

                if not is_retryable or attempt == max_network_retries - 1:
                    # Non-retryable error or max retries reached
                    debug(f'Chat failed after {attempt + 1} attempts: {str(e)}')

                    # Surface the raw provider message in the UI Errors tab
                    # before map_exception() collapses it into a vaguer ValueError.
                    warning(f'Chat failed for model={self._model} ({type(e).__name__}): {e}')

                    # Map to a friendlier exception if possible
                    raise self.map_exception(e)

                # Calculate exponential backoff delay
                delay = min(base_delay * (2**attempt), max_delay)

                debug(
                    f'Network/API error on attempt {attempt + 1}/{max_network_retries}: {str(e)}. Retrying in {delay:.1f} seconds...'
                )

                # Wait before retrying
                time.sleep(delay)

        # This should never be reached due to the raise in the loop
        raise Exception('Unexpected exit from retry loop')

    def _chat_blocks(self, blocks):
        """Send a provider-native content-block list and return the text response.

        Default implementation refuses, so a node that advertises a
        ``provider_shape`` without overriding this method fails loudly rather
        than silently dropping every attachment back to text-only. Provider
        Chat subclasses with multimodal support override this.

        Args:
            blocks: The translated content list for the provider (e.g. the
                OpenAI ``messages[0].content`` array of typed dicts).

        Returns:
            str: The model's response text.
        """
        raise NotImplementedError(
            f"Provider '{self._provider}' does not support attachment blocks; "
            'override _chat_blocks on the Chat subclass.'
        )

    def _chat_string_responses(
        self,
        prompt: str,
        on_chunk: Optional[Callable[[str], None]] = None,
        on_finish: Optional[Callable[[Optional[str]], None]] = None,
        on_reasoning_chunk: Optional[Callable[[str], None]] = None,
        emitted: Optional[Dict[str, bool]] = None,
    ) -> str:
        """Stream the answer and reasoning summary via the OpenAI Responses API,
        falling back to non-streaming invoke() only if nothing reached the UI yet.
        """
        prompt = validate_prompt(prompt, self._modelTotalTokens, self.getTokens)

        text_parts: list = []
        finish_reason: Optional[str] = None
        try:
            stream = self._raw_client.responses.create(
                model=self._model,
                input=prompt,
                reasoning={'summary': 'auto'},
                max_output_tokens=self._modelOutputTokens,
                stream=True,
            )
            for event in stream:
                etype = getattr(event, 'type', '') or ''
                if etype == 'response.reasoning_summary_text.delta':
                    delta = getattr(event, 'delta', '') or ''
                    if delta and on_reasoning_chunk is not None:
                        on_reasoning_chunk(delta)
                elif etype == 'response.output_text.delta':
                    delta = getattr(event, 'delta', '') or ''
                    if delta:
                        text_parts.append(delta)
                        if on_chunk is not None:
                            on_chunk(delta)
                elif etype == 'response.completed':
                    resp = getattr(event, 'response', None)
                    if resp is not None:
                        status = getattr(resp, 'status', None)
                        if status == 'completed':
                            finish_reason = 'stop'
                        elif status == 'incomplete':
                            details = getattr(resp, 'incomplete_details', None)
                            reason = getattr(details, 'reason', None) if details else None
                            finish_reason = reason or 'length'
                        else:
                            finish_reason = status or 'stop'
                elif etype in ('response.failed', 'response.error'):
                    finish_reason = 'error'
        except Exception as e:
            warning(f'Reasoning streaming disabled for model={self._model} ({type(e).__name__}): {e}.')
            # Only retry non-streaming if nothing has reached the UI; otherwise
            # the full fallback would arrive on top of the partial we already streamed.
            if emitted is None or not emitted['any']:
                results = self._llm.invoke(prompt)
                content = getattr(results, 'content', '') or ''
                content_text = content if isinstance(content, str) else str(content)
                text_parts = [content_text]
                # Push the fallback answer through on_chunk so the open UI bubble
                # gets the visible text (the caller dedupes the final pipeline result).
                if content_text and on_chunk is not None:
                    on_chunk(content_text)
                finish_reason = 'stop'
            else:
                finish_reason = 'error'

        if on_finish is not None:
            on_finish(finish_reason)

        return ''.join(text_parts)

    def chat_string(
        self,
        prompt: str,
        on_chunk: Optional[Callable[[str], None]] = None,
        on_finish: Optional[Callable[[Optional[str]], None]] = None,
        on_reasoning_chunk: Optional[Callable[[str], None]] = None,
    ) -> str:
        """Run a string prompt with token checks and retry; when callbacks are given,
        stream visible/reasoning deltas as they arrive. Returns the full answer.
        """
        # Validate and sanitize the prompt before processing
        prompt = validate_prompt(prompt, self._modelTotalTokens, self.getTokens)

        # Count tokens in the input prompt to check against limits
        # This is important for preventing API errors and ensuring quality responses
        prompt_tokens = self.getTokens(prompt)

        # Check if the prompt is too long, leaving insufficient space for response
        # We reserve 100 tokens for the response to ensure the model has room to answer
        # This is a conservative estimate - adjust based on your use case
        if prompt_tokens >= self._modelTotalTokens - 100:
            debug(
                f'Warning: Prompt ({prompt_tokens} tokens) exceeds input allocation ({self._modelTotalTokens} tokens)'
            )

        # True once visible text reached the UI; fallback then skips the non-stream
        # retry to avoid duplication. Only on_chunk flips it (not reasoning).
        emitted = {'any': False}

        if on_chunk is None:
            on_chunk_w = None
        else:

            def on_chunk_w(t):
                emitted['any'] = True
                on_chunk(t)

        on_reasoning_chunk_w = on_reasoning_chunk

        # Responses API path for opt-in reasoning models (OpenAI o-series / gpt-5).
        if (
            self.SUPPORTS_REASONING_STREAMING
            and self._is_reasoning
            and self._raw_client is not None
            and hasattr(self._raw_client, 'responses')
        ):
            return self._chat_string_responses(
                prompt,
                on_chunk=on_chunk_w,
                on_finish=on_finish,
                on_reasoning_chunk=on_reasoning_chunk_w,
                emitted=emitted,
            )

        # Provider-native streaming (generic openai_compat reasoning, Anthropic extended thinking).
        if on_chunk is not None:
            # Auto-wire the generic OpenAI-compatible reasoning stream from config
            # (no per-provider code). Special-case drivers already set their handler.
            self._ensure_openai_compat_reasoning_stream()
            native_text = dispatch_native_chat_stream(self, prompt, on_chunk_w, on_finish, on_reasoning_chunk_w)
            if native_text is not None:
                result_tokens = self.getTokens(native_text)
                if prompt_tokens + result_tokens >= self._modelTotalTokens - 5:
                    debug(f'Warning: Result ({result_tokens} tokens) was probably truncated')
                return native_text
            # Native handler returned None after emitting chunks: don't restart
            # the request through a different path, just close with an error.
            if emitted['any']:
                if on_finish is not None:
                    on_finish('error')
                return ''

        _llm = getattr(self, '_llm', None)

        # Call the chat implementation with network retry logic
        # This is where the real communication with the AI provider happens
        # Use chat_string when a per-token callback is provided; .stream() if available, else fall back.
        result = None
        if on_chunk_w is not None and _llm is not None and hasattr(_llm, 'stream'):
            try:
                parts = []
                finish_reason: Optional[str] = None
                _signature_only_note_sent = False
                _think_split = _make_think_tag_splitter()
                for piece in _llm.stream(prompt):
                    # content: str for OpenAI-style, list of typed blocks for Anthropic.
                    content = piece.content
                    text = ''
                    thinking_delta = ''
                    if isinstance(content, list):
                        for b in content:
                            if not isinstance(b, dict):
                                continue
                            btype = b.get('type', '')
                            if btype == 'thinking':
                                # carries either text deltas or a signature-only final delta.
                                piece_text = b.get('thinking') or b.get('text') or ''
                                if piece_text:
                                    thinking_delta += piece_text
                                elif b.get('signature') and not _signature_only_note_sent:
                                    if on_reasoning_chunk_w is not None:
                                        thinking_delta += (
                                            '_Extended thinking ran, but this stream only delivered the '
                                            'block verification signature, not the readable chain-of-thought '
                                            'text. The answer below still reflects internal reasoning._\n\n'
                                        )
                                        _signature_only_note_sent = True
                            elif btype == 'reasoning':
                                # LangChain v1 standard block (thinking → reasoning).
                                piece_text = b.get('reasoning') or b.get('text') or ''
                                if piece_text:
                                    thinking_delta += piece_text
                            elif btype == 'text' or not btype:
                                text += b.get('text', '')
                    elif isinstance(content, str):
                        # Strip inline `<think>...</think>` (Perplexity sonar-reasoning fallback).
                        text, _thinking_inline = _think_split(content)
                        if _thinking_inline:
                            thinking_delta += _thinking_inline
                    if thinking_delta and on_reasoning_chunk_w is not None:
                        on_reasoning_chunk_w(thinking_delta)
                    if text:
                        on_chunk_w(text)
                        parts.append(text)
                    reason = (piece.response_metadata or {}).get('finish_reason')
                    if reason:
                        finish_reason = reason
                # Drain chars buffered by the <think> splitter (partial-tag tail).
                tail_visible, tail_reasoning = _think_split.flush()
                if tail_visible:
                    on_chunk_w(tail_visible)
                    parts.append(tail_visible)
                if tail_reasoning and on_reasoning_chunk_w is not None:
                    on_reasoning_chunk_w(tail_reasoning)
                if parts:
                    result = ''.join(parts)
                    if on_finish is not None:
                        on_finish(finish_reason)
            except Exception as e:
                warning(
                    f'Streaming disabled for model={self._model} '
                    f'({type(e).__name__}): {e}. Falling back to non-streaming response.'
                )
        if result is None:
            # If anything already reached the UI we can't restart the request
            # (would duplicate content); close with an error and return partials.
            if emitted['any']:
                if on_finish is not None:
                    on_finish('error')
                result = ''
            else:
                result = self._chat_with_retries(prompt)

        # Count tokens in the response to check for potential truncation
        # This helps identify cases where the model's response was cut off
        result_tokens = self.getTokens(result)

        # Check if the total token usage suggests the response was truncated
        # We use a small buffer (5 tokens) to account for tokenization differences
        # between our counting and the model's internal counting
        if prompt_tokens + result_tokens >= self._modelTotalTokens - 5:
            debug(f'Warning: Result ({result_tokens} tokens) was probably truncated')

        # Return the model's response
        return result

    def _get_file_store(self):
        """Return the per-account FileStore used to read attachment bytes.

        Honours an injected ``self._file_store`` if one is ever set; otherwise
        (the current production path) it builds one via the shared builder,
        which resolves through :mod:`ai.account.store` using the ambient
        ``ROCKETRIDE_CLIENT_ID`` env var. Returns an object exposing
        ``read_bytes(path) -> bytes`` (sync).
        """
        injected = getattr(self, '_file_store', None)
        if injected is not None:
            return injected

        from ai.common.file_store import build_sync_account_file_store

        return build_sync_account_file_store()

    def _make_notice(self, filename, mime, reason):
        """Build a structured attachment notice for the chat UI.

        The content (human ``message``) lives here so the node layer only has
        to route the dict to its ``attachment_notice`` SSE stream. ``reason``
        is one of ``'too_large'``, ``'unsupported'``, ``'provider_error'``.
        """
        provider = self._provider
        msg = {
            'too_large': f'{filename} is too large to send to the model (max 100 MB).',
            'unsupported': f"{filename or 'Attachment'} wasn't sent — {provider} can't read {mime}.",
            'provider_error': f'The model rejected {filename or "an attachment"}.',
        }[reason]
        return {'filename': filename, 'mime': mime, 'reason': reason, 'provider': provider, 'message': msg}

    def _chat_with_attachments(self, question: Question, attachments, on_notice=None) -> str:
        """Dispatch a Question with attachments through the provider-shape translator.

        Picks the translator by ``self.provider_shape``, reads each
        attachment's bytes via the per-account FileStore, builds the
        provider-native content blocks, and invokes ``_chat_blocks``.
        Over-cap attachments are pre-dropped; unsupported MIMEs drop+warn;
        FileStore IO errors propagate. Every drop and any provider error is
        surfaced through the optional ``on_notice(notice: dict)`` callback so
        the node layer can route it to the chat UI.
        """
        from ai.common.llm_translate import (
            translate_anthropic_shape,
            translate_bedrock_shape,
            translate_gemini_shape,
            translate_openai_shape,
        )

        prompt_text = question.getPrompt()
        shape = getattr(self, 'provider_shape', 'openai')

        def _log_drops(dropped):
            for d in dropped:
                # Structured METRIC log line; MIME only, never path/filename
                # (privacy invariant).
                debug(f'METRIC attachment.dropped_unsupported provider={d.provider} mime={d.mime}')
                # Surface each unsupported drop to the chat UI (filename + MIME).
                if on_notice:
                    on_notice(self._make_notice(d.filename, d.mime, 'unsupported'))

        def _log_forwarded(kept_mimes):
            # One emission per surviving attachment per send, tagged with
            # provider + per-attachment MIME so it can be aggregated by both.
            for mime in kept_mimes:
                debug(f'METRIC llm.attachment_forwarded provider={self._provider} mime={mime}')

        def _kept_mimes(all_atts, dropped_list):
            """Return the MIME list of attachments that survived translation."""
            dropped_ids = {getattr(d, 'attachment_id', None) for d in dropped_list}
            return [
                getattr(a, 'mime', 'application/octet-stream')
                for a in all_atts
                if getattr(a, 'attachment_id', None) not in dropped_ids
            ]

        # Each shape supplies its own translator returning (blocks, dropped);
        # the blocks go straight to _chat_blocks. Adding a provider shape is a
        # one-line entry here, not another near-identical branch.
        translators = {
            'openai': translate_openai_shape,
            'anthropic': translate_anthropic_shape,
            'gemini': translate_gemini_shape,
            'bedrock': translate_bedrock_shape,
        }
        translate = translators.get(shape)

        if translate is None:
            # Unknown shape: warn and fall back to text-only so the existing
            # pipeline keeps working until per-node shapes land.
            debug(f'provider_shape={shape!r} not recognized; falling back to text-only for provider {self._provider}')
            return self.chat_string(prompt_text)

        # Pre-check the 100 MB LLM cap before any translate/read: over-cap
        # attachments are dropped with a notice and never base64-inlined.
        SLURP_CAP = 100 * 1024 * 1024
        kept = []
        for att in attachments:
            if getattr(att, 'size_bytes', 0) > SLURP_CAP:
                if on_notice:
                    on_notice(self._make_notice(att.filename, att.mime, 'too_large'))
            else:
                kept.append(att)
        attachments = kept

        file_store = self._get_file_store()
        try:
            blocks, dropped = translate(prompt_text, attachments, file_store, self._provider)
            _log_drops(dropped)
            _log_forwarded(_kept_mimes(attachments, dropped))
            try:
                return self._chat_blocks(blocks)
            except Exception as e:
                # Provider rejected the blocks: surface it and still answer the
                # turn with a text-only fallback rather than propagating.
                if on_notice:
                    n = self._make_notice('', '', 'provider_error')
                    n['message'] = f'The model rejected the attachment: {e}'
                    on_notice(n)
                return self.chat_string(prompt_text)
        except Exception:
            # Byte-materialising read failed (e.g. FileStore 100 MB cap hit when
            # size_bytes was 0/missing). Surface as too_large and answer text-only
            # so the turn still completes rather than propagating uncaught.
            if on_notice:
                n = self._make_notice('', '', 'too_large')
                n['message'] = 'An attachment could not be read (it may exceed the 100 MB limit).'
                on_notice(n)
            return self.chat_string(prompt_text)

    def chat(
        self,
        question: Question,
        on_chunk: Optional[Callable[[str], None]] = None,
        on_finish: Optional[Callable[[Optional[str]], None]] = None,
        on_reasoning_chunk: Optional[Callable[[str], None]] = None,
        on_notice: Optional[Callable[[dict], None]] = None,
    ) -> Answer:
        """Chat with Question/Answer objects (JSON validation + retry); forwards the
        streaming callbacks unless expectJson, which needs the validated final answer.

        ``on_notice`` receives a structured attachment-drop / provider-error
        dict (see :meth:`_make_notice`) so the node layer can route it to the
        chat UI as an ``attachment_notice`` SSE event.
        """
        # No streaming for expectJson: repair retries would paint a bad first attempt.
        stream_cbs = (None, None, None) if question.expectJson else (on_chunk, on_finish, on_reasoning_chunk)

        # Per-shape attachment dispatch. Backwards-compatible: text-only Questions
        # take the existing streaming fast path so no production behavior changes
        # until per-node shapes are wired. FileStore IO errors raise; unsupported
        # MIMEs drop+warn.
        attachments = list(getattr(question, 'attachments', []) or [])
        # Emit count_per_message on every send (including zero) so the
        # orphan-volume signal (upload_starts − Σ counts) is computable from
        # production logs without a reaper in v1.
        debug(
            f'METRIC attachment.count_per_message '
            f'provider={getattr(self, "_provider", "unknown")} count={len(attachments)}'
        )
        if attachments:
            # Attachment path is non-streaming; callbacks apply to text-only sends.
            response = self._chat_with_attachments(question, attachments, on_notice=on_notice)
        else:
            # Use chat_string which already handles network retries and token management
            response = self.chat_string(
                question.getPrompt(),
                on_chunk=stream_cbs[0],
                on_finish=stream_cbs[1],
                on_reasoning_chunk=stream_cbs[2],
            )

        # If JSON output is expected, validate the response and retry if needed.
        # Store the parsed result so setAnswer receives a dict/list directly —
        # avoiding a second parse through Answer.parseJson with the raw fenced string.
        parsed_response = None
        if question.expectJson:
            max_retries = 3

            for retry_count in range(max_retries):
                try:
                    # Parse (and strip any markdown fences) — reuse the result below
                    parsed_response = parseJson(response)

                    # Create the json answer and return it
                    answer = Answer(expectJson=True)
                    answer.setAnswer(parsed_response)
                    return answer

                except (json.JSONDecodeError, ValueError):
                    # JSON parsing failed
                    if retry_count < max_retries - 1:
                        debug(f'JSON validation failed on attempt {retry_count + 1}, retrying...')

                        # Retry the chat with the additional instruction
                        # This will again use chat_string with full network retry logic
                        response = self.chat_string(question.getPrompt(has_previous_json_failed=True))
                    else:
                        # Max retries reached, raise ValueError
                        error_msg = f'Failed to get valid JSON response after {max_retries + 1} attempts. Last response: {response[:200]}...'
                        debug(f'Error: {error_msg}')
                        raise ValueError(error_msg)

        else:
            # Create the answer and assign the text
            answer = Answer(expectJson=False)
            answer.setAnswer(response)

            # And return it
            return answer


def getChat(provider: str, connConfig: Dict[str, Any], bag: Dict[str, Any]) -> ChatBase:
    """
    Create and initialize a chat driver for the specified provider.

    This function uses dynamic module loading to instantiate the appropriate
    chat driver based on the provider name. It follows a naming convention
    where each provider has a module in the 'connectors' package with a
    'Chat' class that extends ChatBase.

    The factory pattern allows for easy extension of the system with new
    providers without modifying existing code.

    Args:
        provider (str): The name of the AI provider (e.g., 'openai', 'anthropic')
                       This corresponds to a module name in the connectors package
        connConfig (Dict[str, Any]): Configuration dictionary specific to the provider
        bag (Dict[str, Any]): Additional context/state information

    Returns:
        ChatBase: An instance of the appropriate chat driver subclass

    Raises:
        ImportError: If the provider module cannot be imported
        Exception: If the provider module doesn't have a 'Chat' class

    Example:
        >>> chat = getChat('openai', {'api_key': 'sk-...', 'model': 'gpt-4'}, {})
        >>> response = chat.chat_string('Hello, world!')
    """
    # Construct the module name following the naming convention
    # All provider modules are expected to be in the 'connectors' package
    name = 'connectors.' + provider

    # Dynamically import the provider module
    # This allows for runtime loading of different providers without
    # having to import all possible providers at startup
    module = importlib.import_module(name)

    # Validate that the module has the expected 'Chat' class
    # This ensures that the provider follows the required interface
    if not hasattr(module, 'Chat'):
        raise Exception(f'Module {provider} is not a chat provider')

    # Instantiate and return the Chat class from the provider module
    # The Chat class is expected to be a subclass of ChatBase
    return getattr(module, 'Chat')(provider, connConfig, bag)
