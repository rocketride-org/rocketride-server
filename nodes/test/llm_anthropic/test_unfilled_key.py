# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""An Anthropic key left as an unfilled ${ROCKETRIDE_...} names the missing variable.

ChatBase checks the key before the node's sk-ant format check runs, so the
placeholder fails with the variable's name instead of "Invalid Anthropic API key
format", which would send the user to fix a key they never typed. Drives the
real driver over the engine-resolved schema with the LangChain client stubbed.
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

from llm_anthropic import anthropic as anthropic_node  # noqa: E402

_LOGICAL_TYPE = 'llm_anthropic'


def _chat(monkeypatch, apikey):
    """Build the Anthropic node's Chat over a config whose key is ``apikey``."""
    monkeypatch.setattr(anthropic_node, '_ChatAnthropic', lambda **kwargs: None)
    schema = rocketlib.getServiceSchema(_LOGICAL_TYPE)
    assert schema is not None, f'{_LOGICAL_TYPE} is not registered with the engine'
    config = resolveConfig(schema, {'model': 'claude-sonnet-4-6', 'apikey': apikey})
    return anthropic_node.Chat(_LOGICAL_TYPE, config, {})


def test_an_unfilled_key_names_the_missing_variable(monkeypatch):
    """The placeholder fails with the variable's name, before the sk-ant format check."""
    with pytest.raises(ValueError, match='no variable named ROCKETRIDE_ANTHROPIC_KEY was found'):
        _chat(monkeypatch, '${ROCKETRIDE_ANTHROPIC_KEY}')


def test_a_key_in_the_wrong_format_still_says_so(monkeypatch):
    """A real key that is not an Anthropic key still gets the format message."""
    with pytest.raises(ValueError, match='Invalid Anthropic API key format'):
        _chat(monkeypatch, 'not-an-anthropic-key')


def test_a_well_formed_key_builds_the_client(monkeypatch):
    """The happy path: the schema-pinned limits reach the chat."""
    chat = _chat(monkeypatch, 'sk-ant-test')

    assert chat._model == 'claude-sonnet-4-6'
    assert chat._modelTotalTokens == chat._config['modelTotalTokens'] > 0
