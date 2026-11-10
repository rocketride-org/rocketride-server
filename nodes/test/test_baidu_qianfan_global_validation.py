# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Save-time validation of the Baidu Qianfan node.

Drives the real ``IValidator`` over the engine-resolved schema with the openai SDK
stubbed: the probe sends a non-degenerate token limit, provider errors become
the node's own messages, and a token limit that is not a number is refused by
the resolver before any request is made.
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

from llm_baidu_qianfan import IValidator as qianfan_validator  # noqa: E402

_LOGICAL_TYPE = 'llm_baidu_qianfan'


def _validator(monkeypatch, error_name: str | None = None, config_overrides: dict | None = None):
    """Build the validator over a stored config with the openai SDK stubbed.

    Returns:
        (IValidator instance, recorded probe requests, recorded warnings)
    """
    requests: list[dict] = []
    warnings: list[str] = []

    openai_module = types.ModuleType('openai')
    depends_module = types.ModuleType('depends')

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
        """Records the probe request, raising the asked-for error."""

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

    openai_module.APIConnectionError = APIConnectionError
    openai_module.APIStatusError = APIStatusError
    openai_module.AuthenticationError = AuthenticationError
    openai_module.OpenAI = OpenAI
    openai_module.OpenAIError = OpenAIError
    openai_module.RateLimitError = RateLimitError
    depends_module.depends = lambda _requirements: None
    monkeypatch.setitem(sys.modules, 'openai', openai_module)
    monkeypatch.setitem(sys.modules, 'depends', depends_module)
    monkeypatch.setattr(qianfan_validator, 'warning', warnings.append)

    config = {'model': 'ernie-4.5-turbo-128k', 'apikey': 'test-key'}
    if config_overrides:
        config.update(config_overrides)
    instance = qianfan_validator.IValidator()
    instance.glb = types.SimpleNamespace(logicalType=_LOGICAL_TYPE, connConfig=config)
    return instance, requests, warnings


def test_validate_config_prefers_authentication_error_message(monkeypatch):
    instance, _requests, warnings = _validator(monkeypatch, 'AuthenticationError')
    instance.validateConfig()
    assert warnings == ['Baidu Qianfan API key is invalid or unauthorized.']


def test_validate_config_prefers_rate_limit_error_message(monkeypatch):
    instance, _requests, warnings = _validator(monkeypatch, 'RateLimitError')
    instance.validateConfig()
    assert warnings == ['Baidu Qianfan rate limit exceeded while validating the configuration.']


def test_validate_config_uses_non_degenerate_probe_token_limit(monkeypatch):
    instance, requests, warnings = _validator(monkeypatch)
    instance.validateConfig()
    assert warnings == []
    assert requests == [
        {
            'model': 'ernie-4.5-turbo-128k',
            'messages': [{'role': 'user', 'content': 'Hi'}],
            'max_tokens': 8,
        }
    ]


def test_validate_config_probes_the_schema_endpoint(monkeypatch):
    """The serverbase comes from the schema default; the probe does not need it stored."""
    instance, requests, _warnings = _validator(monkeypatch)
    instance.validateConfig()
    assert len(requests) == 1
    assert instance.config['serverbase'] == 'https://qianfan.baidubce.com/v2'


def test_a_custom_model_with_a_non_numeric_token_limit_is_refused(monkeypatch):
    """The resolver types the custom branch's token limit; 'abc' never reaches the probe."""
    instance, requests, _warnings = _validator(
        monkeypatch,
        config_overrides={'model': 'custom', 'custom': {'customModel': 'ernie-x', 'modelTotalTokens': 'abc'}},
    )
    with pytest.raises(ConfigError, match='modelTotalTokens'):
        instance.validateConfig()
    assert requests == []


def test_a_custom_model_is_probed_by_its_own_id(monkeypatch):
    instance, requests, warnings = _validator(
        monkeypatch,
        config_overrides={'model': 'custom', 'custom': {'customModel': 'ernie-x', 'modelTotalTokens': 128000}},
    )
    instance.validateConfig()
    assert warnings == []
    assert [r['model'] for r in requests] == ['ernie-x']


def test_format_error_keeps_fallback_when_only_status_is_available(monkeypatch):
    instance, _requests, _warnings = _validator(monkeypatch)
    message = instance._format_error(500, None, None, 'provider fallback message')
    assert message == 'Error 500: provider fallback message'
