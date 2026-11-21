# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
ChatBase - Abstract Base Class for AI Chat Drivers.

This module provides the foundation for all chat-based AI drivers in the system.
It handles token management, configuration loading, and provides a consistent
interface for interacting with different AI providers.

The ChatBase class is designed to be subclassed by specific AI provider
implementations (e.g., OpenAI, Anthropic, etc.) that handle the actual
communication with their respective APIs.

One chat serves every call of its control (plan 4.1 rule 1), and the model,
its token limits and the tuning leaves are per-call parameters (rule 4): the
chat holds only what the environment decides (a client, a key, an endpoint),
and every request reads the call's values from the ``ChatCall`` that
``LLMBase`` publishes for it (``ChatBase.calling``). A LangChain driver keeps
ONE object built from the environment and binds the call's values onto it per
request (``ChatBase.bound_llm``).
"""

import time
import json
import threading
import contextlib
import contextvars
from collections import OrderedDict
from dataclasses import dataclass
from typing import Dict, Any, Callable, Hashable, Iterator, Mapping, Optional, Tuple
from rocketlib import debug, warning
from ai.common.schema import Answer, Question
from ai.common.config import check_credential_resolved
from ai.common.util import EmptyResponseError, ThinkTruncatedError, parseJson
from ai.common.validation import (
    validate_model_name,
    validate_max_tokens,
    sanitize_prompt,
    validate_prompt,
)
from ai.common.llm_native_stream import PROMPT_CACHE_PREFIX_VAR, STOP_SEQUENCES_VAR, dispatch_native_chat_stream
from ai.common.llm_adapter import LangChainAdapter, NativeOpenAIResponsesAdapter, drive_adapter


# Finish reasons that mean the model ran out of output budget, as the Responses API
# (max_output_tokens) and Chat Completions (length) report them.
_OUTPUT_LIMIT_REASONS = ('length', 'max_output_tokens')

# True while ChatBase.chat runs a JSON-expecting question. A per-call context
# variable rather than an attribute, because one chat instance serves concurrent
# calls: only JSON calls skip the Responses fallback when the output limit is hit,
# since chat() then fails fast with EmptyResponseError; plain-text calls keep it.
_EXPECT_JSON_VAR: contextvars.ContextVar[bool] = contextvars.ContextVar('rocketride_chat_expect_json', default=False)


# ==== The call ===================================================================


@dataclass(frozen=True)
class ChatCall:
    """
    The generation values of ONE call (plan 4.1 rule 4).

    The model, its token limits and the tuning leaves of an LLM node are
    per-call parameters: one control serves a call on one model and the next
    call on another. ``ChatBase.resolve_call`` builds this record from the
    call's ``settings``; ``ChatBase.calling`` publishes it for the duration of
    the call, and every request the chat sends reads it.

    Attributes:
        settings: The call's settings view; a driver reads its own leaves
            (``temperature``, ``extendedThinking``, ``serverbase``, ...) here.
        model: The model id (the custom branch's free-text id included).
        total_tokens: The model's context window.
        output_tokens: The most tokens one reply may hold.
        reasoning: The model branch's ``reasoning`` constant.
    """

    settings: Mapping[str, Any]
    model: str
    total_tokens: int
    output_tokens: int
    reasoning: bool


#: The call a chat is serving on this thread, with the chat it belongs to. A
#: context variable, like the stop sequences, because one chat serves the
#: concurrent bindings of its control: nothing per call may sit on the chat.
CHAT_CALL_VAR: contextvars.ContextVar[Optional[Tuple[Any, ChatCall]]] = contextvars.ContextVar(
    'rocketride_chat_call', default=None
)

#: The model leaves a schema may flag as per-call parameters.
_CALL_KEYS = frozenset({'model', 'customModel', 'modelTotalTokens', 'modelOutputTokens'})

#: The model a driver's LangChain object is constructed with. Every request
#: binds the call's model over it; a request that did not would be refused by
#: the provider under this name instead of running on a default model.
UNBOUND_MODEL = 'model-is-bound-per-call'

#: The most handles one chat keeps in its keyed cache (plan 4.1 rule 4: a
#: cache on the control's IGlobal is bounded). Each is rebuilt on demand.
_KEYED_LIMIT = 16


def _count_tokens(llm: Any, model: str, value: str) -> int:
    """
    Count tokens with a LangChain object's tokenizer for the call's model.

    An OpenAI-family object counts with the tiktoken encoding of the model it
    names, and the driver's object names ``UNBOUND_MODEL``; a shallow copy
    naming the call's model counts as the request is billed (the copy builds
    no client, and tiktoken caches its encodings process-wide). An object
    with its own counter (``custom_get_token_ids``) counts the same for every
    model.

    Args:
        llm: The LangChain chat model.
        model: The call's model id.
        value: The text to count.

    Returns:
        int: The token count.
    """
    if hasattr(llm, 'tiktoken_model_name') and getattr(llm, 'custom_get_token_ids', None) is None:
        llm = llm.model_copy(update={'tiktoken_model_name': model})
    return llm.get_num_tokens(value)


def _stop_kwargs() -> dict:
    """Return ``{'stop': [...]}`` only when stop sequences are active for this call.

    Passing ``stop=`` unconditionally (even ``stop=None``) breaks model backends and
    test mocks whose ``invoke``/``stream`` signature does not accept a ``stop`` kwarg, so
    the argument is omitted entirely for the common no-stop path.

    INVARIANT: this is read within the synchronous ``ask()`` call, while
    ``LLMBase._question`` still holds the contextvar (before its ``finally`` reset).
    Do not defer consumption (e.g. by returning a lazy generator to the caller) —
    the value would then read ``None`` after the reset and silently send no stop.
    """
    stop = STOP_SEQUENCES_VAR.get()
    return {'stop': stop} if stop else {}


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

    The model, its limits and the tuning leaves are the CALL's (``self.call``),
    never the chat's: one chat serves every call of its control, concurrently.
    A node whose schema keeps the model leaves as config (none of them flagged
    ``param``) has one call shape per control, resolved here once; its driver
    code may still read ``_model``, ``_modelTotalTokens`` and
    ``_modelOutputTokens``, which exist only on such a chat.
    """

    # Opt-in: subclass sets True + sets self._raw_client to route through the
    # OpenAI Responses API for reasoning-summary streaming.
    SUPPORTS_REASONING_STREAMING: bool = False
    _raw_client = None

    # Opt-in: a driver sets True when its request builder reads PROMPT_CACHE_PREFIX_VAR
    # and marks that prefix for the provider's prompt cache (Anthropic).
    SUPPORTS_PROMPT_CACHE_PREFIX: bool = False

    # The driver's LangChain object, built from the environment; None for a
    # driver that talks to its provider's SDK directly
    _llm: Any = None

    # The call shape of a node that keeps its model leaves as config; None
    # when they are per-call parameters (the call then comes from LLMBase)
    _control_call: Optional[ChatCall] = None

    def __init__(self, provider: str, connConfig: Dict[str, Any], bag: Dict[str, Any]):
        """
        Initialize the ChatBase instance with provider configuration.

        Args:
            provider (str): The name of the AI provider (e.g., 'openai', 'anthropic')
            connConfig (Dict[str, Any]): The control's resolved configuration
                (the IGlobal's ``self.config``)
            bag (Dict[str, Any]): The endpoint bag (read-only; the chat lives on the IGlobal)

        Raises:
            ValueError: A credential is unresolved, or a config model leaf is invalid.
        """
        # connConfig is the resolver's view of the node's config (the IGlobal's
        # self.config): defaults applied, the active branch flattened, keys read
        # by path. The provider subclasses read their own control-level keys
        # (apikey, serverbase, region, ...) from here, never resolving again.
        config = connConfig
        self._config = config

        # The keyed cache of handles a driver builds per call value (an
        # endpoint, a model id); bounded, and shared by the control's bindings
        self._keyed: 'OrderedDict[Hashable, Any]' = OrderedDict()
        self._keyed_lock = threading.Lock()

        # A key still written as ${ROCKETRIDE_...} would go to the provider as the key,
        # and the user would see an "invalid API key" reply instead of the missing name.
        check_credential_resolved(provider, 'apikey', config.get('apikey'))

        # A node that keeps its model leaves as config resolves its one call
        # shape here (reading a param-flagged leaf here would raise)
        if not (_CALL_KEYS & getattr(config, 'param_keys', frozenset())):
            call = self.resolve_call(config)
            self._control_call = call
            self._model = call.model
            self._modelTotalTokens = call.total_tokens
            self._modelOutputTokens = call.output_tokens

    # ---- The call ------------------------------------------------------------

    def resolve_call(self, settings: Mapping[str, Any]) -> ChatCall:
        """
        Build the generation values of one call from its settings.

        The model selector may have a "custom" branch whose free-text id lives
        in ``customModel``; that leaf is reachable only on that branch, so its
        presence (not the selector value) says the id lives there. An unset
        optional leaf resolves to None (defaults are never written): only None
        takes the fallback, so a configured 0 still reaches
        ``validate_max_tokens`` and is refused there.

        Args:
            settings: The call's effective configuration (``IInstance.settings``),
                or the control's configuration for a node that keeps its model
                leaves as config.

        Returns:
            ChatCall: The call's model, limits and reasoning flag.

        Raises:
            ValueError: The model id is malformed, or the output window is below 1024.
        """
        # Step 1: the model id, the custom branch's included
        model = validate_model_name(settings.get('customModel') or settings.get('model'))

        # Step 2: the limits, the output clamped against the known maximums
        total = settings.get('modelTotalTokens')
        output = settings.get('modelOutputTokens')
        total = 16384 if total is None else total
        output = validate_max_tokens(4096 if output is None else output, total)

        # We really can't work with a model that has a very small output window
        if output < 1024:
            raise ValueError(f'Model output tokens ({output}) must be at least 1024')

        # Step 3: reasoning is the model branch's constant (stamped by the model sync)
        return ChatCall(
            settings=settings,
            model=model,
            total_tokens=total,
            output_tokens=output,
            reasoning=bool(settings.get('reasoning')),
        )

    @contextlib.contextmanager
    def calling(self, call: ChatCall) -> Iterator[ChatCall]:
        """
        Serve ``call`` on this chat for the duration of the block.

        Every request the chat sends inside the block reads the call's values;
        the previous call (an outer one on this thread) is restored on exit.

        Args:
            call: The call's generation values (``resolve_call``).

        Yields:
            ChatCall: The same call.
        """
        token = CHAT_CALL_VAR.set((self, call))
        try:
            yield call
        finally:
            CHAT_CALL_VAR.reset(token)

    @property
    def call(self) -> ChatCall:
        """
        The call this chat is serving on this thread.

        Raises:
            RuntimeError: No call is being served and the node's model is a
                per-call parameter (``LLMBase`` publishes one per request).
        """
        published = CHAT_CALL_VAR.get()
        if published is not None and published[0] is self:
            return published[1]
        if self._control_call is not None:
            return self._control_call
        raise RuntimeError(
            'no call is being served: the model is a per-call parameter, so a request runs inside '
            'ChatBase.calling(resolve_call(settings)), as LLMBase does'
        )

    def call_kwargs(self) -> Dict[str, Any]:
        """
        Return the request values this call binds onto the LangChain object.

        A driver adds its own per-call leaves (temperature, a timeout, ...)
        read from ``self.call.settings``.

        Returns:
            dict: ``model`` and ``max_tokens`` of the call, by default.
        """
        call = self.call
        return {'model': call.model, 'max_tokens': call.output_tokens}

    def _llm_for(self) -> Any:
        """
        Return the LangChain object this call's request goes through.

        One object built from the environment by default; a driver whose
        endpoint or model handle varies with the call returns one from its
        keyed cache (``_keyed_handle``).
        """
        return self._llm

    def bound_llm(self) -> Any:
        """Return the LangChain object with this call's values bound (a binding: no client, no network)."""
        return self._llm_for().bind(**self.call_kwargs())

    def _keyed_handle(self, key: Hashable, build: Callable[[], Any]) -> Any:
        """
        Return the handle cached under ``key``, building it once.

        The cache is bounded (the oldest handle leaves first) and every handle
        in it is rebuildable from the environment and a call value, so losing
        one costs time, never correctness (plan 4.1 rule 1).

        Args:
            key: The call value(s) the handle depends on.
            build: Builds the handle; runs under the cache lock.

        Returns:
            The handle.
        """
        with self._keyed_lock:
            handle = self._keyed.get(key)
            if handle is None:
                handle = build()
                self._keyed[key] = handle
                while len(self._keyed) > _KEYED_LIMIT:
                    self._keyed.popitem(last=False)
            else:
                self._keyed.move_to_end(key)
            return handle

    def native_stream_key(self) -> str:
        """
        Return the native stream handler that serves this call, or ''.

        An OpenAI-compatible driver (a LangChain object with a base URL) streams
        a reasoning model through the raw ``openai`` client so its reasoning
        deltas survive; a driver with its own handler (Anthropic) overrides this.
        """
        if not self.call.reasoning:
            return ''
        return 'openai_compat_reasoning' if self.raw_openai_client() is not None else ''

    def raw_openai_client(self) -> Any:
        """
        Return the raw ``openai`` client of this call's endpoint, or None.

        Built once per endpoint from the LangChain object's base URL and key
        (the environment's), so a driver whose endpoint varies with the call
        gets the matching client. None for a driver without a base URL (plain
        OpenAI, Anthropic) or without the ``openai`` SDK.
        """
        llm = self._llm_for()
        base_url = getattr(llm, 'openai_api_base', None)
        if not base_url:
            return None
        key = getattr(llm, 'openai_api_key', None)
        api_key = key.get_secret_value() if hasattr(key, 'get_secret_value') else key

        def build() -> Any:
            try:
                from openai import OpenAI

                return OpenAI(api_key=api_key, base_url=str(base_url))
            except Exception as e:  # openai SDK missing / bad client → fall back to generic stream
                debug(f'    Native reasoning stream unavailable: {type(e).__name__}: {e}')
                return False

        client = self._keyed_handle(('raw_openai', str(base_url)), build)
        return client or None

    def getTotalTokens(self) -> int:
        """
        Return the total number of tokens that the call's model can handle.

        This represents the maximum context window size for the model,
        including both input prompt and output response tokens.

        Returns:
            int: Maximum total tokens supported by the model
        """
        return self.call.total_tokens

    def getOutputTokens(self) -> int:
        """
        Return the number of tokens allocated for the call's model output.

        Returns:
            int: Maximum total tokens that can be output by the model
        """
        return self.call.output_tokens

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
        # Non-streaming: invoke through the adapter — same shared normalization as streaming,
        # but a genuinely different mechanism, so the streaming fallback can still recover.
        text, _items = LangChainAdapter(self.bound_llm(), stream_kwargs=_stop_kwargs()).collect(prompt)
        return text

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
        return _count_tokens(self._llm_for(), self.call.model, value)

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
                    warning(f'Chat failed for model={self.call.model} ({type(e).__name__}): {e}')

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
        prompt = validate_prompt(prompt, self.getTotalTokens(), self.getTokens)
        try:
            adapter = NativeOpenAIResponsesAdapter(self)
            text, _items = drive_adapter(adapter, prompt, on_chunk, on_reasoning_chunk)
            if not text and adapter.finish_reason in _OUTPUT_LIMIT_REASONS and _EXPECT_JSON_VAR.get():
                # The model spent its whole output budget (usually on reasoning) before
                # writing anything. The fallback below would send the same request with
                # the same budget and fail the same way, at the price of a second call.
                # For a JSON call, chat() turns this empty reply into EmptyResponseError.
                if on_finish is not None:
                    on_finish(adapter.finish_reason)
                return ''
            if not text:
                # No text (e.g. response.failed) → route to the fallback below, like the Anthropic path.
                raise RuntimeError('OpenAI Responses stream produced no text')
            if on_finish is not None:
                on_finish(adapter.finish_reason)
            return text
        except Exception as e:
            warning(f'Reasoning streaming disabled for model={self.call.model} ({type(e).__name__}): {e}.')
            # Only retry non-streaming if nothing reached the UI; otherwise the full
            # fallback would arrive on top of the partial we already streamed.
            if emitted is None or not emitted['any']:
                adapter = LangChainAdapter(self.bound_llm(), stream_kwargs=_stop_kwargs())
                content_text, _items = adapter.collect(prompt)
                # Reasoning reaches its own lane; it must never land in the visible text.
                if adapter.reasoning and on_reasoning_chunk is not None:
                    on_reasoning_chunk(adapter.reasoning)
                if content_text and on_chunk is not None:
                    on_chunk(content_text)
                if on_finish is not None:
                    on_finish('stop')
                return content_text
            if on_finish is not None:
                on_finish('error')
            return ''

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
        # The call's context window bounds the prompt and the truncation checks
        total_tokens = self.getTotalTokens()

        # Validate and sanitize the prompt before processing
        prompt = validate_prompt(prompt, total_tokens, self.getTokens)

        # Count tokens in the input prompt to check against limits
        # This is important for preventing API errors and ensuring quality responses
        prompt_tokens = self.getTokens(prompt)

        # Check if the prompt is too long, leaving insufficient space for response
        # We reserve 100 tokens for the response to ensure the model has room to answer
        # This is a conservative estimate - adjust based on your use case
        if prompt_tokens >= total_tokens - 100:
            debug(f'Warning: Prompt ({prompt_tokens} tokens) exceeds input allocation ({total_tokens} tokens)')

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
            and self.call.reasoning
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
            # The handler is the call's: a reasoning model of an OpenAI-compatible
            # driver streams through the raw client, Anthropic through its own
            native_text = dispatch_native_chat_stream(self, prompt, on_chunk_w, on_finish, on_reasoning_chunk_w)
            if native_text is not None:
                result_tokens = self.getTokens(native_text)
                if prompt_tokens + result_tokens >= total_tokens - 5:
                    debug(f'Warning: Result ({result_tokens} tokens) was probably truncated')
                return native_text
            # Native handler returned None after emitting chunks: don't restart
            # the request through a different path, just close with an error.
            if emitted['any']:
                if on_finish is not None:
                    on_finish('error')
                return ''

        _llm = self._llm_for()

        # Call the chat implementation with network retry logic
        # This is where the real communication with the AI provider happens
        # Use chat_string when a per-token callback is provided; .stream() if available, else fall back.
        result = None
        if on_chunk_w is not None and _llm is not None and hasattr(_llm, 'stream'):
            try:
                # Stream the LangChain path through the normalized adapter; drive_adapter
                # fans text/thinking to the callbacks and returns the joined answer.
                adapter = LangChainAdapter(self.bound_llm(), stream_kwargs=_stop_kwargs())
                answer, _items = drive_adapter(adapter, prompt, on_chunk_w, on_reasoning_chunk_w)
                if answer:
                    result = answer
                    if on_finish is not None:
                        on_finish(adapter.finish_reason)
            except Exception as e:
                warning(
                    f'Streaming disabled for model={self.call.model} '
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
        if prompt_tokens + result_tokens >= total_tokens - 5:
            debug(f'Warning: Result ({result_tokens} tokens) was probably truncated')

        # Return the model's response
        return result

    def _prompt_cache_prefix(self, question: Question) -> Optional[str]:
        """Return the start of *question*'s prompt that stays the same between calls.

        That is the prompt rendered without its context, documents, goals and
        questions: role, instructions, examples and history come first in getPrompt,
        so this rendering is always a prefix of the full prompt. Only for drivers that
        support it and questions that ask for it (Question.cachePrefix).
        """
        if not (self.SUPPORTS_PROMPT_CACHE_PREFIX and getattr(question, 'cachePrefix', False)):
            return None
        stable = question.model_copy(update={'context': [], 'documents': [], 'goals': [], 'questions': []})
        # chat_string sanitizes the full prompt; sanitize this the same way so it stays a prefix.
        return sanitize_prompt(stable.getPrompt()) or None

    def chat(
        self,
        question: Question,
        on_chunk: Optional[Callable[[str], None]] = None,
        on_finish: Optional[Callable[[Optional[str]], None]] = None,
        on_reasoning_chunk: Optional[Callable[[str], None]] = None,
    ) -> Answer:
        """Chat with Question/Answer objects (JSON validation + retry); forwards the
        streaming callbacks unless expectJson, which needs the validated final answer.
        """
        # No streaming for expectJson: repair retries would paint a bad first attempt.
        stream_cbs = (None, None, None) if question.expectJson else (on_chunk, on_finish, on_reasoning_chunk)

        # Use chat_string which already handles network retries and token management.
        # Only this first call may mark a cacheable prefix: a JSON repair prompt below
        # inserts an instruction near the top, so its start differs and a cache write
        # there would never be read back.
        json_token = _EXPECT_JSON_VAR.set(bool(question.expectJson))
        token = PROMPT_CACHE_PREFIX_VAR.set(self._prompt_cache_prefix(question))
        try:
            response = self.chat_string(
                question.getPrompt(),
                on_chunk=stream_cbs[0],
                on_finish=stream_cbs[1],
                on_reasoning_chunk=stream_cbs[2],
            )
        finally:
            PROMPT_CACHE_PREFIX_VAR.reset(token)
            _EXPECT_JSON_VAR.reset(json_token)

        # If JSON output is expected, validate the response and retry if needed.
        # Store the parsed result so setAnswer receives a dict/list directly —
        # avoiding a second parse through Answer.parseJson with the raw fenced string.
        parsed_response = None
        if question.expectJson:
            max_retries = 3

            for retry_count in range(max_retries):
                if not response.strip():
                    # Nothing to repair: the model wrote no text at all. A reasoning
                    # model does this when its output budget runs out mid-thought, and
                    # resending the same prompt cannot fit a budget that overflowed.
                    raise EmptyResponseError(
                        'model returned no text; it most likely used its whole output budget before '
                        f'replying. Raise modelOutputTokens (now {self.getOutputTokens()}), or disable '
                        'reasoning for this call'
                    )
                try:
                    # Parse (and strip any markdown fences) — reuse the result below
                    parsed_response = parseJson(response)

                    # Create the json answer and return it
                    answer = Answer(expectJson=True)
                    answer.setAnswer(parsed_response)
                    return answer

                # Listed before the generic arm below, which would otherwise swallow it —
                # ThinkTruncatedError IS a ValueError.
                except ThinkTruncatedError as e:
                    # Not a formatting mistake: the model never reached the JSON because it
                    # ran out of output budget mid-reasoning. The repair prompt tells it to
                    # "examine your JSON", which is the wrong instruction, and a resample
                    # rarely fits a budget that has already overflowed. So surface the cause
                    # now instead of buying two more model calls to arrive at a message that
                    # no longer names it.
                    debug(f'Error: {e}')
                    raise

                except (json.JSONDecodeError, ValueError) as e:
                    # JSON parsing failed
                    if retry_count < max_retries - 1:
                        debug(f'JSON validation failed on attempt {retry_count + 1}, retrying...')

                        # Retry the chat with the additional instruction
                        # This will again use chat_string with full network retry logic
                        json_token = _EXPECT_JSON_VAR.set(True)
                        try:
                            response = self.chat_string(question.getPrompt(has_previous_json_failed=True))
                        finally:
                            _EXPECT_JSON_VAR.reset(json_token)
                    else:
                        # Max retries reached, raise ValueError. Carry the last parse error:
                        # without it the caller sees only a truncated response and has to
                        # guess what was wrong with it.
                        error_msg = (
                            f'Failed to get valid JSON response after {max_retries} attempts. '
                            f'Cause: {e}. Last response: {response[:200]}...'
                        )
                        debug(f'Error: {error_msg}')
                        raise ValueError(error_msg) from e

        else:
            # Create the answer and assign the text
            answer = Answer(expectJson=False)
            answer.setAnswer(response)

            # And return it
            return answer
