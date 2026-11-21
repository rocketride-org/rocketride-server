# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Per-call tests for the llm_anthropic extended-thinking toggle.

`test_thinking_mode_injected_into_payload_per_call` hands the adapter a thinking
mode by hand, so it starts after the interesting part. These tests drive the real
chain instead, on one control's chat:

    settings['extendedThinking'] -> parse_bool -> the call's reasoning gate
        -> build_anthropic_thinking_kwargs(model_gate, ...) -> thinking_kwargs()
        -> native_stream_key() == 'anthropic'

Four ways that chain can break and nothing else would catch: `parse_bool`
reverted to `bool`, the reasoning gate dropped, the wrong `model_gate` passed,
or the native handler never named so it never runs. The toggle and the model
are per-call parameters, so one chat answers both a thinking and a plain call.
"""

import importlib.util
import os
import sys
import types

import pytest

import rocketlib
from rocketlib.config import ConfigError, resolveConfig

_HERE = os.path.dirname(os.path.abspath(__file__))
_MOD_PATH = os.path.join(_HERE, '..', '..', 'src', 'nodes', 'llm_anthropic', 'anthropic.py')

_MODEL = 'claude-sonnet-4-6'  # reasoning pinned on its branch
_PLAIN_MODEL = 'claude-3-haiku'  # no reasoning constant on its branch


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


def _view(config):
    """The config as the node reads it: resolved through the engine's schema."""
    schema = rocketlib.getServiceSchema('llm_anthropic')
    assert schema is not None, 'llm_anthropic is not registered with the engine'
    return resolveConfig(schema, {'model': _MODEL, 'apikey': 'sk-ant-test', **config})


def _thinking(*, reasoning: bool, toggle=None):
    """One call's (thinking kwargs, native handler) on a chat built as the IGlobal builds it."""
    # The reasoning capability is a constant of the model's branch, so the model
    # picks it: a reasoning model for the armed cases, a plain one otherwise.
    config = {'model': _MODEL if reasoning else _PLAIN_MODEL}
    if toggle is not None:
        config['extendedThinking'] = toggle
    view = _view(config)
    chat = _load_node_module().Chat('llm_anthropic', view.restricted(refuse_params=True), {})
    with chat.calling(chat.resolve_call(view)):
        return chat.thinking_kwargs(), chat.native_stream_key()


def test_toggle_absent_leaves_thinking_off():
    assert _thinking(reasoning=True) == ({}, '')


def test_toggle_on_reasoning_model_arms_the_native_handler():
    kwargs, handler = _thinking(reasoning=True, toggle=True)

    assert kwargs != {}
    assert handler == 'anthropic'


def test_toggle_on_non_reasoning_model_stays_off():
    # The capability gate wins: the toggle alone must not request thinking.
    assert _thinking(reasoning=False, toggle=True) == ({}, '')


@pytest.mark.parametrize('falsy', ['false', 'False', '0'])
def test_a_string_toggle_is_refused_by_the_schema(falsy):
    # extendedThinking is a boolean leaf: the resolver types it, so a form that
    # wrote a string never reaches the node (and parse_bool never has to guess).
    with pytest.raises(ConfigError, match='extendedThinking'):
        _thinking(reasoning=True, toggle=falsy)


def test_toggle_off_stays_off():
    assert _thinking(reasoning=True, toggle=False) == ({}, '')


def test_one_chat_thinks_for_one_call_and_not_the_next():
    """The toggle is the call's: the control's chat is not rebuilt between them."""
    view = _view({})
    chat = _load_node_module().Chat('llm_anthropic', view.restricted(refuse_params=True), {})

    handlers = []
    for params in ({'extendedThinking': True}, {}, {'extendedThinking': True, 'model': _PLAIN_MODEL}):
        with chat.calling(chat.resolve_call(view.overlay(params))):
            handlers.append(chat.native_stream_key())

    assert handlers == ['anthropic', '', '']
