# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Pytest conftest for security node tests — mocks rocketlib and ai modules."""

import sys
import types
from unittest.mock import MagicMock

# Mock rocketlib
rocketlib_mock = types.ModuleType('rocketlib')
rocketlib_mock.IGlobalBase = object
rocketlib_mock.IInstanceBase = object
rocketlib_mock.Entry = object
rocketlib_mock.OPEN_MODE = MagicMock()
rocketlib_mock.warning = lambda msg: None  # silent in tests
rocketlib_mock.debug = lambda msg: None
sys.modules.setdefault('rocketlib', rocketlib_mock)

# Mock ai.common
sys.modules.setdefault('ai', types.ModuleType('ai'))
sys.modules.setdefault('ai.common', types.ModuleType('ai.common'))

ai_schema_mock = types.ModuleType('ai.common.schema')
ai_schema_mock.Question = MagicMock
ai_schema_mock.Answer = MagicMock
sys.modules.setdefault('ai.common.schema', ai_schema_mock)

ai_config_mock = types.ModuleType('ai.common.config')
ai_config_mock.Config = MagicMock()
sys.modules.setdefault('ai.common.config', ai_config_mock)

# Mock depends
sys.modules.setdefault('depends', MagicMock())

# Mock crewai with explicit stubs
crewai_mock = types.ModuleType('crewai')
sys.modules.setdefault('crewai', crewai_mock)

crewai_security = types.ModuleType('crewai.security')


class _InterceptionPoint:
    PRE_TOOL_CALL = 'pre_tool_call'
    EXECUTION_START = 'execution_start'


def _on(interception_point):
    """Stub decorator that preserves the decorated method."""
    def decorator(func):
        return func
    return decorator


class _HookAborted(Exception):
    def __init__(self, reason='', source=''):
        self.reason = reason
        self.source = source
        super().__init__(reason)


crewai_security.on = _on
crewai_security.InterceptionPoint = _InterceptionPoint
crewai_security.HookAborted = _HookAborted
sys.modules.setdefault('crewai.security', crewai_security)

# Add the nodes source path
import pathlib
_nodes_path = str(pathlib.Path(__file__).resolve().parents[3] / 'nodes' / 'src' / 'nodes')
if _nodes_path not in sys.path:
    sys.path.insert(0, _nodes_path)
