# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Save-time and start-time handling of the GMI Cloud endpoint URL.

Deploy-on-demand models ship without a ``serverbase``: the user pastes the
endpoint their GMI Cloud console gives them. The schema requires it on exactly
those branches, so a missing URL is a hard resolver error at save time and at
pipe start alike, while the host rule (HTTPS on gmi-serving.com) stays a
semantic check shared by the validator and ``IGlobal``. Drives the real
``IValidator`` and ``IGlobal`` over the engine-resolved schema.
"""

from __future__ import annotations

import sys
import types
from pathlib import Path

import pytest
from rocketlib.config import ConfigError

NODES_SRC = Path(__file__).resolve().parents[1] / 'src' / 'nodes'
while str(NODES_SRC) in sys.path:
    sys.path.remove(str(NODES_SRC))
sys.path.insert(0, str(NODES_SRC))

from llm_gmi_cloud import IGlobal as gmi_global  # noqa: E402
from llm_gmi_cloud import IValidator as gmi_validator  # noqa: E402

_LOGICAL_TYPE = 'llm_gmi_cloud'
_SHARED_MODEL = 'deepseek-ai/DeepSeek-V3-0324'
_ON_DEMAND_MODEL = 'meta-llama/Llama-4-Scout-17B-16E-Instruct'


def _config(model: str = _SHARED_MODEL, **branch) -> dict:
    """A stored config for ``model``; ``branch`` keys go under the model's own block."""
    config = {'model': model, 'apikey': 'gmi-key'}
    if branch:
        config[model] = branch
    return config


def _stubs(monkeypatch, error_name: str | None = None):
    """Install the openai, depends and driver stubs; return (probe requests, warnings, chats built)."""
    requests: list[dict] = []
    warnings: list[str] = []
    chats: list = []

    openai_module = types.ModuleType('openai')
    depends_module = types.ModuleType('depends')
    driver_module = types.ModuleType('llm_gmi_cloud.gmi_cloud')

    class OpenAIError(Exception):
        """Stand-in for the SDK's base error."""

    class APIStatusError(OpenAIError):
        """Stand-in for an HTTP error."""

    class AuthenticationError(APIStatusError):
        """Stand-in for a rejected key."""

    class RateLimitError(APIStatusError):
        """Stand-in for a throttled call."""

    class APIConnectionError(OpenAIError):
        """Stand-in for a transport failure."""

    class FakeCompletions:
        """Records the probe request."""

        def create(self, **kwargs):
            """Record the call, then raise when the test asked for a failure."""
            requests.append(kwargs)
            if error_name is not None:
                raise getattr(openai_module, error_name)(error_name)

    class OpenAI:
        """Client stub exposing only what the node touches."""

        def __init__(self, **_kwargs):
            """Expose a chat.completions surface."""
            self.chat = types.SimpleNamespace(completions=FakeCompletions())

    class Chat:
        """Records that the node reached the point of building a client."""

        def __init__(self, provider, config, bag):
            """Record the configuration the node passed on."""
            chats.append(config)

    openai_module.OpenAI = OpenAI
    openai_module.OpenAIError = OpenAIError
    openai_module.APIStatusError = APIStatusError
    openai_module.AuthenticationError = AuthenticationError
    openai_module.RateLimitError = RateLimitError
    openai_module.APIConnectionError = APIConnectionError
    depends_module.depends = lambda _requirements: None
    driver_module.Chat = Chat
    monkeypatch.setitem(sys.modules, 'openai', openai_module)
    monkeypatch.setitem(sys.modules, 'depends', depends_module)
    monkeypatch.setitem(sys.modules, 'llm_gmi_cloud.gmi_cloud', driver_module)
    monkeypatch.setattr(gmi_validator, 'warning', warnings.append)
    return requests, warnings, chats


def _validator(config: dict):
    """The node's validator over ``config``."""
    instance = gmi_validator.IValidator()
    instance.glb = types.SimpleNamespace(logicalType=_LOGICAL_TYPE, connConfig=config)
    return instance


def _global(config: dict):
    """The node's IGlobal over ``config``, with an endpoint bag."""
    instance = gmi_global.IGlobal()
    instance.glb = types.SimpleNamespace(logicalType=_LOGICAL_TYPE, connConfig=config)
    instance.IEndpoint = types.SimpleNamespace(endpoint=types.SimpleNamespace(bag={}))
    return instance


class TestSaveTime:
    """What the user is told while configuring the node."""

    def test_a_missing_endpoint_is_a_hard_error(self, monkeypatch):
        """A deploy-on-demand model without its URL fails the schema check, naming the field."""
        requests, _warnings, _chats = _stubs(monkeypatch)
        with pytest.raises(ConfigError, match=f'"{_ON_DEMAND_MODEL}.serverbase" is required'):
            _validator(_config(_ON_DEMAND_MODEL)).validateConfig()
        assert requests == []

    def test_a_configured_endpoint_is_probed(self, monkeypatch):
        """With the endpoint set (pinned for the shared models), the node probes the API."""
        requests, warnings, _chats = _stubs(monkeypatch)
        _validator(_config()).validateConfig()
        assert warnings == []
        assert [r['model'] for r in requests] == [_SHARED_MODEL]

    def test_a_pasted_endpoint_is_probed(self, monkeypatch):
        """The URL stored under the model's block reaches the probe."""
        requests, warnings, _chats = _stubs(monkeypatch)
        _validator(_config(_ON_DEMAND_MODEL, serverbase='https://my-deploy.gmi-serving.com/v1')).validateConfig()
        assert warnings == []
        assert [r['model'] for r in requests] == [_ON_DEMAND_MODEL]

    def test_a_foreign_host_is_warned_about(self, monkeypatch):
        """The SSRF guard rejects an endpoint outside gmi-serving.com before probing it."""
        requests, warnings, _chats = _stubs(monkeypatch)
        _validator(_config(_ON_DEMAND_MODEL, serverbase='https://evil.example.com/v1')).validateConfig()
        assert requests == []
        assert warnings == ['Endpoint URL must be a gmi-serving.com address.']

    def test_an_unlisted_model_is_a_hard_error(self, monkeypatch):
        """A model id the catalog does not carry is refused by the resolver, not probed."""
        requests, _warnings, _chats = _stubs(monkeypatch)
        with pytest.raises(ConfigError, match="'no-such-model'"):
            _validator(_config('no-such-model')).validateConfig()
        assert requests == []


class TestPipelineStart:
    """What happens when a pipeline using the node starts."""

    def test_a_missing_endpoint_stops_the_start(self, monkeypatch):
        """No silent fallback to the shared endpoint: that would 404 later, on the model."""
        _requests, _warnings, chats = _stubs(monkeypatch)
        with pytest.raises(ConfigError, match='serverbase'):
            _global(_config(_ON_DEMAND_MODEL)).beginGlobal()
        assert chats == []

    def test_a_foreign_host_is_refused(self, monkeypatch):
        """The SSRF guard still rejects an endpoint outside gmi-serving.com."""
        _requests, _warnings, chats = _stubs(monkeypatch)
        with pytest.raises(ValueError, match='gmi-serving.com'):
            _global(_config(_ON_DEMAND_MODEL, serverbase='https://evil.example.com/v1')).beginGlobal()
        assert chats == []

    def test_a_configured_endpoint_builds_the_client(self, monkeypatch):
        """The happy path reaches Chat with the endpoint the model pins."""
        _requests, _warnings, chats = _stubs(monkeypatch)
        _global(_config()).beginGlobal()
        assert [c['serverbase'] for c in chats] == ['https://api.gmi-serving.com/v1']
