"""
OpenAI-compatible API binding for the ChatLLM.
Supports custom base_url for providers like Featherless, Together, Groq, Ollama, etc.
"""

import re
import threading
from typing import Any, Dict, Iterator

from rocketlib import warning
from ai.common.chat import ChatBase
from ai.common.config import Config
from ai.common.llm_native_stream import PROMPT_CACHE_PREFIX_VAR, apply_prompt_cache_breakpoint
from ai.common.utils import parse_bool
from langchain_openai import ChatOpenAI as _LangChainChatOpenAI
from openai import APIError, APIStatusError, AuthenticationError, RateLimitError, APIConnectionError

# The parameter name as a word of its own: `temperature`, 'temperature', temperature=0.0.
_TEMPERATURE_WORD = re.compile(r'\btemperature\b', re.IGNORECASE)

# Statuses an endpoint answers a request it refuses as written: 400 from the providers and
# LiteLLM, 422 from FastAPI-based servers such as vLLM's.
_REJECTED_REQUEST_STATUSES = (400, 422)

# One client is shared by every pipeline thread of a run; the lock makes them drop the
# value, and warn about it, once.
_DROP_LOCK = threading.Lock()


def rejects_temperature(error: Exception) -> bool:
    """
    Tell whether an endpoint refused a request because of its temperature.

    OpenAI names the parameter in the error's `param`, which then decides. A FastAPI-based
    server lists what it refused: the field is the last step of an item's `loc`, or for a
    check on the whole request is named in its `msg`, or in a `message` beside the list;
    the `input` it copies back is not looked at. Anthropic's OpenAI-compatible endpoint,
    LiteLLM and gateways that wrap a provider's error name the parameter only somewhere in
    the error text.

    This leans towards yes. A wrong yes costs one more request on a call that was failing
    anyway and changes nothing (see ChatOpenAI). A wrong no leaves the endpoint unusable.
    So an error text that names the temperature anywhere counts, including a server that
    copies the request into its message: no attempt is made to tell that copy from a
    statement about the parameter, which may sit beside it.
    """
    if not isinstance(error, APIStatusError):
        return False
    if getattr(error, 'status_code', None) not in _REJECTED_REQUEST_STATUSES:
        return False
    param = getattr(error, 'param', None)
    if param:
        return param == 'temperature'
    body = getattr(error, 'body', None)
    detail = body.get('detail') if isinstance(body, dict) else None
    if isinstance(detail, list):
        items = [item for item in detail if isinstance(item, dict)]
        if any(
            list(item.get('loc') or [])[-1:] == ['temperature']
            or _TEMPERATURE_WORD.search(str(item.get('msg') or '')) is not None
            for item in items
        ):
            return True
        # Only the `message` beside the list: the whole error text carries the `input` copies.
        return _TEMPERATURE_WORD.search(str(body.get('message') or '')) is not None
    return _TEMPERATURE_WORD.search(str(error)) is not None


class ChatOpenAI(_LangChainChatOpenAI):
    """
    ChatOpenAI that stops sending a temperature the endpoint does not accept.

    Models that run only at their own default (Claude Opus 4.7 and 4.8, the Claude 5
    models, OpenAI's reasoning models) answer a request that carries any other
    temperature with HTTP 400, and so does a gateway in front of one. A request refused
    that way is sent once more without a temperature. If it then goes through, the value
    is dropped from this client and the run goes on without it. If it is refused again,
    the client keeps its value and that second refusal is raised, not the first: it says
    what the endpoint still does not accept, and the shared layer (ai.common.llm_adapter)
    retries without `stop` or streaming usage only when it is handed the refusal that
    names them. Nothing here looks at the model name: behind a gateway it is a deployment name.

    Only the sync methods are wrapped, because the engine drives a chat model through
    `invoke` and `stream` (ai.common.llm_adapter).

    The class keeps the name ChatOpenAI because ai.common.llm_tools.model_origin() tags a
    turn's reasoning state with the model class name and replays it only to that name.
    """

    def _without_temperature(self) -> 'ChatOpenAI':
        """Return a copy of this client that sends no temperature. It shares the connections."""
        return self.model_copy(update={'temperature': None})

    def _keep_temperature_dropped(self, refusal: Exception, sent: Any) -> None:
        """
        Stop sending the temperature: a request refused with it has gone through without it.

        Several pipeline threads can get here for requests that were in flight together;
        only the first one drops the value and warns.
        """
        with _DROP_LOCK:
            if self.temperature is not None:
                # The endpoint's own message is left out: some copy the request into it, prompt included.
                status = getattr(refusal, 'status_code', None)
                warning(
                    f'{self.model_name}: the endpoint rejected temperature={sent} '
                    f'({type(refusal).__name__}, HTTP {status}). The request went through without a '
                    f'temperature, so it is left out for the rest of this run.'
                )
                self.temperature = None

    def _generate(self, messages: Any, stop: Any = None, run_manager: Any = None, **kwargs: Any) -> Any:
        """Send one request, and once more without a temperature if the endpoint rejects it."""
        sent = self.temperature
        try:
            return super()._generate(messages, stop=stop, run_manager=run_manager, **kwargs)
        except Exception as e:
            if sent is None or not rejects_temperature(e):
                raise
            refusal = e
        # The library's own method, so this second request is never sent a third time.
        # If it is refused, that refusal is the one raised (see the class docstring).
        retry = self._without_temperature()
        result = _LangChainChatOpenAI._generate(retry, messages, stop=stop, run_manager=run_manager, **kwargs)
        self._keep_temperature_dropped(refusal, sent)
        return result

    def _stream(self, *args: Any, **kwargs: Any) -> Iterator[Any]:
        """Stream one request, and once more without a temperature if the endpoint rejects it."""
        sent = self.temperature
        chunks = super()._stream(*args, **kwargs)
        try:
            # The request goes out when the first chunk is pulled, so a rejection is
            # raised here, before anything has been yielded to the caller.
            first = next(chunks)
        except StopIteration:
            return
        except Exception as e:
            if sent is None or not rejects_temperature(e):
                raise
            chunks = _LangChainChatOpenAI._stream(self._without_temperature(), *args, **kwargs)
            try:
                first = next(chunks)
            except StopIteration:
                first = None
            # Reached only when the second request was accepted.
            self._keep_temperature_dropped(e, sent)
            if first is None:
                return
        yield first
        yield from chunks


class _CacheBoundaryChatOpenAI(ChatOpenAI):
    """ChatOpenAI that sends the cacheable start of the prompt as its own content part.

    The split is the Anthropic driver's, without its marker: what to mark is left to
    the gateway in front of the model, and a plain endpoint would reject the field.
    """

    def _get_request_payload(self, input_, *, stop=None, **kwargs):
        payload = super()._get_request_payload(input_, stop=stop, **kwargs)
        apply_prompt_cache_breakpoint(payload, PROMPT_CACHE_PREFIX_VAR.get())
        messages = payload.get('messages') or []
        content = messages[-1].get('content') if messages else None
        if isinstance(content, list):
            for part in content:
                part.pop('cache_control', None)
        return payload


class Chat(ChatBase):
    """
    Create an OpenAI-compatible API chat bot with custom base_url support.
    """

    _llm: ChatOpenAI

    SUPPORTS_NATIVE_TOOLS = True

    def __init__(self, provider: str, connConfig: Dict[str, Any], bag: Dict[str, Any]):
        """
        Initialize the OpenAI-compatible chat bot.
        """
        # Init the base
        super().__init__(provider, connConfig, bag)

        # Get the nodes configuration
        config = Config.getNodeConfig(provider, connConfig)

        # Get the api key and base url
        apikey = config.get('apikey')
        base_url = config.get('base_url') or None

        # Build kwargs for ChatOpenAI
        kwargs = {
            'model': self._model,
            'api_key': apikey,
            # 0 unless the node sets a value. A value the endpoint does not accept is
            # dropped by ChatOpenAI above.
            'temperature': config['temperature'] if 'temperature' in config else 0,
            'max_tokens': self._modelOutputTokens,
        }
        if base_url:
            kwargs['base_url'] = base_url

        # Off by default: some endpoints accept only a string as message content.
        send_boundary = parse_bool(config.get('cachePrefixParts'))
        self.SUPPORTS_PROMPT_CACHE_PREFIX = send_boundary

        # Get the llm. Turns stay on the plain class: reasoning is replayed only to the
        # class that wrote it, so the option must not change which class that is.
        self._plain_llm = ChatOpenAI(**kwargs)
        self._llm = _CacheBoundaryChatOpenAI(**kwargs) if send_boundary else self._plain_llm

        # Save our chat class into the bag
        bag['chat'] = self

    def _turn_llm(self) -> ChatOpenAI:
        return self._plain_llm

    def chat_turn(self, question, *args, **kwargs):
        """Send a turn unmarked: ChatBase would add cache_control, which this node never sends.

        Args:
            question: The turn-mode Question.
            *args: Passed on to ChatBase.chat_turn.
            **kwargs: Passed on to ChatBase.chat_turn.

        Returns:
            The model's Answer.
        """
        return super().chat_turn(question.model_copy(update={'cachePrefix': False}), *args, **kwargs)

    def is_retryable_error(self, error):
        """
        Determine if the error is retryable.
        """
        if isinstance(error, (AuthenticationError, APIError)):
            return False
        if isinstance(error, (RateLimitError, APIConnectionError)):
            return True
        return super().is_retryable_error(error)

    def map_exception(self, error):
        """
        Convert unfriendly openai exceptions to friendlier ones.
        """
        if isinstance(error, AuthenticationError):
            return ValueError('Invalid API key.')
        if isinstance(error, APIError):
            return ValueError('An error occurred with the API.')
        if isinstance(error, RateLimitError):
            return ValueError('Rate limit exceeded. Please try again later.')
        if isinstance(error, APIConnectionError):
            return ValueError('Failed to connect to the API.')
        return super().map_exception(error)
