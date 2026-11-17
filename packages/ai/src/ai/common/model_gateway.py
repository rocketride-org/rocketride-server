# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Hosted OpenAI models for a run whose OpenAI node has no key.

A hosted engine asks its backend for a per-run pass when the pipeline has an
OpenAI node with no key, and hands it to the task as ``ROCKETRIDE_MODEL_GATEWAY``
(a JSON object: ``provider``, ``base_url``, ``token``, ``expires_at``). The two
OpenAI nodes then build their clients with the pass token as the key and the
pass URL as the base URL. A node with its own key never uses the pass.

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

import copy
import json
import os
import re
import sys
import time
from dataclasses import dataclass, field
from typing import Any, Mapping, NamedTuple, Optional
from urllib.parse import urlsplit

# What the engine puts in a task's environment, and nothing else sets.
GATEWAY_ENV = 'ROCKETRIDE_MODEL_GATEWAY'

# The only host a pass may point at: the backend serves hosted models on
# loopback in the engine's own process. Not 'localhost', which can resolve to ::1.
GATEWAY_HOST = '127.0.0.1'

# The nodes that can run on hosted models, and the field that names their key.
OPENAI_PROVIDERS = ('llm_openai', 'llm_openai_api')
_COMPATIBLE_PROVIDER = 'llm_openai_api'

# How deep the keyless check follows groups (a component's config.pipeline.components).
_MAX_DEPTH = 8

# The hosted server's own launch flag (a task gets --hosted instead).
_SERVER_HOSTED_FLAG = '--saas'

_NO_KEY_HOSTED = (
    "{node}: no API key is set, and RocketRide-hosted models aren't available for this run. "
    'Add your OpenAI key in the node settings, or save it in Settings > Variables as ROCKETRIDE_OPENAI_KEY '
    'and set apikey to ${{ROCKETRIDE_OPENAI_KEY}}.'
)
_NO_KEY_SELF_HOSTED = (
    '{node}: no API key is set. Add your OpenAI key in the node settings, or save it in Settings > Variables '
    'as ROCKETRIDE_OPENAI_KEY and set apikey to ${{ROCKETRIDE_OPENAI_KEY}}.'
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
        'Add your own OpenAI key in the node settings, or ask a workspace admin to check compute credits '
        'under Account > Billing in RocketRide.'
    ),
    'rate_limited': 'RocketRide-hosted models are busy with other requests from this run. Try again shortly.',
    'model_not_available': (
        "The model {model} isn't offered as a RocketRide-hosted model. Choose another model, "
        'or add your own OpenAI key in the node settings.'
    ),
    'invalid_gateway_pass': "This run's access to RocketRide-hosted models has ended. Start the pipeline again.",
    'gateway_unavailable': _UNAVAILABLE,
    'upstream_unavailable': _UNAVAILABLE,
    'request_too_large': (
        'This request is too large for RocketRide-hosted models. Send less text, '
        'or add your own OpenAI key in the node settings.'
    ),
    'unsupported_parameter': (
        "RocketRide-hosted models don't support {field}. "
        'Add your own OpenAI key in the node settings to run this request.'
    ),
}
# Any other refusal. Its code stays out of the sentence (a code can name internals); it is in the log.
_OTHER_REFUSAL = (
    "RocketRide-hosted models couldn't run this request. Try again later, or add your own OpenAI key in the "
    'node settings.'
)

# The backend's own sentences, read back for the value it filled in.
_MODEL_IN_MESSAGE = re.compile(r"^The model (.+?) isn't offered as a RocketRide-hosted model\.")
_FIELD_IN_MESSAGE = re.compile(r"^RocketRide-hosted models don't support (.+?)\. Add your own OpenAI key")
# Used when neither the request nor the refusal names the field.
_SOME_FIELD = 'part of this request'


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


class OpenAICredentials(NamedTuple):
    """What an OpenAI node builds its clients with."""

    apikey: Any
    base_url: Any
    hosted: bool


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
    non-empty token and an ``expires_at`` in the future.
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
    if isinstance(expires_at, bool) or not isinstance(expires_at, (int, float)) or expires_at <= time.time():
        return None
    return GatewayPass(provider='openai', base_url=base_url, token=token, expires_at=float(expires_at))


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

    Raises:
        MissingModelKeyError: no key, and nothing else can serve this node.
    """
    if not _is_empty(apikey):
        return OpenAICredentials(apikey, base_url, False)

    if _is_hosted():
        gateway = read_pass()
        if logical_type == _COMPATIBLE_PROVIDER and not _is_empty(base_url):
            raise MissingModelKeyError(_NO_KEY_OWN_ENDPOINT.format(node=logical_type))
        if gateway is not None:
            return OpenAICredentials(gateway.token, gateway.base_url, True)
        raise MissingModelKeyError(_NO_KEY_HOSTED.format(node=logical_type))

    if logical_type != _COMPATIBLE_PROVIDER and _is_empty(os.environ.get('OPENAI_API_KEY')):
        raise MissingModelKeyError(_NO_KEY_SELF_HOSTED.format(node=logical_type))
    return OpenAICredentials(apikey, base_url, False)


def missing_key_message(logical_type: str) -> Optional[str]:
    """For a save-time check: the message for a node with no key, or None.

    Only a self-hosted ``llm_openai`` with no ``OPENAI_API_KEY`` gets one. A
    hosted engine has no pass while a node is checked, so it says nothing there.
    A check can run in the server process itself, which carries the server's
    ``--saas`` flag rather than a task's ``--hosted``.
    """
    if logical_type == _COMPATIBLE_PROVIDER or _is_hosted() or _SERVER_HOSTED_FLAG in sys.argv:
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
        name = _clean(model) or (_clean(found.group(1)) if found else '')
        return ' '.join(sentence.format(model=name).split())
    if code == 'unsupported_parameter':
        found = _FIELD_IN_MESSAGE.match(message)
        name = _clean(body.get('param')) or (_clean(found.group(1)) if found else '') or _SOME_FIELD
        return sentence.format(field=name)
    return sentence


def _components(container: Any) -> list:
    """The component list of a pipeline or a group, or nothing."""
    if not isinstance(container, dict):
        return []
    components = container.get('components')
    return components if isinstance(components, list) else []


def _is_keyless(provider: str, settings: Any) -> bool:
    """True for an OpenAI node whose effective settings have no key (and, for
    ``llm_openai_api``, no base URL). Settings the resolver cannot read count as keyed.
    """
    if not isinstance(settings, dict):
        return False
    from ai.common.config import Config

    try:
        config = Config.getNodeConfig(provider, settings)
    except Exception:
        return False
    if not _is_empty(config.get('apikey')):
        return False
    return provider != _COMPATIBLE_PROVIDER or _is_empty(config.get('base_url'))


def _any_keyless(components: list, depth: int) -> bool:
    """Walk components and their groups, to a depth of _MAX_DEPTH."""
    if depth >= _MAX_DEPTH:
        return False
    for component in components:
        if not isinstance(component, dict):
            continue
        settings = component.get('config')
        if component.get('provider') in OPENAI_PROVIDERS and _is_keyless(component['provider'], settings or {}):
            return True
        if isinstance(settings, dict) and _any_keyless(_components(settings.get('pipeline')), depth + 1):
            return True
    return False


def wants_hosted_openai(pipeline: Any) -> bool:
    """True when the pipeline has an OpenAI node that would run with no key.

    That is an ``llm_openai`` node with an empty ``apikey``, or an
    ``llm_openai_api`` node with an empty ``apikey`` and an empty ``base_url``,
    read the way the node reads them (``Config.getNodeConfig``, so a key in the
    profile block counts). Secure parameters are decoded on a copy first, so a
    key inside one is seen; the copy is dropped before this returns, and the
    input is never changed. A ``${ROCKETRIDE_...}`` left unfilled is a key, so
    that node keeps its own message. Pass the resolved pipeline the run starts.

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
        return _any_keyless(_components(decoded), 0)
    finally:
        del decoded
