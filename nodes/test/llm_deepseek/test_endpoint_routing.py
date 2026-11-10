# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Each DeepSeek model branch resolves to the endpoint that serves it.

The cloud branches pin the DeepSeek API; the Ollama-served branches
(``deepseek-r1:*`` and the local ``deepseek-v3``) alias the local server URL,
which the user may point elsewhere. The client and the save-time probe follow
the resolved ``serverbase``: the API key is required for the DeepSeek API only,
and the probe never calls a local server. Drives the real driver and validator
over the engine-resolved schema with the SDKs stubbed.
"""

from __future__ import annotations

import sys
import types
from pathlib import Path

import pytest
import rocketlib
from rocketlib.config import resolveConfig

NODES_SRC = Path(__file__).resolve().parents[2] / 'src' / 'nodes'
while str(NODES_SRC) in sys.path:
    sys.path.remove(str(NODES_SRC))
sys.path.insert(0, str(NODES_SRC))

from llm_deepseek import IValidator as deepseek_validator  # noqa: E402
from llm_deepseek import deepseek  # noqa: E402
from llm_deepseek.deepseek_endpoint import is_deepseek_api  # noqa: E402

_LOGICAL_TYPE = 'llm_deepseek'
_CLOUD = 'https://api.deepseek.com/v1'
_LOCAL = 'http://localhost:11434/v1'


def _schema():
    schema = rocketlib.getServiceSchema(_LOGICAL_TYPE)
    assert schema is not None, f'{_LOGICAL_TYPE} is not registered with the engine'
    return schema


def _branches() -> list:
    selector = next(p for p in _schema()['properties'] if isinstance(p, dict) and p.get('name') == 'model')
    return [model for model in selector['enum'] if model != 'custom']


def _resolve(conn):
    return resolveConfig(_schema(), conn)


class _ChatOpenAI:
    """Stand-in for langchain_openai.ChatOpenAI that records its kwargs."""

    def __init__(self, **kwargs):
        self.kwargs = kwargs


@pytest.fixture(autouse=True)
def _stub_client(monkeypatch):
    monkeypatch.setattr(deepseek, 'ChatOpenAI', _ChatOpenAI)


# -----------------------------------------------------------------------------
# What a stored config resolves to
# -----------------------------------------------------------------------------


@pytest.mark.parametrize('model', _branches())
def test_every_branch_names_its_endpoint_and_needs_no_key_to_resolve(model):
    """A local model resolves to the Ollama URL, a cloud model to the DeepSeek API; the key stays optional."""
    view = _resolve({'model': model})
    is_local = ':' in model or model == 'deepseek-v3'
    assert view['serverbase'] == (_LOCAL if is_local else _CLOUD), model
    assert view.get('apikey') is None


def test_the_local_branches_are_the_ollama_served_models():
    local = sorted(model for model in _branches() if _resolve({'model': model})['serverbase'] == _LOCAL)
    assert local == [
        'deepseek-r1:1.5b',
        'deepseek-r1:14b',
        'deepseek-r1:32b',
        'deepseek-r1:671b',
        'deepseek-r1:70b',
        'deepseek-r1:7b',
        'deepseek-r1:8b',
        'deepseek-v3',
    ]


def test_a_local_branch_keeps_its_own_server_url():
    """The URL stored under the branch block survives a switch to another model and back."""
    conn = {'model': 'deepseek-r1:7b', 'deepseek-r1:7b': {'serverbase': 'http://ollama.lan:11434/v1'}}
    assert _resolve(conn)['serverbase'] == 'http://ollama.lan:11434/v1'
    assert _resolve({**conn, 'model': 'deepseek-chat'})['serverbase'] == _CLOUD


# -----------------------------------------------------------------------------
# The client follows the resolved endpoint
# -----------------------------------------------------------------------------


def test_a_local_model_builds_without_a_key():
    chat = deepseek.Chat(_LOGICAL_TYPE, _resolve({'model': 'deepseek-r1:7b'}), {})
    assert chat._llm.kwargs['base_url'] == _LOCAL
    assert chat._llm.kwargs['model'] == 'deepseek-r1:7b'
    assert chat._llm.kwargs['api_key'] == 'sk-local-dummy-key'


@pytest.mark.parametrize(
    'url, expected',
    [
        ('https://api.deepseek.com/v1', True),
        ('https://API.DEEPSEEK.COM/v1', True),
        ('http://ollama.lan/api.deepseek/v1', False),
        ('http://localhost:11434/v1?upstream=api.deepseek.com', False),
        ('https://api.deepseek.com.evil.example/v1', False),
        ('http://localhost:11434/v1', False),
    ],
)
def test_the_endpoint_is_judged_by_its_host(url, expected):
    assert is_deepseek_api(url) is expected


def test_a_local_url_mentioning_the_api_in_its_path_is_still_local(monkeypatch):
    """The host decides: the key stays optional and the probe stays off for such a server."""
    conn = {'model': 'deepseek-r1:7b', 'deepseek-r1:7b': {'serverbase': 'http://ollama.lan/api.deepseek/v1'}}
    chat = deepseek.Chat(_LOGICAL_TYPE, _resolve(conn), {})
    assert chat._llm.kwargs['api_key'] == 'sk-local-dummy-key'
    assert chat._llm.kwargs['base_url'] == 'http://ollama.lan/api.deepseek/v1'
    validator, requests, warnings = _validator(monkeypatch, conn)
    validator.validateConfig()
    assert (requests, warnings) == ([], [])


def test_a_padded_api_url_is_still_the_api():
    assert is_deepseek_api('  https://api.deepseek.com/v1 ') is True


def test_an_empty_serverbase_is_refused():
    # A blank URL would let the OpenAI client fall back to its own default host
    conn = {'model': 'deepseek-r1:7b', 'deepseek-r1:7b': {'serverbase': '   '}}
    with pytest.raises(ValueError, match='serverbase is required'):
        deepseek.Chat(_LOGICAL_TYPE, _resolve(conn), {})


def test_a_cloud_model_requires_the_key():
    with pytest.raises(ValueError, match='API key is required'):
        deepseek.Chat(_LOGICAL_TYPE, _resolve({'model': 'deepseek-chat'}), {})


def test_a_cloud_model_builds_against_the_deepseek_api():
    chat = deepseek.Chat(_LOGICAL_TYPE, _resolve({'model': 'deepseek-chat', 'apikey': 'sk-test'}), {})
    assert chat._llm.kwargs['base_url'] == _CLOUD
    assert chat._llm.kwargs['api_key'] == 'sk-test'


# -----------------------------------------------------------------------------
# The probe follows the same routing
# -----------------------------------------------------------------------------


def _validator(monkeypatch, conn):
    """The node's validator over ``conn`` with the openai SDK stubbed; returns (validator, requests, warnings)."""
    requests: list = []
    warnings: list = []

    class _Error(Exception):
        pass

    class _Completions:
        def create(self, **kwargs):
            requests.append(kwargs)

    class _OpenAI:
        def __init__(self, **kwargs):
            requests.append({'client': kwargs})
            self.chat = types.SimpleNamespace(completions=_Completions())

    openai_module = types.ModuleType('openai')
    openai_module.OpenAI = _OpenAI
    for name in ('APIStatusError', 'OpenAIError', 'AuthenticationError', 'RateLimitError', 'APIConnectionError'):
        setattr(openai_module, name, _Error)
    monkeypatch.setitem(sys.modules, 'openai', openai_module)
    monkeypatch.setitem(sys.modules, 'depends', types.SimpleNamespace(depends=lambda _requirements: None))
    monkeypatch.setattr(deepseek_validator, 'warning', warnings.append)
    validator = deepseek_validator.IValidator()
    validator.glb = types.SimpleNamespace(logicalType=_LOGICAL_TYPE, connConfig=conn)
    return validator, requests, warnings


def test_the_probe_skips_a_local_model(monkeypatch):
    validator, requests, warnings = _validator(monkeypatch, {'model': 'deepseek-r1:7b'})
    validator.validateConfig()
    assert (requests, warnings) == ([], [])


def test_the_probe_asks_for_the_key_on_a_cloud_model(monkeypatch):
    validator, requests, warnings = _validator(monkeypatch, {'model': 'deepseek-chat'})
    validator.validateConfig()
    assert requests == []
    assert warnings == ['DeepSeek API key is required for the DeepSeek API endpoint.']


def test_the_probe_calls_the_deepseek_api_for_a_cloud_model(monkeypatch):
    validator, requests, warnings = _validator(monkeypatch, {'model': 'deepseek-chat', 'apikey': 'sk-test'})
    validator.validateConfig()
    assert warnings == []
    assert requests[0] == {'client': {'api_key': 'sk-test', 'base_url': _CLOUD}}
    assert requests[1]['model'] == 'deepseek-chat'
