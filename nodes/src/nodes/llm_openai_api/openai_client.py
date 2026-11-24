"""
OpenAI-compatible API binding for the ChatLLM.
Supports custom base_url for providers like Featherless, Together, Groq, Ollama, etc.
"""

import re
import threading
from typing import Any, Dict, Iterator, Tuple

from pydantic import PrivateAttr
from rocketlib import warning
from ai.common.chat import ChatBase, UNBOUND_MODEL
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

# The most models one client remembers a refused temperature for: it lives on the control's
# IGlobal, where a cache is bounded. A model it has forgotten is sent its temperature again,
# which costs one more refused request and the same retry.
_REMEMBERED_MODELS = 16


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


def _without_temperature(values: Dict[str, Any]) -> Dict[str, Any]:
    """Return a request's bound values with the temperature left out."""
    return {key: value for key, value in values.items() if key != 'temperature'}


class ChatOpenAI(_LangChainChatOpenAI):
    """
    ChatOpenAI that stops sending a temperature the endpoint does not accept.

    Models that run only at their own default (Claude Opus 4.7 and 4.8, the Claude 5
    models, OpenAI's reasoning models) answer a request that carries any other
    temperature with HTTP 400, and so does a gateway in front of one. A request refused
    that way is sent once more without a temperature. If it then goes through, this
    client remembers the request's model and sends that model's requests without a
    temperature for the rest of the run. If it is refused again, nothing is remembered
    and that second refusal is raised, not the first: it says what the endpoint still
    does not accept, and the shared layer (ai.common.llm_adapter) retries without `stop`
    or streaming usage only when it is handed the refusal that names them. Nothing here
    looks at the model name to decide: behind a gateway it is a deployment name. The name
    only keys what was learned, because one client serves every model a call names.

    The temperature is a call value, bound onto each request with the model
    (Chat.call_kwargs). The client itself is built without one, so leaving it out of a
    request's bound values leaves it out of the request.

    Only the sync methods are wrapped, because the engine drives a chat model through
    `invoke` and `stream` (ai.common.llm_adapter).

    The class keeps the name ChatOpenAI because ai.common.llm_tools.model_origin() tags a
    turn's reasoning state with the model class name and replays it only to that name.
    """

    # The models whose endpoint refused a temperature this run, oldest first
    _refused_temperature: Dict[str, None] = PrivateAttr(default_factory=dict)

    def _request_values(self, kwargs: Dict[str, Any]) -> Tuple[str, Dict[str, Any]]:
        """Return a request's model, and its bound values without a temperature that model's endpoint refused."""
        model = str(kwargs.get('model') or self.model_name)
        if model in self._refused_temperature:
            kwargs = _without_temperature(kwargs)
        return model, kwargs

    def _keep_temperature_dropped(self, model: str, refusal: Exception, sent: Any) -> None:
        """
        Stop sending the model's temperature: a request refused with it has gone through without it.

        Several pipeline threads can get here for requests that were in flight together;
        only the first one remembers the model and warns.
        """
        with _DROP_LOCK:
            if model not in self._refused_temperature:
                # The endpoint's own message is left out: some copy the request into it, prompt included.
                status = getattr(refusal, 'status_code', None)
                warning(
                    f'{model}: the endpoint rejected temperature={sent} '
                    f'({type(refusal).__name__}, HTTP {status}). The request went through without a '
                    f'temperature, so it is left out for the rest of this run.'
                )
                self._refused_temperature[model] = None
                while len(self._refused_temperature) > _REMEMBERED_MODELS:
                    del self._refused_temperature[next(iter(self._refused_temperature))]

    def _generate(self, messages: Any, stop: Any = None, run_manager: Any = None, **kwargs: Any) -> Any:
        """Send one request, and once more without a temperature if the endpoint rejects it."""
        model, kwargs = self._request_values(kwargs)
        sent = kwargs.get('temperature')
        try:
            return super()._generate(messages, stop=stop, run_manager=run_manager, **kwargs)
        except Exception as e:
            if sent is None or not rejects_temperature(e):
                raise
            refusal = e
        # The library's own method, so this second request is never sent a third time.
        # If it is refused, that refusal is the one raised (see the class docstring).
        result = super()._generate(messages, stop=stop, run_manager=run_manager, **_without_temperature(kwargs))
        self._keep_temperature_dropped(model, refusal, sent)
        return result

    def _stream(self, *args: Any, **kwargs: Any) -> Iterator[Any]:
        """Stream one request, and once more without a temperature if the endpoint rejects it."""
        model, kwargs = self._request_values(kwargs)
        sent = kwargs.get('temperature')
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
            chunks = super()._stream(*args, **_without_temperature(kwargs))
            try:
                first = next(chunks)
            except StopIteration:
                first = None
            # Reached only when the second request was accepted.
            self._keep_temperature_dropped(model, e, sent)
            if first is None:
                return
        yield first
        yield from chunks


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
        config = self._config

        # Get the api key and base url
        apikey = config.get('apikey')
        base_url = config.get('base_url') or None

        # Build kwargs for ChatOpenAI: one client for every call, each request
        # binds its model, max_tokens and temperature (call_kwargs)
        kwargs = {
            'model': UNBOUND_MODEL,
            'api_key': apikey,
        }
        if base_url:
            kwargs['base_url'] = base_url

        # Get the llm
        self._llm = ChatOpenAI(**kwargs)

    def call_kwargs(self) -> Dict[str, Any]:
        """
        Return this call's request values, its temperature included.

        0 unless the call's settings set a value; the Nebius preset declares no
        Temperature, so it sends 0. A value the endpoint does not accept is dropped
        by ChatOpenAI above.
        """
        kwargs = super().call_kwargs()
        settings = self.call.settings
        kwargs['temperature'] = settings['temperature'] if 'temperature' in settings else 0
        return kwargs

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
