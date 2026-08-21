# Copyright 2026 Aparavi Software AG. MIT License.
"""Tests for registry-based tool dispatch (`handlers.build_mcp_server`) and
the resource wiring it keeps (status / pipelines, no nodes).

Dispatch tests inject a dummy tool by monkeypatching `tools_pkg.register_all`,
isolating the dispatch machinery from the real 28-tool surface (which
`test_list_tools_reflects_real_register_all` covers against
`conftest.EXPECTED_TOOL_NAMES`).

Dispatch is exercised through the v2 in-memory `mcp.client.Client` rather
than introspecting `server.request_handlers` -- that attribute no longer
exists on the v2 low-level `Server` (handlers are registered via constructor
kwargs / `add_request_handler`, not decorators).
"""

import json

import pytest

from mcp.client import Client
from mcp.shared.exceptions import MCPError


def _dummy_schema():
    return {'type': 'object', 'properties': {}}


@pytest.mark.asyncio
async def test_call_tool_dispatches_to_registered_handler(monkeypatch, fake_engine):
    import ai.modules.mcp.handlers as handlers_mod

    def _register_all(registry):
        @registry.register('dummy_tool', 'A dummy tool', _dummy_schema())
        async def _handler(client, tasks, args):
            return {'ok': True, 'thing': 1}

    monkeypatch.setattr(handlers_mod.tools_pkg, 'register_all', _register_all)

    server = handlers_mod.build_mcp_server(lambda: fake_engine)
    async with Client(server) as client:
        result = await client.call_tool('dummy_tool', {})

    assert result.is_error is False
    assert json.loads(result.content[0].text) == {'ok': True, 'thing': 1}


@pytest.mark.asyncio
async def test_call_tool_unknown_name_returns_error_result_not_crash(fake_engine):
    import ai.modules.mcp.handlers as handlers_mod

    server = handlers_mod.build_mcp_server(lambda: fake_engine)
    async with Client(server) as client:
        result = await client.call_tool('nope', {})

    # A structured, self-correctable result -- not a crash. is_error mirrors
    # the in-band ok flag so hosts see the failure without parsing the body.
    assert result.is_error is True
    payload = json.loads(result.content[0].text)
    assert payload['ok'] is False
    assert payload['error_type'] == 'UnknownTool'


@pytest.mark.asyncio
async def test_call_tool_hard_error_surfaces_as_mcp_tool_error(monkeypatch, fake_engine):
    import ai.modules.mcp.handlers as handlers_mod

    def _register_all(registry):
        @registry.register('flaky_tool', 'raises a fake ConnectionError', _dummy_schema())
        async def _handler(client, tasks, args):
            class ConnectionError(Exception):  # shadow builtin on purpose -- classified by type name
                pass

            raise ConnectionError('lost link')

    monkeypatch.setattr(handlers_mod.tools_pkg, 'register_all', _register_all)

    server = handlers_mod.build_mcp_server(lambda: fake_engine)
    # v2 has no `isError`-content escape hatch for arbitrary raised exceptions --
    # they map to a generic "Internal server error" unless the handler maps
    # them to an explicit MCPError, which is exactly what HardError does now.
    #
    # Catch inside the `async with` block, not around it: letting the MCPError
    # propagate out of the block means Client.__aexit__ tears down its
    # internal task group while an exception is still in flight, which anyio
    # re-wraps as a BaseExceptionGroup -- an artifact of session teardown, not
    # part of the contract under test.
    caught = None
    async with Client(server) as client:
        try:
            await client.call_tool('flaky_tool', {})
        except MCPError as exc:
            caught = exc

    assert caught is not None
    assert 'lost link' in str(caught)


@pytest.mark.asyncio
async def test_hard_error_surfaces_message_as_mcp_error(fake_engine):
    """Pins the HardError -> MCPError mapping via the `registry=` test seam,
    independent of monkeypatching `tools_pkg.register_all`.
    """
    from ai.modules.mcp.handlers import build_mcp_server
    from ai.modules.mcp.tooling import ToolRegistry

    registry = ToolRegistry()

    @registry.register('boom', 'always hard-fails', _dummy_schema())
    async def _boom(engine, task_registry, arguments):
        raise ConnectionError('engine unreachable')  # HARD_EXC_NAMES member

    server = build_mcp_server(lambda: fake_engine, registry=registry)

    # See the note in test_call_tool_hard_error_surfaces_as_mcp_tool_error above
    # for why the catch happens inside the `async with` block.
    caught = None
    async with Client(server) as client:
        try:
            await client.call_tool('boom', {})
        except MCPError as exc:
            caught = exc

    assert caught is not None
    assert 'engine unreachable' in str(caught)


@pytest.mark.asyncio
async def test_list_tools_reflects_registry(monkeypatch, fake_engine):
    import ai.modules.mcp.handlers as handlers_mod

    def _register_all(registry):
        @registry.register('one_tool', 'desc', _dummy_schema())
        async def _handler(client, tasks, args):
            return {'ok': True}

    monkeypatch.setattr(handlers_mod.tools_pkg, 'register_all', _register_all)

    server = handlers_mod.build_mcp_server(lambda: fake_engine)
    async with Client(server) as client:
        result = await client.list_tools()

    assert {t.name for t in result.tools} == {'one_tool'}


@pytest.mark.asyncio
async def test_list_tools_reflects_real_register_all(fake_engine):
    """With the real `register_all`, the server serves the complete tool
    surface pinned by `conftest.EXPECTED_TOOL_NAMES`: introspection,
    execution, capability, visibility, and logs.
    """
    import ai.modules.mcp.handlers as handlers_mod

    server = handlers_mod.build_mcp_server(lambda: fake_engine)
    async with Client(server) as client:
        result = await client.list_tools()

    from .conftest import EXPECTED_TOOL_NAMES

    assert {t.name for t in result.tools} == set(EXPECTED_TOOL_NAMES)


@pytest.mark.asyncio
async def test_list_resources_returns_exactly_status_and_pipelines(fake_engine, tmp_path):
    import ai.modules.mcp.handlers as handlers_mod

    # Isolate from whatever MCP Apps widget bundles happen to be built on
    # disk (apps/dist) -- this test is about the two JSON resources, not the
    # ui:// widget surface (covered separately in test_apps.py).
    server = handlers_mod.build_mcp_server(lambda: fake_engine, apps_dir=tmp_path)
    async with Client(server) as client:
        result = await client.list_resources()

    uris = {str(r.uri) for r in result.resources}
    assert uris == {'rocketride://status', 'rocketride://pipelines'}


@pytest.mark.asyncio
async def test_read_pipelines_resource_calls_deploy_list(fake_engine):
    import ai.modules.mcp.handlers as handlers_mod

    server = handlers_mod.build_mcp_server(lambda: fake_engine)
    async with Client(server) as client:
        await client.read_resource('rocketride://pipelines')

    assert fake_engine.deploy_list_calls == 1


@pytest.mark.asyncio
async def test_read_status_resource_calls_list_tasks(fake_engine):
    import ai.modules.mcp.handlers as handlers_mod

    server = handlers_mod.build_mcp_server(lambda: fake_engine)
    async with Client(server) as client:
        await client.read_resource('rocketride://status')

    assert fake_engine.list_tasks_calls == 1


# --- build_mcp_server honoring an externally-created registry ----------------


@pytest.mark.asyncio
async def test_build_mcp_server_uses_passed_in_task_registry(monkeypatch, fake_engine):
    import ai.modules.mcp.handlers as handlers_mod
    from ai.modules.mcp.registry import TaskRegistry

    tasks = TaskRegistry()
    tasks.add('preexisting-token', pipeline_ref='/tmp/a.pipe')

    def _register_all(registry):
        @registry.register('registry_probe', 'desc', _dummy_schema())
        async def _handler(client, tasks_arg, args):
            return {'sees_preexisting': tasks_arg.get('preexisting-token') is not None}

    monkeypatch.setattr(handlers_mod.tools_pkg, 'register_all', _register_all)

    server = handlers_mod.build_mcp_server(lambda: fake_engine, task_registry=tasks)
    async with Client(server) as client:
        result = await client.call_tool('registry_probe', {})

    payload = json.loads(result.content[0].text)
    assert payload == {'sees_preexisting': True}


@pytest.mark.asyncio
async def test_call_tool_soft_error_returns_normalized_result(fake_engine):
    """A plain RuntimeError from a handler is normalized to an in-band
    {ok: False, error_type: 'RuntimeError'} result, not an MCP tool error.
    """
    import ai.modules.mcp.handlers as handlers_mod
    from ai.modules.mcp.tooling import ToolRegistry

    registry = ToolRegistry()

    @registry.register('soft', 'raises a plain RuntimeError', _dummy_schema())
    async def _soft(engine, task_registry, arguments):
        raise RuntimeError('bad field')

    server = handlers_mod.build_mcp_server(lambda: fake_engine, registry=registry)
    async with Client(server) as client:
        result = await client.call_tool('soft', {})

    # is_error mirrors ok: the envelope still rides content for self-correction.
    assert result.is_error is True
    payload = json.loads(result.content[0].text)
    assert payload['ok'] is False
    assert payload['error_type'] == 'RuntimeError'
    assert payload['message'] == 'bad field'


@pytest.mark.asyncio
async def test_call_tool_normalizer_raised_harderror_still_maps_to_mcp_error(fake_engine):
    """normalize_error itself re-raises HardError from INSIDE the except
    suite — the sibling `except HardError` clause never sees it, so the inner
    mapping in handlers.py is load-bearing. A custom class NAMED
    ConnectionError (not a builtin subclass) exercises exactly that path.
    """
    import ai.modules.mcp.handlers as handlers_mod
    from ai.modules.mcp.tooling import ToolRegistry

    registry = ToolRegistry()

    class ConnectionError(Exception):  # noqa: A001 - the name IS the test
        pass

    @registry.register('drops', 'raises a name-matched hard failure', _dummy_schema())
    async def _drops(engine, task_registry, arguments):
        raise ConnectionError('engine went away')

    server = handlers_mod.build_mcp_server(lambda: fake_engine, registry=registry)
    async with Client(server) as client:
        with pytest.raises(MCPError, match='engine went away'):
            await client.call_tool('drops', {})
