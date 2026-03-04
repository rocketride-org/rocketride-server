# MIT License
# Copyright (c) 2026 Aparavi Software AG
# Tests for rocketride_mcp.config.

import os

import pytest

from rocketride_mcp.config import Settings, load_settings


def test_load_settings_success(env_rocketride: None) -> None:
    settings = load_settings()
    assert settings.apikey == 'test-api-key'
    assert settings.uri == 'wss://test.example.com'


def test_load_settings_uses_apikey_fallback(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv('ROCKETRIDE_AUTH', raising=False)
    monkeypatch.setenv('ROCKETRIDE_APIKEY', 'fallback-key')
    monkeypatch.setenv('ROCKETRIDE_URI', 'wss://fallback.example.com')
    settings = load_settings()
    assert settings.apikey == 'fallback-key'
    assert settings.uri == 'wss://fallback.example.com'


def test_load_settings_prefers_auth_over_apikey(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('ROCKETRIDE_AUTH', 'auth-value')
    monkeypatch.setenv('ROCKETRIDE_APIKEY', 'apikey-value')
    monkeypatch.setenv('ROCKETRIDE_URI', 'wss://example.com')
    settings = load_settings()
    assert settings.apikey == 'auth-value'


def test_load_settings_missing_apikey_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv('ROCKETRIDE_AUTH', raising=False)
    monkeypatch.delenv('ROCKETRIDE_APIKEY', raising=False)
    monkeypatch.setenv('ROCKETRIDE_URI', 'wss://example.com')
    with pytest.raises(ValueError, match='ROCKETRIDE_AUTH or ROCKETRIDE_APIKEY'):
        load_settings()


def test_load_settings_missing_uri_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('ROCKETRIDE_AUTH', 'key')
    monkeypatch.delenv('ROCKETRIDE_URI', raising=False)
    with pytest.raises(ValueError, match='ROCKETRIDE_URI'):
        load_settings()


def test_settings_dataclass() -> None:
    s = Settings(apikey='k', uri='u')
    assert s.apikey == 'k'
    assert s.uri == 'u'
