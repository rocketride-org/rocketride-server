# Copyright 2026 Aparavi Software AG. MIT License.
"""Tests for the Task-1 tool framework primitives.

Covers: error normalizer (errors.py), TaskRegistry (registry.py), and
ToolRegistry (tooling.py). `load_pipeline` (tools/_common.py) tests live in
test_common.py -- see that file's module docstring for why they're split out
(Task 1 originally deferred them as BLOCKED on the tools.py -> tools/ package
migration; Task 3 performed that migration and unblocked them).
"""

import pytest

from ai.modules.mcp.errors import HardError, _bad, _extract_dap_failure, normalize_error
from ai.modules.mcp.registry import TaskRegistry
from ai.modules.mcp.tooling import ToolRegistry


# --- errors.py -------------------------------------------------------------


def test_normalize_error_returns_structured_dict_for_plain_exception():
    exc = RuntimeError('boom')

    result = normalize_error(exc, hint='try again')

    assert result == {
        'ok': False,
        'error_type': 'RuntimeError',
        'message': 'boom',
        'hint': 'try again',
    }


def test_normalize_error_raises_harderror_for_connection_error():
    class ConnectionError(Exception):
        pass

    with pytest.raises(HardError) as excinfo:
        normalize_error(ConnectionError('lost link'))

    assert excinfo.value.message == 'lost link'
    assert excinfo.value.error_type == 'ConnectionError'


def test_normalize_error_raises_harderror_for_authentication_exception():
    class AuthenticationException(Exception):
        pass

    with pytest.raises(HardError) as excinfo:
        normalize_error(AuthenticationException('bad key'))

    assert excinfo.value.error_type == 'AuthenticationException'


def test_normalize_error_raises_harderror_for_timeout_error():
    class TimeoutError(Exception):
        pass

    with pytest.raises(HardError) as excinfo:
        normalize_error(TimeoutError('too slow'))

    assert excinfo.value.error_type == 'TimeoutError'


def test_extract_dap_failure_pulls_message_from_dap_result():
    class FakeExc(Exception):
        pass

    exc = FakeExc('generic message')
    exc.dap_result = {'success': False, 'message': 'validation failed: bad field'}

    assert _extract_dap_failure(exc) == 'validation failed: bad field'


def test_extract_dap_failure_returns_none_when_no_dap_result():
    assert _extract_dap_failure(RuntimeError('x')) is None


def test_extract_dap_failure_returns_none_when_dap_result_success_true():
    exc = RuntimeError('x')
    exc.dap_result = {'success': True, 'message': 'ignored'}

    assert _extract_dap_failure(exc) is None


def test_normalize_error_raises_harderror_for_builtin_connection_subclass():
    """The isinstance branch: builtin subclasses (ConnectionResetError, ...)
    whose type NAME is not in HARD_EXC_NAMES must still classify as hard.
    """
    with pytest.raises(HardError) as excinfo:
        normalize_error(ConnectionResetError('peer reset'))

    assert excinfo.value.error_type == 'ConnectionResetError'


def test_normalize_error_uses_dap_failure_message_when_present():
    exc = RuntimeError('generic')
    exc.dap_result = {'success': False, 'message': 'engine says no'}

    result = normalize_error(exc)

    assert result['message'] == 'engine says no'
    assert result['hint'] is None


def test_bad_shape():
    result = _bad('name is required', 'pass a name')

    assert result == {
        'ok': False,
        'error_type': 'BadRequest',
        'message': 'name is required',
        'hint': 'pass a name',
    }


def test_harderror_carries_message_and_error_type():
    err = HardError('down', error_type='ConnectionError')

    assert err.message == 'down'
    assert err.error_type == 'ConnectionError'


def test_harderror_default_error_type():
    err = HardError('down')

    assert err.error_type == 'hard'


# --- registry.py -------------------------------------------------------------


def test_task_registry_add_get_list_remove():
    reg = TaskRegistry()

    reg.add('tok-1', pipeline_ref='/tmp/a.pipe')

    assert reg.get('tok-1') == {'token': 'tok-1', 'pipeline_ref': '/tmp/a.pipe'}
    assert reg.list() == [{'token': 'tok-1', 'pipeline_ref': '/tmp/a.pipe'}]

    reg.remove('tok-1')

    assert reg.get('tok-1') is None
    assert reg.list() == []


def test_task_registry_get_missing_returns_none():
    reg = TaskRegistry()

    assert reg.get('nope') is None


def test_task_registry_remove_missing_is_a_noop():
    reg = TaskRegistry()

    reg.remove('nope')  # must not raise


def test_task_registry_list_returns_multiple_entries():
    reg = TaskRegistry()
    reg.add('tok-1', pipeline_ref='a')
    reg.add('tok-2', pipeline_ref='b')

    tokens = {entry['token'] for entry in reg.list()}

    assert tokens == {'tok-1', 'tok-2'}


# --- tooling.py -------------------------------------------------------------


def test_tool_registry_register_and_tools():
    import mcp.types as types

    registry = ToolRegistry()
    schema = {'type': 'object', 'properties': {}}

    @registry.register('do_thing', 'Does a thing', schema)
    async def _handler(client, tasks, args):
        return {'ok': True}

    tools = registry.tools()

    assert len(tools) == 1
    assert isinstance(tools[0], types.Tool)
    assert tools[0].name == 'do_thing'
    assert tools[0].description == 'Does a thing'
    assert tools[0].input_schema == schema


def test_tool_registry_handler_returns_registered_fn():
    registry = ToolRegistry()

    @registry.register('do_thing', 'desc', {'type': 'object', 'properties': {}})
    async def _handler(client, tasks, args):
        return {'ok': True}

    assert registry.handler('do_thing') is _handler


def test_tool_registry_handler_missing_returns_none():
    registry = ToolRegistry()

    assert registry.handler('nope') is None


def test_tool_registry_names():
    registry = ToolRegistry()

    @registry.register('a', 'desc a', {'type': 'object', 'properties': {}})
    async def _a(client, tasks, args):
        return {}

    @registry.register('b', 'desc b', {'type': 'object', 'properties': {}})
    async def _b(client, tasks, args):
        return {}

    assert set(registry.names()) == {'a', 'b'}
