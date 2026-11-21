# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Temperature plumbing for the OpenAI driver.

The declarative `services.json` node tests only assert the mocked response text,
not what reaches the provider request, so a `temperature` field that never
reached it would pass them silently (RR-1660 review). These tests drive the
real `Chat` over the engine-resolved schema instead. The temperature is a
per-call parameter, bound onto the one `ChatOpenAI` per request:

    settings['temperature'] -> call_kwargs()['temperature']   (non-reasoning models)
    settings['temperature'] -> dropped entirely               (reasoning models,
                               OpenAI's Responses API controls it separately)

The schema defaults the leaf to 0, so an unset value is sent as `0` and a stored
0 is sent as `0`: there is no falsy re-defaulting left to guard against.
"""

import sys
from pathlib import Path

import pytest
import rocketlib
from rocketlib.config import resolveConfig

NODES_SRC = Path(__file__).resolve().parents[2] / 'src' / 'nodes'
while str(NODES_SRC) in sys.path:
    sys.path.remove(str(NODES_SRC))
sys.path.insert(0, str(NODES_SRC))

from llm_openai import openai_client  # noqa: E402

_LOGICAL_TYPE = 'llm_openai'
_MODEL = 'gpt-4o'  # no reasoning constant on its branch
_REASONING_MODEL = 'gpt-5.2'  # reasoning pinned on its branch


class _RecordingChatOpenAI:
    """Stand-in for langchain_openai.ChatOpenAI that records its kwargs."""

    def __init__(self, **kwargs):
        """Keep the client kwargs for the assertions."""
        self.kwargs = kwargs


@pytest.fixture(autouse=True)
def _stub_clients(monkeypatch):
    """No network: both the LangChain client and the raw Responses client are recorders."""
    monkeypatch.setattr(openai_client, 'ChatOpenAI', _RecordingChatOpenAI)
    monkeypatch.setattr(openai_client, 'OpenAI', _RecordingChatOpenAI)


def _view(config):
    """The node's config resolved through the engine's schema."""
    schema = rocketlib.getServiceSchema(_LOGICAL_TYPE)
    assert schema is not None, f'{_LOGICAL_TYPE} is not registered with the engine'
    return resolveConfig(schema, {'apikey': 'sk-test', **config})


def _call_kwargs(*, temperature=None, reasoning=False):
    """Build the chat as the IGlobal does and return one call's request values."""
    config = {'model': _REASONING_MODEL if reasoning else _MODEL}
    if temperature is not None:
        config['temperature'] = temperature
    view = _view(config)
    # The IGlobal's view refuses the per-call leaves; the call's settings serve them
    chat = openai_client.Chat(_LOGICAL_TYPE, view.restricted(refuse_params=True), {})
    with chat.calling(chat.resolve_call(view)):
        return chat, chat.call_kwargs()


def test_the_client_is_built_from_the_key_alone():
    chat, _ = _call_kwargs(temperature=1.4)

    assert chat._llm.kwargs == {'model': openai_client.UNBOUND_MODEL, 'api_key': 'sk-test'}


def test_configured_temperature_reaches_the_request():
    _, kwargs = _call_kwargs(temperature=1.4)

    assert kwargs == {'model': _MODEL, 'max_tokens': 16384, 'temperature': 1.4}


def test_absent_temperature_defaults_to_zero():
    _, kwargs = _call_kwargs()

    assert kwargs['temperature'] == 0


def test_explicit_zero_is_not_treated_as_absent():
    _, kwargs = _call_kwargs(temperature=0)

    assert kwargs['temperature'] == 0


def test_reasoning_models_never_receive_temperature():
    """Reasoning models route through max_completion_tokens only; OpenAI's Responses
    API controls temperature-equivalent behavior separately.
    """
    _, kwargs = _call_kwargs(temperature=1.4, reasoning=True)

    assert 'temperature' not in kwargs
    assert kwargs == {'model': _REASONING_MODEL, 'max_completion_tokens': 128000}


def test_one_chat_serves_two_temperatures_and_two_models():
    """The control's chat is built once; each call's settings decide its request."""
    view = _view({'model': _MODEL})
    chat = openai_client.Chat(_LOGICAL_TYPE, view.restricted(refuse_params=True), {})
    llm = chat._llm

    seen = []
    for params in ({'temperature': 0.2}, {'temperature': 1.1}, {'model': _REASONING_MODEL}):
        with chat.calling(chat.resolve_call(view.overlay(params))):
            seen.append(chat.call_kwargs())

    assert chat._llm is llm, 'a call rebuilt the client'
    assert seen == [
        {'model': _MODEL, 'max_tokens': 16384, 'temperature': 0.2},
        {'model': _MODEL, 'max_tokens': 16384, 'temperature': 1.1},
        {'model': _REASONING_MODEL, 'max_completion_tokens': 128000},
    ]
