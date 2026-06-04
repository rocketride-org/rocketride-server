from __future__ import annotations

import importlib.util
import sys
import types
from pathlib import Path


def _load_iglobal(monkeypatch, error_name: str | None = None, config_overrides: dict | None = None):
    requests: list[dict] = []
    warnings: list[str] = []

    ai_module = types.ModuleType('ai')
    common_module = types.ModuleType('ai.common')
    chat_module = types.ModuleType('ai.common.chat')
    config_module = types.ModuleType('ai.common.config')
    rocketlib_module = types.ModuleType('rocketlib')
    openai_module = types.ModuleType('openai')

    class ChatBase:
        pass

    class Config:
        @staticmethod
        def getNodeConfig(_logical_type, _conn_config):
            config = {
                'apikey': 'test-key',
                'model': 'ernie-4.5-turbo-128k',
                'serverbase': 'https://qianfan.baidubce.com/v2',
                'modelTotalTokens': 128000,
            }
            if config_overrides:
                config.update(config_overrides)
            return config

    class IGlobalBase:
        pass

    class OPEN_MODE:
        CONFIG = 'CONFIG'

    class OpenAIError(Exception):
        pass

    class APIStatusError(OpenAIError):
        pass

    class AuthenticationError(APIStatusError):
        pass

    class RateLimitError(APIStatusError):
        pass

    class APIConnectionError(OpenAIError):
        pass

    class FakeCompletions:
        def create(self, **kwargs):
            requests.append(kwargs)
            if error_name is not None:
                raised_error = getattr(openai_module, error_name)(error_name)
                raise raised_error

    class FakeChat:
        def __init__(self):
            self.completions = FakeCompletions()

    class OpenAI:
        def __init__(self, **_kwargs):
            self.chat = FakeChat()

    chat_module.ChatBase = ChatBase
    config_module.Config = Config
    rocketlib_module.IGlobalBase = IGlobalBase
    rocketlib_module.OPEN_MODE = OPEN_MODE
    rocketlib_module.warning = warnings.append
    openai_module.APIConnectionError = APIConnectionError
    openai_module.APIStatusError = APIStatusError
    openai_module.AuthenticationError = AuthenticationError
    openai_module.OpenAI = OpenAI
    openai_module.OpenAIError = OpenAIError
    openai_module.RateLimitError = RateLimitError

    monkeypatch.setitem(sys.modules, 'ai', ai_module)
    monkeypatch.setitem(sys.modules, 'ai.common', common_module)
    monkeypatch.setitem(sys.modules, 'ai.common.chat', chat_module)
    monkeypatch.setitem(sys.modules, 'ai.common.config', config_module)
    monkeypatch.setitem(sys.modules, 'rocketlib', rocketlib_module)
    monkeypatch.setitem(sys.modules, 'openai', openai_module)

    module_path = Path(__file__).resolve().parents[1] / 'src' / 'nodes' / 'llm_baidu_qianfan' / 'IGlobal.py'
    spec = importlib.util.spec_from_file_location('baidu_qianfan_iglobal_under_test', module_path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    monkeypatch.setattr(module.IGlobal, '_ensure_dependencies', lambda self: None)

    instance = module.IGlobal()
    instance.glb = types.SimpleNamespace(logicalType='llm_baidu_qianfan', connConfig={})

    return instance, requests, warnings


def test_validate_config_prefers_authentication_error_message(monkeypatch):
    instance, _requests, warnings = _load_iglobal(monkeypatch, 'AuthenticationError')

    instance.validateConfig()

    assert warnings == ['Baidu Qianfan API key is invalid or unauthorized.']


def test_validate_config_prefers_rate_limit_error_message(monkeypatch):
    instance, _requests, warnings = _load_iglobal(monkeypatch, 'RateLimitError')

    instance.validateConfig()

    assert warnings == ['Baidu Qianfan rate limit exceeded while validating the configuration.']


def test_validate_config_uses_non_degenerate_probe_token_limit(monkeypatch):
    instance, requests, warnings = _load_iglobal(monkeypatch)

    instance.validateConfig()

    assert warnings == []
    assert requests == [
        {
            'model': 'ernie-4.5-turbo-128k',
            'messages': [{'role': 'user', 'content': 'Hi'}],
            'max_tokens': 8,
        }
    ]


def test_validate_config_accepts_numeric_string_token_limit(monkeypatch):
    instance, requests, warnings = _load_iglobal(monkeypatch, config_overrides={'modelTotalTokens': '128000'})

    instance.validateConfig()

    assert warnings == []
    assert len(requests) == 1


def test_validate_config_rejects_non_numeric_token_limit_with_user_warning(monkeypatch):
    instance, requests, warnings = _load_iglobal(monkeypatch, config_overrides={'modelTotalTokens': 'abc'})

    instance.validateConfig()

    assert requests == []
    assert warnings == ['Token limit must be greater than 0']


def test_format_error_keeps_fallback_when_only_status_is_available(monkeypatch):
    instance, _requests, _warnings = _load_iglobal(monkeypatch)

    message = instance._format_error(500, None, None, 'provider fallback message')

    assert message == 'Error 500: provider fallback message'
