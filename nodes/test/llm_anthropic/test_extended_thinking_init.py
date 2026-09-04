# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Node-init tests for the llm_anthropic extended-thinking toggle.

`test_thinking_mode_injected_into_payload_per_call` sets `_thinking_mode_kwargs`
by hand, so it starts after the interesting part. These tests drive the real
chain instead:

    config['extendedThinking'] -> parse_bool -> _is_reasoning gate
        -> build_anthropic_thinking_kwargs(model_gate, ...) -> _thinking_mode_kwargs
        -> _native_stream_provider = 'anthropic'

Four ways that chain can break and nothing else would catch: `parse_bool`
reverted to `bool`, the `_is_reasoning` gate dropped, the wrong `model_gate`
passed, or `_native_stream_provider` left unset so the native handler never runs.
"""

import importlib.util
import os
import sys
import types

import pytest

from ai.common.config import Config

_HERE = os.path.dirname(os.path.abspath(__file__))
_MOD_PATH = os.path.join(_HERE, '..', '..', 'src', 'nodes', 'llm_anthropic', 'anthropic.py')

_MODEL = 'claude-sonnet-4-6'


def _load_node_module():
    """Load anthropic.py standalone, stubbing the langchain_anthropic client."""
    saved = sys.modules.get('langchain_anthropic')
    stub = types.ModuleType('langchain_anthropic')
    stub.ChatAnthropic = type('ChatAnthropic', (), {'__init__': lambda self, **kw: None})
    sys.modules['langchain_anthropic'] = stub
    try:
        spec = importlib.util.spec_from_file_location('_llm_anthropic_node', _MOD_PATH)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod
    finally:
        if saved is None:
            sys.modules.pop('langchain_anthropic', None)
        else:
            sys.modules['langchain_anthropic'] = saved


def _build_chat(monkeypatch, *, reasoning: bool, toggle=None):
    """Instantiate the node over a controlled config and return it."""
    config = {
        'model': _MODEL,
        'apikey': 'sk-ant-test',
        'modelTotalTokens': 200000,
        'modelOutputTokens': 8192,
        'capabilities': {'reasoning': reasoning},
    }
    if toggle is not None:
        config['extendedThinking'] = toggle

    # Both the node and ChatBase read their config through this one call.
    monkeypatch.setattr(Config, 'getNodeConfig', staticmethod(lambda *a, **k: dict(config)))
    return _load_node_module().Chat('anthropic', {}, {})


def test_toggle_absent_leaves_thinking_off(monkeypatch):
    chat = _build_chat(monkeypatch, reasoning=True)

    assert chat._thinking_mode_kwargs == {}
    assert chat._native_stream_provider == ''


def test_toggle_on_reasoning_model_arms_the_native_handler(monkeypatch):
    chat = _build_chat(monkeypatch, reasoning=True, toggle=True)

    assert chat._thinking_mode_kwargs != {}
    assert chat._native_stream_provider == 'anthropic'


def test_toggle_on_non_reasoning_model_stays_off(monkeypatch):
    # The capability gate wins: the toggle alone must not request thinking.
    chat = _build_chat(monkeypatch, reasoning=False, toggle=True)

    assert chat._thinking_mode_kwargs == {}
    assert chat._native_stream_provider == ''


@pytest.mark.parametrize('falsy', ['false', 'False', '0', ''])
def test_string_false_from_the_form_stays_off(monkeypatch, falsy):
    # The case that fails the moment parse_bool is swapped back for bool():
    # a non-empty string like 'false' is truthy to bool().
    chat = _build_chat(monkeypatch, reasoning=True, toggle=falsy)

    assert chat._thinking_mode_kwargs == {}
    assert chat._native_stream_provider == ''


@pytest.mark.parametrize('model', ['claude-sonnet-5', 'claude-opus-5', 'claude-fable-5', 'claude-mythos-5'])
def test_claude_5_models_use_adaptive_thinking(monkeypatch, model):
    config = {
        'model': model,
        'apikey': 'sk-ant-test',
        'modelTotalTokens': 200000,
        'modelOutputTokens': 8192,
        'capabilities': {'reasoning': True},
        'extendedThinking': True,
    }
    monkeypatch.setattr(Config, 'getNodeConfig', staticmethod(lambda *a, **k: dict(config)))
    chat = _load_node_module().Chat('anthropic', {}, {})

    # Assert the exact adaptive payload — not just the type — so a future edit
    # that reintroduces legacy fields (budget_tokens, betas) for a Claude 5
    # model fails this test instead of silently passing.
    assert chat._thinking_mode_kwargs == {'thinking': {'type': 'adaptive', 'display': 'summarized'}}
