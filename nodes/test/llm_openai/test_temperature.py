# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Temperature plumbing for the OpenAI driver.

The declarative `services.json` node tests only assert the mocked response text,
not what `ChatOpenAI` was actually constructed with, so a `temperature` field that
never reached the client would pass them silently (RR-1660 review). These tests
drive the real `Chat.__init__` chain over the engine-resolved schema instead:

    config['temperature'] -> ChatOpenAI(temperature=...)   (non-reasoning models)
    config['temperature'] -> dropped entirely               (reasoning models,
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


def _build_chat(*, temperature=None, reasoning=False):
    """Instantiate the node over the resolved config and return it."""
    config = {'model': _REASONING_MODEL if reasoning else _MODEL, 'apikey': 'sk-test'}
    if temperature is not None:
        config['temperature'] = temperature
    schema = rocketlib.getServiceSchema(_LOGICAL_TYPE)
    assert schema is not None, f'{_LOGICAL_TYPE} is not registered with the engine'
    return openai_client.Chat(_LOGICAL_TYPE, resolveConfig(schema, config), {})


def test_configured_temperature_reaches_chatopenai():
    chat = _build_chat(temperature=1.4)

    assert chat._llm.kwargs['temperature'] == 1.4


def test_absent_temperature_defaults_to_zero():
    chat = _build_chat()

    assert chat._llm.kwargs['temperature'] == 0


def test_explicit_zero_is_not_treated_as_absent():
    chat = _build_chat(temperature=0)

    assert chat._llm.kwargs['temperature'] == 0


def test_reasoning_models_never_receive_temperature():
    """Reasoning models route through max_completion_tokens only; OpenAI's Responses
    API controls temperature-equivalent behavior separately.
    """
    chat = _build_chat(temperature=1.4, reasoning=True)

    assert 'temperature' not in chat._llm.kwargs
    assert chat._llm.kwargs['model_kwargs'] == {'max_completion_tokens': chat._modelOutputTokens}
