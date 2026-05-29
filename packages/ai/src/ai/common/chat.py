"""
ChatBase - Abstract Base Class for AI Chat Drivers.

This module provides the foundation for all chat-based AI drivers in the system.
It handles token management, configuration loading, and provides a consistent
interface for interacting with different AI providers.

The ChatBase class is designed to be subclassed by specific AI provider
implementations (e.g., OpenAI, Anthropic, etc.) that handle the actual
communication with their respective APIs.
"""

import logging
import time
import json
import importlib
from typing import Dict, Any
from rocketlib import debug

# Telemetry logger — emits METRIC-prefixed structured lines (MIME + counts
# only, never filenames or paths) to the standard logger so attachment volume
# is recoverable from production logs. No metrics adapter consumes these yet.
_telemetry_logger = logging.getLogger(__name__)
from ai.common.schema import Answer, Question
from ai.common.config import Config
from ai.common.util import parseJson
from ai.common.validation import validate_model_name, validate_max_tokens, validate_prompt


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

    def chat_string(self, prompt: str) -> str:
        """
        Invoke the chat interface with string input, token management, and network retry handling.

        This is the main entry point for chat operations using raw string prompts.
        It handles token counting, limit checking, network retries, and provides
        warnings for potential issues like truncation.

        The method performs the following steps:
        1. Count tokens in the input prompt
        2. Check if prompt exceeds safe limits
        3. Call the provider-specific chat implementation with retry logic
        4. Count tokens in the response
        5. Check for potential truncation
        6. Return the result

        Args:
            prompt (str): The complete prompt to send to the model

        Returns:
            str: The model's response

        Warnings:
            - Issues debug warning if prompt is too long
            - Issues debug warning if response appears truncated

        Raises:
            Exception: If network/API retries are exhausted or non-retryable
                      errors occur
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

        # Call the chat implementation with network retry logic
        # This is where the real communication with the AI provider happens
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

    def _chat_with_attachments(self, question: Question, attachments) -> str:
        """Dispatch a Question with attachments through the provider-shape translator.

        Picks the translator by ``self.provider_shape``, reads each
        attachment's bytes via the per-account FileStore, builds the
        provider-native content blocks, and invokes ``_chat_blocks``.
        Unsupported MIMEs drop+warn; FileStore IO errors propagate.
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
                _telemetry_logger.info(
                    'METRIC attachment.dropped_unsupported provider=%s mime=%s',
                    d.provider,
                    d.mime,
                )

        def _log_forwarded(kept_mimes):
            # One emission per surviving attachment per send, tagged with
            # provider + per-attachment MIME so it can be aggregated by both.
            for mime in kept_mimes:
                _telemetry_logger.info(
                    'METRIC llm.attachment_forwarded provider=%s mime=%s',
                    self._provider,
                    mime,
                )

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

        file_store = self._get_file_store()
        blocks, dropped = translate(prompt_text, attachments, file_store, self._provider)
        _log_drops(dropped)
        _log_forwarded(_kept_mimes(attachments, dropped))
        return self._chat_blocks(blocks)

    def chat(self, question: Question) -> Answer:
        """
        Chat using structured Question/Answer objects with JSON validation and network retry handling.

        This method provides a robust interface that works with the application's
        schema objects. It handles network failures, rate limits, and other
        transient errors by retrying the request with exponential backoff.

        If the question expects JSON output, this method will also validate the
        response and retry with additional instructions if the JSON is invalid.

        Args:
            question (Question): A Question object containing the prompt and
                               metadata (e.g., whether JSON output is expected)

        Returns:
            Answer: An Answer object containing the response and preserving
                   the original question's metadata

        Raises:
            ValueError: If expectJson is True and valid JSON cannot be obtained
                       after multiple retry attempts
            Exception: If network/API retries are exhausted or non-retryable
                      errors occur
        """
        # Per-shape attachment dispatch. Backwards-compatible:
        # text-only Questions take the existing single-string fast path so no
        # production behavior changes until per-node shapes are wired.
        # FileStore IO errors raise; unsupported MIMEs drop+warn.
        attachments = list(getattr(question, 'attachments', []) or [])
        # Emit count_per_message on every send (including
        # zero) so the orphan-volume signal (upload_starts − Σ counts) is
        # computable from production logs without a reaper in v1.
        _telemetry_logger.info(
            'METRIC attachment.count_per_message provider=%s count=%d',
            getattr(self, '_provider', 'unknown'),
            len(attachments),
        )
        if attachments:
            response = self._chat_with_attachments(question, attachments)
        else:
            # Use chat_string which already handles network retries and token management
            response = self.chat_string(question.getPrompt())

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
