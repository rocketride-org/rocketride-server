# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Regression tests for HTTP-tool configuration and URL guardrails."""

from __future__ import annotations

import importlib.util
import re
import sys
import types
from pathlib import Path
from unittest.mock import Mock

import pytest

pytest.importorskip('requests')

NODE_DIR = Path(__file__).resolve().parent.parent.parent / 'src' / 'nodes' / 'tool_http_request'


def _load_node_modules(monkeypatch: pytest.MonkeyPatch):
    """Load the node files with small engine-runtime stubs."""
    package_name = f'_tool_http_request_guardrail_test_{id(monkeypatch)}'
    package = types.ModuleType(package_name)
    package.__path__ = [str(NODE_DIR)]
    monkeypatch.setitem(sys.modules, package_name, package)

    rocketlib = types.ModuleType('rocketlib')
    rocketlib.IGlobalBase = object
    rocketlib.IInstanceBase = object
    rocketlib.OPEN_MODE = types.SimpleNamespace(CONFIG='config')
    rocketlib.warning = Mock()
    rocketlib.tool_function = lambda **_kwargs: lambda function: function
    monkeypatch.setitem(sys.modules, 'rocketlib', rocketlib)

    config_module = types.ModuleType('ai.common.config')
    config_module.Config = Mock()
    utils_module = types.ModuleType('ai.common.utils')
    utils_module.config_int = Mock()
    ai_module = types.ModuleType('ai')
    common_module = types.ModuleType('ai.common')
    monkeypatch.setitem(sys.modules, 'ai', ai_module)
    monkeypatch.setitem(sys.modules, 'ai.common', common_module)
    monkeypatch.setitem(sys.modules, 'ai.common.config', config_module)
    monkeypatch.setitem(sys.modules, 'ai.common.utils', utils_module)

    def load(name: str):
        qualified_name = f'{package_name}.{name}'
        spec = importlib.util.spec_from_file_location(qualified_name, NODE_DIR / f'{name}.py')
        module = importlib.util.module_from_spec(spec)
        monkeypatch.setitem(sys.modules, qualified_name, module)
        spec.loader.exec_module(module)
        return module

    http_client = load('http_client')
    iglobal = load('IGlobal')
    iinstance = load('IInstance')
    return http_client, iglobal, iinstance


@pytest.mark.parametrize(
    'whitelist,error',
    [
        ([{'whitelistPattern': '['}], 'Invalid URL whitelist regex'),
        ([{'whitelistPattern': ''}], 'non-empty whitelistPattern'),
        ([{'whitelistPattern': ['^https://service.example/$']}], 'must be a string'),
        ([{'whitelistPattern': True}], 'must be a string'),
        ([{'whitelistPattern': 123}], 'must be a string'),
        (['https://service.example'], 'must be an object'),
        ({}, 'malformed and cannot be parsed'),
        (False, 'malformed and cannot be parsed'),
        (0, 'malformed and cannot be parsed'),
    ],
)
def test_invalid_url_whitelist_fails_closed(monkeypatch, whitelist, error):
    """A malformed intended restriction cannot silently become allow-all."""
    _http_client, iglobal, _iinstance = _load_node_modules(monkeypatch)

    with pytest.raises(ValueError, match=error):
        iglobal.IGlobal._build_guardrails({'urlWhitelist': whitelist})


def test_empty_url_whitelist_still_allows_all_public_urls(monkeypatch):
    """An intentionally empty whitelist keeps the documented public-only default."""
    _http_client, iglobal, _iinstance = _load_node_modules(monkeypatch)

    _enabled, patterns = iglobal.IGlobal._build_guardrails({'urlWhitelist': []})

    assert patterns == []


def test_whitelist_checks_path_resolved_url(monkeypatch):
    """The allowlist sees the exact path that will be sent on the wire."""
    _http_client, _iglobal, iinstance = _load_node_modules(monkeypatch)
    instance = object.__new__(iinstance.IInstance)
    instance.IGlobal = types.SimpleNamespace(
        enabled_methods={'GET'},
        url_patterns=[re.compile(r'^https://service\.example/users/42$')],
    )

    resolved_url = instance._validate_guardrails(
        {
            'url': 'https://service.example/users/:id',
            'method': 'GET',
            'path_params': {'id': '42'},
        }
    )

    assert resolved_url == 'https://service.example/users/42'


def test_whitelist_rejects_path_after_resolution(monkeypatch):
    """A template cannot be approved before its final path is known."""
    _http_client, _iglobal, iinstance = _load_node_modules(monkeypatch)
    instance = object.__new__(iinstance.IInstance)
    instance.IGlobal = types.SimpleNamespace(
        enabled_methods={'GET'},
        url_patterns=[re.compile(r'^https://service\.example/users/allowed$')],
    )

    with pytest.raises(ValueError, match='does not match'):
        instance._validate_guardrails(
            {
                'url': 'https://service.example/users/:id',
                'method': 'GET',
                'path_params': {'id': 'denied'},
            }
        )


@pytest.mark.parametrize('encoded_segment', ['%2e%2e', '%252e%252e', '%2e%2e%5cadmin'])
def test_whitelist_rejects_encoded_dot_segments(monkeypatch, encoded_segment):
    """Requests cannot decode traversal syntax after the whitelist approves it."""
    _http_client, _iglobal, iinstance = _load_node_modules(monkeypatch)
    instance = object.__new__(iinstance.IInstance)
    instance.IGlobal = types.SimpleNamespace(
        enabled_methods={'GET'},
        url_patterns=[re.compile(r'^https://service\.example/public/')],
    )

    with pytest.raises(ValueError, match='dot segments'):
        instance._validate_guardrails(
            {
                'url': f'https://service.example/public/{encoded_segment}/admin',
                'method': 'GET',
            }
        )


@pytest.mark.parametrize(
    'url',
    [
        'https://attacker.example/?next=https://service.example/public/data',
        'https://attacker.example/#https://service.example/public/data',
    ],
)
def test_whitelist_pattern_cannot_match_inside_query_or_fragment(monkeypatch, url):
    """Only the request URL prefix—not embedded URL-shaped data—can satisfy a pattern."""
    _http_client, _iglobal, iinstance = _load_node_modules(monkeypatch)
    instance = object.__new__(iinstance.IInstance)
    instance.IGlobal = types.SimpleNamespace(
        enabled_methods={'GET'},
        url_patterns=[re.compile(r'https://service\.example/public/')],
    )

    with pytest.raises(ValueError, match='does not match'):
        instance._validate_guardrails({'url': url, 'method': 'GET'})


def test_whitelist_checks_url_without_fragment(monkeypatch):
    """A fragment that is never sent cannot change allowlist matching."""
    _http_client, _iglobal, iinstance = _load_node_modules(monkeypatch)
    instance = object.__new__(iinstance.IInstance)
    instance.IGlobal = types.SimpleNamespace(
        enabled_methods={'GET'},
        url_patterns=[re.compile(r'https://service\.example/public/data$')],
    )

    resolved_url = instance._validate_guardrails(
        {'url': 'https://service.example/public/data#client-only', 'method': 'GET'}
    )

    assert resolved_url == 'https://service.example/public/data'
