# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Which key and base URL each OpenAI client is built with.

The OpenAI node builds up to four clients: the raw ``OpenAI`` client for reasoning
prompts, ``ChatOpenAI`` for a reasoning or a plain model, and the Responses client for
reasoning tool turns. On a hosted task with no key, every one of them must use the run's
pass; one left on the old key would send a turn somewhere else. With a key of its own,
the node builds them exactly as before, with no base URL.
"""

import importlib.util
import json
import os
import sys
import time
import types

import pytest

from ai.common.config import Config

_HERE = os.path.dirname(os.path.abspath(__file__))
_NODES = os.path.join(_HERE, '..', '..', 'src', 'nodes')

BASE_URL = 'http://127.0.0.1:41873/gateway/openai/v1'
TOKEN = 'rrmg_' + 'd' * 43


class _Recording:
    """Stand-in for a client class that records its kwargs."""

    def __init__(self, **kwargs):
        self.kwargs = kwargs


def _load(node: str):
    """Load the node's openai_client.py with recording clients."""
    saved = sys.modules.get('langchain_openai')
    stub = types.ModuleType('langchain_openai')
    stub.ChatOpenAI = type('ChatOpenAI', (_Recording,), {})
    sys.modules['langchain_openai'] = stub
    try:
        spec = importlib.util.spec_from_file_location(
            f'_hosted_models_{node}', os.path.join(_NODES, node, 'openai_client.py')
        )
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
    finally:
        if saved is None:
            sys.modules.pop('langchain_openai', None)
        else:
            sys.modules['langchain_openai'] = saved
    if hasattr(mod, 'OpenAI'):
        mod.OpenAI = type('OpenAI', (_Recording,), {})
    return mod


def _chat(monkeypatch, node: str, **config):
    full = {'model': 'gpt-5.2', 'modelTotalTokens': 400000, 'modelOutputTokens': 128000, **config}
    monkeypatch.setattr(Config, 'getNodeConfig', staticmethod(lambda *a, **k: dict(full)))
    return _load(node).Chat(node, {}, {})


def _clients(chat) -> dict:
    """Every client the node built, the Responses one included."""
    clients = {'llm': chat._llm}
    if getattr(chat, '_raw_client', None) is not None:
        clients['raw'] = chat._raw_client
    if hasattr(chat, '_turn_llm') and chat._is_reasoning:
        clients['responses'] = chat._turn_llm()
    return clients


@pytest.fixture
def hosted_with_pass(monkeypatch):
    monkeypatch.setattr(sys, 'argv', [*sys.argv, '--hosted'])
    monkeypatch.setenv('OPENAI_API_KEY', 'sk-canary-environment')
    gateway = {'provider': 'openai', 'base_url': BASE_URL, 'token': TOKEN, 'expires_at': time.time() + 3600}
    monkeypatch.setenv('ROCKETRIDE_MODEL_GATEWAY', json.dumps(gateway))


@pytest.fixture
def self_hosted(monkeypatch):
    monkeypatch.setattr(sys, 'argv', [a for a in sys.argv if a not in ('--hosted', '--saas')])


@pytest.mark.parametrize('reasoning', [True, False])
def test_every_client_uses_the_pass_on_a_hosted_task_with_no_key(monkeypatch, hosted_with_pass, reasoning):
    chat = _chat(monkeypatch, 'llm_openai', apikey='', capabilities={'reasoning': reasoning})

    clients = _clients(chat)
    assert set(clients) == ({'llm', 'raw', 'responses'} if reasoning else {'llm'})
    for client in clients.values():
        assert client.kwargs['api_key'] == TOKEN
        assert client.kwargs['base_url'] == BASE_URL
    assert chat._hosted_models is True


@pytest.mark.parametrize('reasoning', [True, False])
@pytest.mark.parametrize('where', ['hosted_with_pass', 'self_hosted'])
def test_a_key_of_its_own_builds_every_client_as_before(request, monkeypatch, where, reasoning):
    request.getfixturevalue(where)
    chat = _chat(monkeypatch, 'llm_openai', apikey='sk-user', capabilities={'reasoning': reasoning})

    for client in _clients(chat).values():
        assert client.kwargs['api_key'] == 'sk-user'
        assert 'base_url' not in client.kwargs
    assert chat._hosted_models is False


def test_the_compatible_node_uses_the_pass_only_without_a_base_url(monkeypatch, hosted_with_pass):
    chat = _chat(monkeypatch, 'llm_openai_api', apikey='', base_url='')
    assert (chat._llm.kwargs['api_key'], chat._llm.kwargs['base_url']) == (TOKEN, BASE_URL)
    assert chat._hosted_models is True

    keyed = _chat(monkeypatch, 'llm_openai_api', apikey='sk-user', base_url='https://api.example.test/v1')
    assert (keyed._llm.kwargs['api_key'], keyed._llm.kwargs['base_url']) == ('sk-user', 'https://api.example.test/v1')
    assert keyed._hosted_models is False


def test_a_hosted_task_with_no_key_and_no_pass_says_so_before_building_a_client(monkeypatch):
    monkeypatch.setattr(sys, 'argv', [*sys.argv, '--hosted'])
    monkeypatch.setenv('OPENAI_API_KEY', 'sk-canary-environment')
    monkeypatch.delenv('ROCKETRIDE_MODEL_GATEWAY', raising=False)

    with pytest.raises(ValueError, match="no API key is set, and RocketRide-hosted models aren't available"):
        _chat(monkeypatch, 'llm_openai', apikey='')


def test_a_self_hosted_node_with_no_key_anywhere_says_how_to_add_one(monkeypatch, self_hosted):
    monkeypatch.delenv('OPENAI_API_KEY', raising=False)

    with pytest.raises(ValueError, match=r'^llm_openai: no API key is set\. Enter your OpenAI key'):
        _chat(monkeypatch, 'llm_openai', apikey='')
