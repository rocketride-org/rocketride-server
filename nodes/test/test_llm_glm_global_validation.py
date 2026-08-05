"""Unit tests for llm_glm's IGlobal save-time validation.

Loads nodes/src/nodes/llm_glm/IGlobal.py with stubbed heavy imports
(ai.common, rocketlib, openai, depends), same approach as
test_baidu_qianfan_global_validation.py, and verifies the validateConfig
cloud probe gating and the _format_error message composer.
"""

from __future__ import annotations

import importlib.util
import re
import sys
import types
from pathlib import Path


def _load_iglobal(monkeypatch, error_factory=None, config_overrides: dict | None = None):
    """Load IGlobal.py from source with stubbed dependencies.

    Installs fake ai.common.chat / ai.common.config / rocketlib / openai /
    depends modules in sys.modules, then imports the node module for testing.

    Args:
        monkeypatch: pytest fixture used to patch sys.modules
        error_factory: optional callable(openai_module) -> Exception; when set,
            the fake completions endpoint raises the returned error
        config_overrides: optional dict merged over the default node config

    Returns:
        (IGlobal instance, recorded probe request kwargs, recorded warnings)
    """
    requests: list[dict] = []
    warnings: list[str] = []

    ai_module = types.ModuleType('ai')
    common_module = types.ModuleType('ai.common')
    chat_module = types.ModuleType('ai.common.chat')
    config_module = types.ModuleType('ai.common.config')
    rocketlib_module = types.ModuleType('rocketlib')
    openai_module = types.ModuleType('openai')
    depends_module = types.ModuleType('depends')

    class ChatBase:
        """Stub base type referenced by IGlobal's type annotation."""

    class Config:
        """Stub of ai.common.config.Config returning a fixed cloud config."""

        @staticmethod
        def getNodeConfig(_logical_type, _conn_config):
            """Return the default cloud-profile config, with overrides applied."""
            config = {
                'apikey': 'test-key',
                'model': 'glm-5.2',
                'serverbase': 'https://api.z.ai/api/paas/v4',
            }
            if config_overrides:
                config.update(config_overrides)
            return config

    class IGlobalBase:
        """Stub of rocketlib.IGlobalBase."""

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

    class FakeChat:
        """Container exposing .completions like the openai client."""

        def __init__(self):
            """Attach the fake completions endpoint."""
            self.completions = FakeCompletions()

    class OpenAI:
        """Stub openai.OpenAI client whose chat endpoint is faked."""

        def __init__(self, **_kwargs):
            """Accept and ignore client kwargs; expose the fake chat."""
            self.chat = FakeChat()

    chat_module.ChatBase = ChatBase
    config_module.Config = Config
    rocketlib_module.IGlobalBase = IGlobalBase
    rocketlib_module.warning = warnings.append
    openai_module.OpenAI = OpenAI
    openai_module.OpenAIError = OpenAIError
    openai_module.APIStatusError = APIStatusError
    openai_module.APIConnectionError = APIConnectionError
    depends_module.depends = lambda _requirements: None
    ai_module.common = common_module
    common_module.chat = chat_module
    common_module.config = config_module

    monkeypatch.setitem(sys.modules, 'ai', ai_module)
    monkeypatch.setitem(sys.modules, 'ai.common', common_module)
    monkeypatch.setitem(sys.modules, 'ai.common.chat', chat_module)
    monkeypatch.setitem(sys.modules, 'ai.common.config', config_module)
    monkeypatch.setitem(sys.modules, 'rocketlib', rocketlib_module)
    monkeypatch.setitem(sys.modules, 'openai', openai_module)
    monkeypatch.setitem(sys.modules, 'depends', depends_module)

    module_path = Path(__file__).resolve().parents[1] / 'src' / 'nodes' / 'llm_glm' / 'IGlobal.py'
    spec = importlib.util.spec_from_file_location('glm_iglobal_under_test', module_path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)

    instance = module.IGlobal()
    instance.glb = types.SimpleNamespace(logicalType='llm_glm', connConfig={})

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
    instance, requests, warnings = _load_iglobal(monkeypatch)

    instance.validateConfig()

    assert warnings == []
    assert requests == [
        {
            'model': 'glm-5.2',
            'messages': [{'role': 'user', 'content': 'Hi'}],
            'max_tokens': 1,
        }
    ]


def test_validate_config_skips_probe_for_self_hosted_serverbase(monkeypatch):
    """A non-cloud (vLLM/SGLang) serverbase returns early without probing."""
    instance, requests, warnings = _load_iglobal(
        monkeypatch, config_overrides={'serverbase': 'http://localhost:8000/v1'}
    )

    instance.validateConfig()

    assert requests == []
    assert warnings == []


def test_validate_config_skips_probe_when_key_is_absent(monkeypatch):
    """A cloud config without an apikey returns early (the UI prompts for it)."""
    instance, requests, warnings = _load_iglobal(monkeypatch, config_overrides={'apikey': ''})

    instance.validateConfig()

    assert requests == []
    assert warnings == []


def test_validate_config_surfaces_provider_message_on_status_error(monkeypatch):
    """An APIStatusError with a structured body becomes a formatted warning."""
    instance, _requests, warnings = _load_iglobal(
        monkeypatch,
        error_factory=_status_error_with_body(
            401, {'error': {'type': 'invalid_request_error', 'message': 'invalid api key'}}
        ),
    )

    instance.validateConfig()

    assert warnings == ['Error 401: invalid_request_error - invalid api key']


def test_validate_config_warns_on_connection_error(monkeypatch):
    """A non-HTTP APIConnectionError is surfaced via the fallback formatting."""
    instance, _requests, warnings = _load_iglobal(
        monkeypatch, error_factory=lambda openai_module: openai_module.APIConnectionError('connection refused')
    )

    instance.validateConfig()

    assert warnings == ['connection refused']


def test_format_error_builds_full_message(monkeypatch):
    """All structured fields compose to 'Error <status>: <type> - <message>'."""
    instance, _requests, _warnings = _load_iglobal(monkeypatch)

    message = instance._format_error(429, 'rate_limit_error', 'please retry later', 'fallback')

    assert message == 'Error 429: rate_limit_error - please retry later'


def test_format_error_collapses_whitespace_to_single_line(monkeypatch):
    """Newlines and repeated spaces in provider text collapse to single spaces."""
    instance, _requests, _warnings = _load_iglobal(monkeypatch)

    message = instance._format_error(500, 'server_error', 'line one\n  line\ttwo', 'fallback')

    assert message == 'Error 500: server_error - line one line two'
    assert not re.search(r'\s{2,}|\n|\t', message)


def test_format_error_returns_fallback_without_structured_fields(monkeypatch):
    """With no status/type/message, the raw provider fallback is returned as-is."""
    instance, _requests, _warnings = _load_iglobal(monkeypatch)

    message = instance._format_error(None, None, None, 'raw provider message')

    assert message == 'raw provider message'
