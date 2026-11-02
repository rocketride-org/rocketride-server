# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""An Anthropic key left as an unfilled ${ROCKETRIDE_...} names the missing variable.

The node checks that the key starts with sk-ant before ChatBase runs, so the
placeholder used to fail as "Invalid Anthropic API key format", which sends the
user to fix a key they never typed.
"""

import importlib.util
import os
import sys
import types

import pytest

from ai.common.config import Config

_MOD_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), '..', '..', 'src', 'nodes', 'llm_anthropic', 'anthropic.py'
)


def _chat(monkeypatch, apikey):
    """Build the Anthropic node's Chat over a config whose key is ``apikey``."""
    config = {'model': 'claude-sonnet-4-6', 'apikey': apikey, 'modelTotalTokens': 200000, 'modelOutputTokens': 8192}
    monkeypatch.setattr(Config, 'getNodeConfig', staticmethod(lambda *a, **k: dict(config)))
    stub = types.ModuleType('langchain_anthropic')
    stub.ChatAnthropic = type('ChatAnthropic', (), {'__init__': lambda self, **kw: None})
    monkeypatch.setitem(sys.modules, 'langchain_anthropic', stub)
    spec = importlib.util.spec_from_file_location('_llm_anthropic_unfilled_key', _MOD_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.Chat('llm_anthropic', {'apikey': apikey}, {})


def test_an_unfilled_key_names_the_missing_variable(monkeypatch):
    """The placeholder fails with the variable's name, before the sk-ant format check."""
    with pytest.raises(ValueError, match='no variable named ROCKETRIDE_ANTHROPIC_KEY was found'):
        _chat(monkeypatch, '${ROCKETRIDE_ANTHROPIC_KEY}')


def test_a_key_in_the_wrong_format_still_says_so(monkeypatch):
    """A real key that is not an Anthropic key still gets the format message."""
    with pytest.raises(ValueError, match='Invalid Anthropic API key format'):
        _chat(monkeypatch, 'not-an-anthropic-key')
