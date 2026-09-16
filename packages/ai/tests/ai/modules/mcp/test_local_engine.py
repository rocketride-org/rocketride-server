# Copyright 2026 Aparavi Software AG. MIT License.
"""Behaviour gated on whether this engine is local (loopback-bound).

A loopback bind means the MCP caller and the engine share a machine, so the
engine host's filesystem is the caller's own. Any other bind is a deployed
engine: its host is our server, not the caller's machine.

- ``send_files`` reads caller-supplied paths off the engine host, so a
  deployed engine neither lists nor runs it.
"""

import json

import pytest

from mcp.client import Client


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for name in ('ROCKETRIDE_URI', 'MCP_RESOURCE_IDENTIFIER', 'MCP_DEV_NO_AUTH', 'ROCKETRIDE_AUTH'):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv('ROCKETRIDE_APIKEY', 'svc-key')


def _init(monkeypatch, fake_web_server, host, config=None):
    """Run initModule bound at ``host``; capture the factory and built server."""
    import ai.modules.mcp as mcp_module

    fake_web_server.config = {'host': host, 'port': 5565}
    captured = {}
    real_build = mcp_module.build_mcp_server

    def _capture(engine_factory, task_registry=None, **kwargs):
        captured['factory'] = engine_factory
        captured['server'] = real_build(engine_factory, task_registry, **kwargs)
        return captured['server']

    monkeypatch.setattr(mcp_module, 'build_mcp_server', _capture)
    mcp_module.initModule(fake_web_server, dict(config or {}))
    return captured


def _payload(result):
    return json.loads(result.content[0].text)


# ---------------------------------------------------------------------------
# send_files: only offered by local engines
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_deployed_engine_does_not_list_send_files(fake_engine):
    from ai.modules.mcp.handlers import build_mcp_server

    server = build_mcp_server(lambda: fake_engine, local_engine=False)
    async with Client(server) as client:
        names = {t.name for t in (await client.list_tools()).tools}

    assert 'send_files' not in names
    # The rest of the execution surface is unaffected.
    assert {'run_pipeline', 'run_dropper_pipe', 'send_data', 'terminate'} <= names


@pytest.mark.asyncio
async def test_deployed_engine_refuses_send_files_by_name_without_touching_the_engine(fake_engine, tmp_path):
    from ai.modules.mcp.handlers import build_mcp_server

    existing = tmp_path / 'real.pdf'
    existing.write_bytes(b'%PDF')
    missing = tmp_path / 'missing.pdf'

    server = build_mcp_server(lambda: fake_engine, local_engine=False)
    async with Client(server) as client:
        hit = await client.call_tool('send_files', {'task_token': 'tok-1', 'files': [str(existing)]})
        miss = await client.call_tool('send_files', {'task_token': 'tok-1', 'files': [str(missing)]})

    assert hit.is_error is True
    body = _payload(hit)
    assert body['ok'] is False
    assert body['error_type'] == 'Unavailable'
    assert 'local' in body['message']
    # Never reached the engine seam (which is where the SDK opens paths).
    assert fake_engine.sent_files == []
    # No existence oracle: an existing and a missing path answer identically,
    # and neither the path nor a not-found message is echoed back.
    assert _payload(miss) == body
    assert str(tmp_path) not in hit.content[0].text
    assert 'not found' not in hit.content[0].text.lower()


@pytest.mark.asyncio
async def test_local_engine_lists_and_runs_send_files(fake_engine):
    from ai.modules.mcp.handlers import build_mcp_server

    server = build_mcp_server(lambda: fake_engine, local_engine=True)
    async with Client(server) as client:
        names = {t.name for t in (await client.list_tools()).tools}
        result = await client.call_tool('send_files', {'task_token': 'tok-1', 'files': ['/tmp/a.pdf']})

    assert 'send_files' in names
    assert result.is_error is False
    assert _payload(result) == {'ok': True, 'result': {'uploaded': 1}}
    assert fake_engine.sent_files == [{'files': ['/tmp/a.pdf'], 'token': 'tok-1'}]


def test_registry_defaults_to_deployed_surface():
    """Fail closed: a caller that does not say the engine is local gets the
    full surface minus the host-filesystem tools.
    """
    from ai.modules.mcp.tooling import ToolRegistry
    from ai.modules.mcp.tools import register_all

    from .conftest import EXPECTED_TOOL_NAMES, LOCAL_ENGINE_ONLY_TOOL_NAMES

    registry = ToolRegistry()
    register_all(registry)

    deployed = [n for n in EXPECTED_TOOL_NAMES if n not in LOCAL_ENGINE_ONLY_TOOL_NAMES]
    assert registry.names() == deployed
    assert [t.name for t in registry.tools()] == deployed


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ('host', 'offered'),
    [('127.0.0.1', True), ('localhost', True), ('::1', True), ('0.0.0.0', False), ('10.0.0.5', False), ('', False)],
)
async def test_initmodule_offers_send_files_only_on_loopback_binds(monkeypatch, fake_web_server, host, offered):
    captured = _init(monkeypatch, fake_web_server, host)

    async with Client(captured['server']) as client:
        names = {t.name for t in (await client.list_tools()).tools}

    assert ('send_files' in names) is offered


def test_send_files_description_names_the_engine_filesystem():
    from ai.modules.mcp.tooling import ToolRegistry
    from ai.modules.mcp.tools import execution

    registry = ToolRegistry(local_engine=True)
    execution.register(registry)
    tool = next(t for t in registry.tools() if t.name == 'send_files')

    text = (tool.description + ' ' + tool.input_schema['properties']['files']['description']).lower()
    assert 'store-relative' not in text
    assert 'engine' in text and 'filesystem' in text
    assert 'local' in tool.description.lower()


def test_run_pipeline_description_is_inline_only():
    from ai.modules.mcp.tooling import ToolRegistry
    from ai.modules.mcp.tools import execution

    registry = ToolRegistry()
    execution.register(registry)
    tool = next(t for t in registry.tools() if t.name == 'run_pipeline')

    assert 'filepath' not in tool.description.lower()
    assert 'inline' in tool.description.lower()
