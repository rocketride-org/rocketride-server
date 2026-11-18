# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Hosted OpenAI models for a run whose OpenAI node has no key.

A hosted engine asks its backend for a per-run pass when the pipeline has an
OpenAI node with no key, and hands it to the task as ``ROCKETRIDE_MODEL_GATEWAY``
(a JSON object: ``provider``, ``base_url``, ``token``, ``expires_at``, and the
run's limits ``max_concurrent_calls`` and ``max_output_tokens``). The two OpenAI
nodes then build their clients with the pass token as the key and the pass URL
as the base URL. A node with its own key never uses the pass.

It imports nothing heavy at load: the task engine imports it in the server
process. This module holds the pieces both sides share:

- ``wants_hosted_openai``: the engine's yes-or-no, read from the pipeline a run
  starts with.
- ``read_pass`` and ``resolve_openai_credentials``: what a node builds its
  clients with.
- ``friendly_gateway_error`` and ``HostedModelError``: the sentence a user reads
  when the hosted backend refuses a call.

No message here contains ``*``: the engine splits error text on it.
"""

import asyncio
import copy
import json
import os
import random
import re
import sys
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Mapping, NamedTuple, Optional
from urllib.parse import urlsplit

# What the engine puts in a task's environment, and nothing else sets.
GATEWAY_ENV = 'ROCKETRIDE_MODEL_GATEWAY'

# The error type a hosted model backend puts on its own refusals. Such a refusal
# is final: sending the request again, with or without a flag, cannot change it.
HOSTED_REFUSAL_TYPE = 'rocketride_gateway_error'

# The only host a pass may point at: the backend serves hosted models on
# loopback in the engine's own process. Not 'localhost', which can resolve to ::1.
GATEWAY_HOST = '127.0.0.1'

# The node types that can run on hosted models. Presets built on the same drivers
# (llm_nebius runs on llm_openai_api) are not among them and keep their own settings.
OPENAI_PROVIDERS = ('llm_openai', 'llm_openai_api')
_COMPATIBLE_PROVIDER = 'llm_openai_api'

# How often the engine renews a running task's pass.
PASS_RENEW_INTERVAL_S = 6 * 3600

# The backend's code for a run it gives no pass because it is a team deployment.
TEAM_DEPLOYMENT_CODE = 'team_deployment_not_supported'

# A run's calls at once on hosted models when the pass does not say.
DEFAULT_MAX_CONCURRENT_CALLS = 4

# How long a call keeps retrying a busy answer (rate_limited) the backend did not charge.
RATE_LIMIT_DEADLINE_S = 600.0
_RATE_LIMIT_FIRST_DELAY_S = 1.0
_RATE_LIMIT_MAX_DELAY_S = 30.0

# How deep the keyless check follows groups (a component's config.pipeline.components).
_MAX_DEPTH = 8

# The hosted server's own launch flag (a task gets --hosted instead).
_SERVER_HOSTED_FLAG = '--saas'

_NO_KEY_HOSTED = (
    "{node}: no API key is set, and RocketRide-hosted models aren't available for this run. "
    'Add your OpenAI key in the node settings. To keep the key out of the pipeline, save it in RocketRide '
    "under Settings > Variables as ROCKETRIDE_OPENAI_KEY and enter ${{ROCKETRIDE_OPENAI_KEY}} as the node's API key."
)
_NO_KEY_SELF_HOSTED = (
    '{node}: no API key is set. Add your OpenAI key in the node settings. To keep the key out of the '
    'pipeline, save it in RocketRide under Settings > Variables as ROCKETRIDE_OPENAI_KEY and enter '
    "${{ROCKETRIDE_OPENAI_KEY}} as the node's API key."
)
# A compatible node with an endpoint of its own never runs on hosted models.
_NO_KEY_OWN_ENDPOINT = '{node}: no API key is set. Add the API key for your endpoint in the node settings.'

_UNAVAILABLE = (
    'RocketRide-hosted models are unavailable right now. Try again shortly, '
    'or add your own OpenAI key in the node settings.'
)

# The sentence for each code the hosted backend refuses a call with. The backend
# writes the same sentences in error.message.
REFUSAL_SENTENCES = {
    'insufficient_credits': (
        "This workspace doesn't have enough compute credits left for this request on RocketRide-hosted models. "
        'Add your own OpenAI key in the node settings. A workspace admin can also manage compute credits '
        'under Account > Billing in RocketRide.'
    ),
    'rate_limited': (
        'This run has too many requests running at once on RocketRide-hosted models. '
        'Try again with fewer requests at once, or add your own OpenAI key in the node settings.'
    ),
    'model_not_available': (
        "The model {model} isn't offered as a RocketRide-hosted model. Choose another model in the node "
        'settings, or add your own OpenAI key there.'
    ),
    'invalid_gateway_pass': "This run's access to RocketRide-hosted models has ended. Start the pipeline again.",
    'gateway_unavailable': _UNAVAILABLE,
    'upstream_unavailable': _UNAVAILABLE,
    'request_too_large': (
        'This request is too large for RocketRide-hosted models. Shorten the input, '
        'or add your own OpenAI key in the node settings.'
    ),
    'unsupported_parameter': (
        "RocketRide-hosted models don't support {field}. "
        'Add your own OpenAI key in the node settings to run this request.'
    ),
    'invalid_request': (
        "RocketRide-hosted models couldn't accept this request. Check the node settings, then run the pipeline again."
    ),
    TEAM_DEPLOYMENT_CODE: "Hosted models aren't available for team deployments yet. Add your own OpenAI key to the node.",
}
# Any other refusal. Its code stays out of the sentence (a code can name internals); it is in the log.
_OTHER_REFUSAL = (
    "RocketRide-hosted models couldn't run this request. Try again shortly, or add your own OpenAI key in the "
    'node settings.'
)

# The backend's own sentences, read back for the value it filled in.
_MODEL_IN_MESSAGE = re.compile(r"^The model (.+?) isn't offered as a RocketRide-hosted model\.")
_FIELD_IN_MESSAGE = re.compile(r"^RocketRide-hosted models don't support (.+?)\. Add your own OpenAI key")
# Used when neither the request nor the refusal names the field or the model.
_SOME_FIELD = 'a feature this request uses'
_SOME_MODEL = 'you chose'


class HostedModelError(RuntimeError):
    """A hosted backend refused a model call. The message is the sentence the user reads.

    Not a ValueError on purpose: ChatBase.chat repairs a ValueError by asking the
    model again, and a refusal must reach the user as it is.
    """


class MissingModelKeyError(ValueError):
    """An OpenAI node has no key and nothing else can serve it."""


@dataclass(frozen=True)
class GatewayPass:
    """A run's pass for hosted models, as the engine delivered it."""

    provider: str
    base_url: str
    token: str = field(repr=False)
    expires_at: float
    # The run's limits on hosted models. None: the backend sets no output limit.
    max_concurrent_calls: int = DEFAULT_MAX_CONCURRENT_CALLS
    max_output_tokens: Optional[int] = None


class OpenAICredentials(NamedTuple):
    """What an OpenAI node builds its clients with."""

    apikey: Any
    base_url: Any
    hosted: bool
    # The pass, when the node runs on it
    gateway: Optional[GatewayPass] = None


def _is_hosted() -> bool:
    """True when this process is a task of a hosted engine."""
    from hosting import is_hosted

    return is_hosted()


def _valid_base_url(value: Any) -> bool:
    """An http URL on 127.0.0.1 with a port, and nothing that could send it elsewhere."""
    if not isinstance(value, str) or not value or value != value.strip():
        return False
    try:
        parts = urlsplit(value)
        port = parts.port
    except ValueError:
        return False
    return (
        parts.scheme == 'http'
        and parts.hostname == GATEWAY_HOST
        and port is not None
        and parts.username is None
        and parts.password is None
        and not parts.query
        and not parts.fragment
    )


def read_pass(environ: Optional[Mapping[str, str]] = None) -> Optional[GatewayPass]:
    """Return this task's pass for hosted models, or None.

    None unless ``ROCKETRIDE_MODEL_GATEWAY`` holds a JSON object with provider
    ``openai``, a ``base_url`` that is ``http`` on ``127.0.0.1`` with a port, a
    non-empty token and a numeric ``expires_at``. A past ``expires_at`` is not
    checked here: the engine renews the pass with the backend, which decides.
    """
    raw = (environ if environ is not None else os.environ).get(GATEWAY_ENV, '').strip()
    if not raw:
        return None
    try:
        data = json.loads(raw)
    except ValueError:
        return None
    if not isinstance(data, dict) or data.get('provider') != 'openai':
        return None
    base_url, token, expires_at = data.get('base_url'), data.get('token'), data.get('expires_at')
    if not _valid_base_url(base_url):
        return None
    if not isinstance(token, str) or not token or any(c.isspace() for c in token):
        return None
    if isinstance(expires_at, bool) or not isinstance(expires_at, (int, float)):
        return None
    calls, output = _positive_int(data.get('max_concurrent_calls')), _positive_int(data.get('max_output_tokens'))
    return GatewayPass(
        provider='openai',
        base_url=base_url,
        token=token,
        expires_at=float(expires_at),
        max_concurrent_calls=calls or DEFAULT_MAX_CONCURRENT_CALLS,
        max_output_tokens=output,
    )


def no_pass_marker(refusal: Any) -> dict:
    """What the engine puts in a task the backend refused a pass: the refusal's type and code only."""
    error = refusal.get('error') if isinstance(refusal, dict) else None
    code = error.get('code') if isinstance(error, dict) else None
    return {'error': {'type': HOSTED_REFUSAL_TYPE, 'code': code if isinstance(code, str) else ''}}


def _no_pass_reason(environ: Optional[Mapping[str, str]] = None) -> str:
    """The backend's code for refusing this task a pass ('' when it gave none)."""
    try:
        data = json.loads((environ if environ is not None else os.environ).get(GATEWAY_ENV, '') or '{}')
    except ValueError:
        return ''
    error = data.get('error') if isinstance(data, dict) else None
    code = error.get('code') if isinstance(error, dict) and error.get('type') == HOSTED_REFUSAL_TYPE else None
    return code if isinstance(code, str) else ''


def _positive_int(value: Any) -> Optional[int]:
    """``value`` when it is a whole number above 0, else None."""
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        return None
    return value


def _is_empty(value: Any) -> bool:
    """True for a key or URL that is missing, not a string, or only white space."""
    return not isinstance(value, str) or not value.strip()


def resolve_openai_credentials(logical_type: str, apikey: Any, base_url: Any = '') -> OpenAICredentials:
    """Choose the key and base URL an OpenAI node builds its clients with.

    - A node with its own key uses it, with its own base URL.
    - On a hosted task, a node with no key uses the run's pass. For
      ``llm_openai_api`` only when the node has no base URL of its own: the pass
      goes nowhere but the hosted backend. With no pass, or with a base URL, it
      fails with a message (one that names the node's own endpoint when it has
      one), so a hosted task never builds a client with no key.
    - On a self-hosted engine, ``llm_openai`` with no key and no
      ``OPENAI_API_KEY`` fails with a message. Every other case is unchanged.

    Any other node type on these drivers (a preset such as ``llm_nebius``) gets
    its own settings back unchanged.

    Raises:
        MissingModelKeyError: no key, and nothing else can serve this node.
    """
    if logical_type not in OPENAI_PROVIDERS or not _is_empty(apikey):
        return OpenAICredentials(apikey, base_url, False)

    if _is_hosted():
        gateway = read_pass()
        if logical_type == _COMPATIBLE_PROVIDER and not _is_empty(base_url):
            raise MissingModelKeyError(_NO_KEY_OWN_ENDPOINT.format(node=logical_type))
        if gateway is not None:
            return OpenAICredentials(gateway.token, gateway.base_url, True, gateway)
        if _no_pass_reason() == TEAM_DEPLOYMENT_CODE:
            raise MissingModelKeyError(REFUSAL_SENTENCES[TEAM_DEPLOYMENT_CODE])
        raise MissingModelKeyError(_NO_KEY_HOSTED.format(node=logical_type))

    if logical_type != _COMPATIBLE_PROVIDER and _is_empty(os.environ.get('OPENAI_API_KEY')):
        raise MissingModelKeyError(_NO_KEY_SELF_HOSTED.format(node=logical_type))
    return OpenAICredentials(apikey, base_url, False)


# One limit for every hosted call this process makes: a task runs one run, so one pass.
_gate_lock = threading.Lock()
_gate: Optional[threading.BoundedSemaphore] = None


def _run_gate(limit: int) -> threading.BoundedSemaphore:
    """The process's semaphore for hosted calls, sized by the first pass that asks."""
    global _gate
    with _gate_lock:
        if _gate is None:
            _gate = threading.BoundedSemaphore(limit)
        return _gate


def _retry_busy(response: Any) -> bool:
    """True for a busy answer the backend did not charge: rate_limited without ``x-should-retry: false``."""
    if response.status_code != 429 or response.headers.get('x-should-retry', '').lower() == 'false':
        return False
    try:
        error = response.json().get('error')
    except Exception:
        return False
    return isinstance(error, dict) and error.get('type') == HOSTED_REFUSAL_TYPE and error.get('code') == 'rate_limited'


def _busy_delay(attempt: int) -> float:
    """Exponential backoff with jitter for the next try after a busy answer."""
    delay = min(_RATE_LIMIT_FIRST_DELAY_S * (2**attempt), _RATE_LIMIT_MAX_DELAY_S)
    return delay * (0.5 + random.random() / 2)


def _acquire_by(gate: threading.BoundedSemaphore, deadline: float) -> bool:
    """Take a slot before ``deadline`` (a monotonic time), or none: a slot that comes late is given back."""
    remaining = deadline - time.monotonic()
    if remaining <= 0 or not gate.acquire(timeout=remaining):
        return False
    if time.monotonic() >= deadline:
        gate.release()
        return False
    return True


async def _acquire_async(gate: threading.BoundedSemaphore, deadline: Optional[float]) -> bool:
    """Take a slot without blocking the event loop, before ``deadline`` (a monotonic
    time) or with no limit. Polls, so a cancelled wait holds nothing, and a slot that
    comes late is given back.
    """
    while True:
        if deadline is not None and time.monotonic() >= deadline:
            return False
        if gate.acquire(blocking=False):
            if deadline is not None and time.monotonic() >= deadline:
                gate.release()
                return False
            return True
        pause = 0.05 if deadline is None else min(0.05, max(0.0, deadline - time.monotonic()))
        await asyncio.sleep(pause)


def _gated_transport_types():
    """The two transports, built on first use so loading this module never imports httpx."""
    import httpx

    class ReleaseOnClose(httpx.SyncByteStream, httpx.AsyncByteStream):
        """A response body that frees the call's slot once: when it is read to the end, or closed."""

        def __init__(self, stream: Any, release: Callable[[], None]):
            self._stream, self._release, self._done = stream, release, False

        def _free(self) -> None:
            if not self._done:
                self._done = True
                self._release()

        def __iter__(self):
            try:
                yield from self._stream
            finally:
                self._free()

        async def __aiter__(self):
            try:
                async for chunk in self._stream:
                    yield chunk
            finally:
                self._free()

        def close(self) -> None:
            try:
                self._stream.close()
            finally:
                self._free()

        async def aclose(self) -> None:
            try:
                await self._stream.aclose()
            finally:
                self._free()

    class GatedTransport(httpx.BaseTransport):
        """Holds one of the run's slots from a request until its body is done, and
        retries an uncharged busy answer with backoff, never past the deadline.
        """

        def __init__(self, gate: threading.BoundedSemaphore, deadline_s: float):
            self._inner, self._gate, self._deadline_s = httpx.HTTPTransport(), gate, deadline_s

        def handle_request(self, request):
            deadline, attempt = time.monotonic() + self._deadline_s, 0
            self._gate.acquire()
            while True:
                try:
                    response = self._inner.handle_request(request)
                    if response.status_code == 429:
                        response.read()
                except BaseException:
                    self._gate.release()
                    raise
                delay = _busy_delay(attempt)
                if _retry_busy(response) and time.monotonic() + delay < deadline:
                    self._gate.release()
                    time.sleep(delay)
                    attempt += 1
                    if _acquire_by(self._gate, deadline):
                        continue
                    # No slot before the deadline: the last busy answer, already read, holds none
                    return response
                return _finish(response, self._gate)

        def close(self) -> None:
            self._inner.close()

    class AsyncGatedTransport(httpx.AsyncBaseTransport):
        """The same for an async client, on the same semaphore. It takes a slot without
        blocking the event loop, and a cancelled wait never keeps one.
        """

        def __init__(self, gate: threading.BoundedSemaphore, deadline_s: float):
            self._inner, self._gate, self._deadline_s = httpx.AsyncHTTPTransport(), gate, deadline_s

        async def handle_async_request(self, request):
            deadline, attempt = time.monotonic() + self._deadline_s, 0
            await _acquire_async(self._gate, None)
            while True:
                try:
                    response = await self._inner.handle_async_request(request)
                    if response.status_code == 429:
                        await response.aread()
                except BaseException:
                    self._gate.release()
                    raise
                delay = _busy_delay(attempt)
                if _retry_busy(response) and time.monotonic() + delay < deadline:
                    self._gate.release()
                    await asyncio.sleep(delay)
                    attempt += 1
                    if await _acquire_async(self._gate, deadline):
                        continue
                    return response
                return _finish(response, self._gate)

        async def aclose(self) -> None:
            await self._inner.aclose()

    def _finish(response, gate):
        """Hand back a response holding its slot until its body is done."""
        if response.is_closed:
            # Already read (a refusal's body): the call is over
            gate.release()
        else:
            response.stream = ReleaseOnClose(response.stream, gate.release)
        return response

    return GatedTransport, AsyncGatedTransport


def hosted_http_clients(gateway: GatewayPass) -> dict:
    """HTTP clients for calls on the run's pass, as ``http_client`` and ``http_async_client``.

    They keep the OpenAI SDK's own defaults and ignore proxy variables from the
    environment, so the pass goes straight to the hosted backend on loopback and
    never to a proxy. Every call holds one of the run's slots
    (``gateway.max_concurrent_calls``, shared by every client in this process)
    until its response is closed, and a busy answer the backend did not charge
    is tried again with backoff for up to ``RATE_LIMIT_DEADLINE_S``. Close them
    with ``close_http_clients``.
    """
    import openai

    gate = _run_gate(gateway.max_concurrent_calls)
    gated, async_gated = _gated_transport_types()
    return {
        'http_client': openai.DefaultHttpxClient(trust_env=False, transport=gated(gate, RATE_LIMIT_DEADLINE_S)),
        'http_async_client': openai.DefaultAsyncHttpxClient(
            trust_env=False, transport=async_gated(gate, RATE_LIMIT_DEADLINE_S)
        ),
    }


def close_http_clients(clients: dict) -> None:
    """Close the clients ``hosted_http_clients`` built. Errors are ignored."""
    sync, async_client = clients.get('http_client'), clients.get('http_async_client')
    if sync is not None:
        try:
            sync.close()
        except Exception:
            pass
    if async_client is not None:
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = None
        try:
            if loop is None:
                asyncio.run(async_client.aclose())
            else:
                loop.create_task(async_client.aclose())
        except Exception:
            pass


def hosted_output_tokens(node: str, requested: int, gateway: Optional[GatewayPass]) -> int:
    """The output limit a node asks hosted models for: its own, or the pass's
    ``max_output_tokens`` when that is lower (logged once per node).
    """
    limit = gateway.max_output_tokens if gateway is not None else None
    if limit is None or not isinstance(requested, int) or requested <= limit:
        return requested
    from rocketlib import debug

    debug(f'{node}: output limit lowered from {requested} to {limit} tokens, the most RocketRide-hosted models allow')
    return limit


def stream_lost_error() -> 'HostedModelError':
    """The error for a hosted call whose stream failed after the backend took it: no second request follows."""
    return HostedModelError(_OTHER_REFUSAL)


def hosted_engine() -> bool:
    """True in a hosted engine's server process or one of its tasks.

    A save-time check can run in the server process itself, which carries the
    server's ``--saas`` flag rather than a task's ``--hosted``.
    """
    return _is_hosted() or _SERVER_HOSTED_FLAG in sys.argv


def missing_key_message(logical_type: str) -> Optional[str]:
    """For a save-time check: the message for a node with no key, or None.

    Only a self-hosted ``llm_openai`` with no ``OPENAI_API_KEY`` gets one. A
    hosted engine has no pass while a node is checked, so it says nothing there.
    """
    if logical_type == _COMPATIBLE_PROVIDER or hosted_engine():
        return None
    if _is_empty(os.environ.get('OPENAI_API_KEY')):
        return _NO_KEY_SELF_HOSTED.format(node=logical_type)
    return None


def _clean(value: Any, limit: int = 120) -> str:
    """A value fit for a message: text on one line, no '*', not too long."""
    if not isinstance(value, str):
        return ''
    text = ' '.join(value.replace('*', '').split())
    return text[:limit]


def friendly_gateway_error(error: BaseException, model: str = '') -> Optional[str]:
    """Return the sentence for a hosted backend's refusal, or None for any other error.

    Args:
        error: What the OpenAI SDK raised. A refusal has
            ``error.type == 'rocketride_gateway_error'`` in its body.
        model: The model the node asked for, named in the "isn't offered" sentence.
    """
    # Imported here: the task engine imports this module, and the adapter's
    # imports are heavier than the server process needs
    from ai.common.llm_adapter import hosted_refusal_body

    body = hosted_refusal_body(error)
    if body is None:
        return None
    code = body.get('code') if isinstance(body.get('code'), str) else ''
    message = body.get('message') if isinstance(body.get('message'), str) else ''
    sentence = REFUSAL_SENTENCES.get(code)
    if sentence is None:
        return _OTHER_REFUSAL
    if code == 'model_not_available':
        found = _MODEL_IN_MESSAGE.match(message)
        name = _clean(model) or (_clean(found.group(1)) if found else '') or _SOME_MODEL
        return sentence.format(model=name)
    if code == 'unsupported_parameter':
        # The backend's own sentence names what is not supported in plain words; a raw
        # parameter name would mean nothing to the user, so `param` stays in the log only
        found = _FIELD_IN_MESSAGE.match(message)
        name = (_clean(found.group(1)) if found else '') or _SOME_FIELD
        return sentence.format(field=name)
    return sentence


def _components(container: Any) -> list:
    """The component list of a pipeline or a group, or nothing."""
    if not isinstance(container, dict):
        return []
    components = container.get('components')
    return components if isinstance(components, list) else []


def _is_keyless(provider: str, settings: Any, served: Optional[Callable[[str], Any]] = None) -> bool:
    """True for an OpenAI node whose effective settings have no key (and, for
    ``llm_openai_api``, no base URL). Settings the resolver cannot read count as keyed.
    ``served`` gives the definition of a node the engine serves but has not unpacked.
    """
    if not isinstance(settings, dict):
        return False
    from ai.common.config import Config

    try:
        config = Config.getNodeConfig(provider, settings, served(provider) if served is not None else None)
    except Exception:
        return False
    if not _is_empty(config.get('apikey')):
        return False
    return provider != _COMPATIBLE_PROVIDER or _is_empty(config.get('base_url'))


def _any_keyless(components: list, depth: int, served: Optional[Callable[[str], Any]]) -> bool:
    """Walk components and their groups, to a depth of _MAX_DEPTH."""
    if depth >= _MAX_DEPTH:
        return False
    for component in components:
        if not isinstance(component, dict):
            continue
        settings = component.get('config')
        if component.get('provider') in OPENAI_PROVIDERS and _is_keyless(component['provider'], settings or {}, served):
            return True
        if isinstance(settings, dict) and _any_keyless(_components(settings.get('pipeline')), depth + 1, served):
            return True
    return False


def wants_hosted_openai(pipeline: Any, served: Optional[Callable[[str], Any]] = None) -> bool:
    """True when the pipeline has an OpenAI node that would run with no key.

    That is an ``llm_openai`` node with an empty ``apikey``, or an
    ``llm_openai_api`` node with an empty ``apikey`` and an empty ``base_url``,
    read the way the node reads them (``Config.getNodeConfig``, so a key in the
    profile block counts). Secure parameters are decoded on a copy first, so a
    key inside one is seen; the copy is dropped before this returns, and the
    input is never changed. A ``${ROCKETRIDE_...}`` left unfilled is a key, so
    that node keeps its own message. Pass the resolved pipeline the run starts, and
    ``served`` (``node_store.served``) for nodes not unpacked yet.

    Returns False when decoding fails.
    """
    if not isinstance(pipeline, dict):
        return False
    try:
        from rocketlib import resolveSecureParameters

        decoded = resolveSecureParameters(copy.deepcopy(pipeline))
    except Exception:
        return False
    try:
        return _any_keyless(_components(decoded), 0, served)
    finally:
        del decoded
