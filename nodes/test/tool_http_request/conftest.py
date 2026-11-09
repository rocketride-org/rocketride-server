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

    # The real base: its ``config`` property resolves self.glb.connConfig against
    # the engine's schema for tool_http_request (rocketlib.filters is never stubbed).
    from rocketlib.filters import IGlobalBase

    rocketlib = types.ModuleType('rocketlib')
    rocketlib.IGlobalBase = IGlobalBase
    rocketlib.IInstanceBase = object
    rocketlib.engine = importlib.import_module('rocketlib.engine')
    rocketlib.config = importlib.import_module('rocketlib.config')
    rocketlib.warning = Mock()
    rocketlib.tool_function = lambda **_kwargs: lambda function: function
    monkeypatch.setitem(sys.modules, 'rocketlib', rocketlib)

    utils_module = types.ModuleType('ai.common.utils')
    monkeypatch.setitem(sys.modules, 'ai', types.ModuleType('ai'))
    monkeypatch.setitem(sys.modules, 'ai.common', types.ModuleType('ai.common'))
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
