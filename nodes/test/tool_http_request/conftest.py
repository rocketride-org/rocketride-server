# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Shared fixtures for the HTTP-tool unit tests."""

from __future__ import annotations

import importlib.util
import sys
import types
from pathlib import Path
from unittest.mock import Mock

import pytest

NODE_DIR = Path(__file__).resolve().parent.parent.parent / 'src' / 'nodes' / 'tool_http_request'
SHARED_UTILS_DIR = Path(__file__).resolve().parents[3] / 'packages' / 'ai' / 'src' / 'ai' / 'common' / 'utils'


def load_shared_util(name: str):
    """Load one real ``ai.common.utils`` submodule standalone (``url_policy`` and ``pinned_http`` have no engine imports)."""
    spec = importlib.util.spec_from_file_location(f'_tool_http_request_test_{name}', SHARED_UTILS_DIR / f'{name}.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def node_modules(monkeypatch: pytest.MonkeyPatch):
    """Load the node files with small engine-runtime stubs.

    Returns ``(http_client, IGlobal module, IInstance module)``. ``rocketlib.warning``
    and ``Config.getNodeConfig`` are mocks the test can inspect or program.
    """
    pytest.importorskip('requests')

    package_name = f'_tool_http_request_test_{id(monkeypatch)}'
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
    utils_module.config_int = Mock(side_effect=lambda _cfg, _key, default, **_kwargs: default)
    utils_module.url_matches_pattern = load_shared_util('url_policy').url_matches_pattern
    pinned_http = load_shared_util('pinned_http')
    utils_module.HostResolutionError = pinned_http.HostResolutionError
    utils_module.pinned_session = pinned_http.pinned_session
    utils_module.resolve_public_addresses = pinned_http.resolve_public_addresses
    monkeypatch.setitem(sys.modules, 'ai', types.ModuleType('ai'))
    monkeypatch.setitem(sys.modules, 'ai.common', types.ModuleType('ai.common'))
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
