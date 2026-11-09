# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Unit tests for llm_glm's save-time validation.

Drives the real ``IValidator`` over the engine-resolved schema with the openai SDK
and ``depends`` stubbed, and verifies the cloud probe gating and the
``_format_error`` message composer. The schema check itself is the resolver: a
config that does not fit is a hard ``ConfigError``, never a warning.
"""

from __future__ import annotations

import re
import sys
import types
from pathlib import Path

import pytest
from rocketlib.config import ConfigError

NODES_SRC = Path(__file__).resolve().parents[1] / 'src' / 'nodes'
while str(NODES_SRC) in sys.path:
    sys.path.remove(str(NODES_SRC))
sys.path.insert(0, str(NODES_SRC))

from llm_glm import IValidator as glm_validator  # noqa: E402

_LOGICAL_TYPE = 'llm_glm'


def _validator(monkeypatch, error_factory=None, config_overrides: dict | None = None):
    """Build the validator over a stored config, with the openai SDK stubbed.

    Args:
        monkeypatch: pytest fixture used to patch sys.modules and the warning sink
        error_factory: optional callable(openai_module) -> Exception; when set,
            the fake completions endpoint raises the returned error
        config_overrides: keys merged over the default cloud config

    Returns:
        (IValidator instance, recorded probe request kwargs, recorded warnings)
    """
    requests: list[dict] = []
    warnings: list[str] = []

    openai_module = types.ModuleType('openai')
    depends_module = types.ModuleType('depends')

    class OpenAIError(Exception):
        """Stub root of the openai exception hierarchy."""

    class APIStatusError(OpenAIError):
        """Stub HTTP-status error carrying status_code and a response object."""

        def __init__(self, message, status_code=None, response=None):
            """Store the status code and response used by the handler under test."""
            super().__init__(message)
            self.status_code = status_code
            self.response = response

    class APIConnectionError(OpenAIError):
        """Stub connection error (not an APIStatusError subclass)."""

    class FakeCompletions:
        """Records probe requests; raises the configured error when set."""

        def create(self, **kwargs):
            """Capture the probe request kwargs, optionally raising."""
            requests.append(kwargs)
            if error_factory is not None:
                raise error_factory(openai_module)

    class OpenAI:
        """Stub openai.OpenAI client whose chat endpoint is faked."""

        def __init__(self, **_kwargs):
            """Accept and ignore client kwargs; expose the fake chat."""
            self.chat = types.SimpleNamespace(completions=FakeCompletions())

    openai_module.OpenAI = OpenAI
    openai_module.OpenAIError = OpenAIError
    openai_module.APIStatusError = APIStatusError
    openai_module.APIConnectionError = APIConnectionError
    depends_module.depends = lambda _requirements: None
    monkeypatch.setitem(sys.modules, 'openai', openai_module)
    monkeypatch.setitem(sys.modules, 'depends', depends_module)
    monkeypatch.setattr(glm_validator, 'warning', warnings.append)

    config = {'model': 'glm-5.2', 'apikey': 'test-key'}
    if config_overrides:
        config.update(config_overrides)
    instance = glm_validator.IValidator()
    instance.glb = types.SimpleNamespace(logicalType=_LOGICAL_TYPE, connConfig=config)
    return instance, requests, warnings


def _status_error_with_body(status: int, body: dict):
    """Return an error_factory producing an APIStatusError with a JSON body."""

    def factory(openai_module):
        """Build the stub APIStatusError carrying the given status and body."""
        response = types.SimpleNamespace(json=lambda: body)
        return openai_module.APIStatusError('boom', status_code=status, response=response)

    return factory


def test_validate_config_probes_cloud_endpoint_with_one_token(monkeypatch):
    """A cloud config with key and model fires exactly one 1-token probe."""
    instance, requests, warnings = _validator(monkeypatch)
    instance.validateConfig()
    assert warnings == []
    assert requests == [
        {
            'model': 'glm-5.2',
            'messages': [{'role': 'user', 'content': 'Hi'}],
            'max_tokens': 1,
        }
    ]


def test_syntax_only_resolves_without_probing(monkeypatch):
    """The editor's shape check never reaches the provider."""
    instance, requests, warnings = _validator(monkeypatch)
    instance.validateConfig(syntaxOnly=True)
    assert (requests, warnings) == ([], [])


def test_a_custom_model_is_probed_by_its_own_id(monkeypatch):
    """The custom branch's customModel is what the probe sends, not the selector value."""
    instance, requests, _warnings = _validator(
        monkeypatch, config_overrides={'model': 'custom', 'custom': {'customModel': 'glm-9-preview'}}
    )
    instance.validateConfig()
    assert [r['model'] for r in requests] == ['glm-9-preview']


def test_validate_config_skips_probe_for_self_hosted_serverbase(monkeypatch):
    """A non-cloud (vLLM/SGLang) serverbase returns early without probing."""
    instance, requests, warnings = _validator(monkeypatch, config_overrides={'serverbase': 'http://localhost:8000/v1'})
    instance.validateConfig()
    assert requests == []
    assert warnings == []


def test_validate_config_skips_probe_when_key_is_absent(monkeypatch):
    """A cloud config without an apikey returns early (the UI prompts for it)."""
    instance, requests, warnings = _validator(monkeypatch, config_overrides={'apikey': ''})
    instance.validateConfig()
    assert requests == []
    assert warnings == []


def test_a_stale_model_value_is_a_hard_error(monkeypatch):
    """A model id the schema does not list fails the resolver, before any probe."""
    instance, requests, _warnings = _validator(monkeypatch, config_overrides={'model': 'glm-0'})
    with pytest.raises(ConfigError, match="'glm-0'"):
        instance.validateConfig()
    assert requests == []


def test_validate_config_surfaces_provider_message_on_status_error(monkeypatch):
    """An APIStatusError with a structured body becomes a formatted warning."""
    instance, _requests, warnings = _validator(
        monkeypatch,
        error_factory=_status_error_with_body(
            401, {'error': {'type': 'invalid_request_error', 'message': 'invalid api key'}}
        ),
    )
    instance.validateConfig()
    assert warnings == ['Error 401: invalid_request_error - invalid api key']


def test_validate_config_warns_on_connection_error(monkeypatch):
    """A non-HTTP APIConnectionError is surfaced via the fallback formatting."""
    instance, _requests, warnings = _validator(
        monkeypatch, error_factory=lambda openai_module: openai_module.APIConnectionError('connection refused')
    )
    instance.validateConfig()
    assert warnings == ['connection refused']


def test_format_error_builds_full_message(monkeypatch):
    """All structured fields compose to 'Error <status>: <type> - <message>'."""
    instance, _requests, _warnings = _validator(monkeypatch)
    message = instance._format_error(429, 'rate_limit_error', 'please retry later', 'fallback')
    assert message == 'Error 429: rate_limit_error - please retry later'


def test_format_error_collapses_whitespace_to_single_line(monkeypatch):
    """Newlines and repeated spaces in provider text collapse to single spaces."""
    instance, _requests, _warnings = _validator(monkeypatch)
    message = instance._format_error(500, 'server_error', 'line one\n  line\ttwo', 'fallback')
    assert message == 'Error 500: server_error - line one line two'
    assert not re.search(r'\s{2,}|\n|\t', message)


def test_format_error_returns_fallback_without_structured_fields(monkeypatch):
    """With no status/type/message, the raw provider fallback is returned as-is."""
    instance, _requests, _warnings = _validator(monkeypatch)
    message = instance._format_error(None, None, None, 'raw provider message')
    assert message == 'raw provider message'


def test_format_error_keeps_fallback_when_only_status_is_known(monkeypatch):
    """A status with no type or message must still carry the provider text."""
    instance, _requests, _warnings = _validator(monkeypatch)
    message = instance._format_error(502, None, None, 'Bad Gateway')
    assert message == 'Error 502: Bad Gateway'
