# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Temperature plumbing for the OpenAI driver.

The declarative `services.json` node tests only assert the mocked response text,
not what `ChatOpenAI` was actually constructed with, so a `temperature` field that
never reached the client would pass them silently (RR-1660 review). These tests
drive the real `Chat.__init__` chain instead:

    config['temperature'] -> ChatOpenAI(temperature=...)   (non-reasoning models)
    config['temperature'] -> dropped entirely               (reasoning models,
                              OpenAI's Responses API controls it separately)

and pin the `'temperature' in config` guard (matching `llm_ollama`'s pattern) so a
present-but-zero value is sent as `0`, not re-defaulted by a falsy check.
"""

import importlib.util
import os
import sys
import types

from ai.common.config import Config

_HERE = os.path.dirname(os.path.abspath(__file__))
_MOD_PATH = os.path.join(_HERE, '..', '..', 'src', 'nodes', 'llm_openai', 'openai_client.py')

_MODEL = 'gpt-5.2'


class _RecordingChatOpenAI:
    """Stand-in for langchain_openai.ChatOpenAI that records its kwargs."""

    def __init__(self, **kwargs):
        self.kwargs = kwargs


def _load_node_module():
    """Load openai_client.py standalone, stubbing the langchain_openai client."""
    saved = sys.modules.get('langchain_openai')
    stub = types.ModuleType('langchain_openai')
    stub.ChatOpenAI = _RecordingChatOpenAI
    sys.modules['langchain_openai'] = stub
    try:
        spec = importlib.util.spec_from_file_location('_llm_openai_client_node', _MOD_PATH)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod
    finally:
        if saved is None:
            sys.modules.pop('langchain_openai', None)
        else:
            sys.modules['langchain_openai'] = saved


def _build_chat(monkeypatch, *, temperature=None, reasoning=False):
    """Instantiate the node over a controlled config and return it."""
    config = {
        'model': _MODEL,
        'apikey': 'sk-test',
        'modelTotalTokens': 400000,
        'modelOutputTokens': 128000,
        'capabilities': {'reasoning': reasoning},
    }
    if temperature is not None:
        config['temperature'] = temperature

    # Both the node and ChatBase read their config through this one call.
    monkeypatch.setattr(Config, 'getNodeConfig', staticmethod(lambda *a, **k: dict(config)))
    return _load_node_module().Chat('openai', {}, {})


def test_configured_temperature_reaches_chatopenai(monkeypatch):
    chat = _build_chat(monkeypatch, temperature=1.4)

    assert chat._llm.kwargs['temperature'] == 1.4


def test_absent_temperature_defaults_to_zero(monkeypatch):
    chat = _build_chat(monkeypatch)

    assert chat._llm.kwargs['temperature'] == 0


def test_explicit_zero_is_not_treated_as_absent(monkeypatch):
    """Guards the `'temperature' in config` check: `.get('temperature', 0)` and the
    `in` check agree on a real 0, but only the `in` check tells them apart — this
    pins the branch so a future `.get(..., 0)` regression fails loudly.
    """
    chat = _build_chat(monkeypatch, temperature=0)

    assert chat._llm.kwargs['temperature'] == 0


def test_reasoning_models_never_receive_temperature(monkeypatch):
    """Reasoning models route through max_completion_tokens only; OpenAI's Responses
    API controls temperature-equivalent behavior separately.
    """
    chat = _build_chat(monkeypatch, temperature=1.4, reasoning=True)

    assert 'temperature' not in chat._llm.kwargs
