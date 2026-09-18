# Copyright 2026 Aparavi Software AG. MIT License.
"""Behaviour gated on whether this engine is local (loopback-bound).

A loopback bind means the MCP caller and the engine share a machine, so the
engine host's filesystem is the caller's own. Any other bind is a deployed
engine: its host is our server, not the caller's machine.

- ``send_files`` reads caller-supplied paths off the engine host, so a
  deployed engine neither lists nor runs it.
- The SDK forwards its process env (``ROCKETRIDE_*`` from ``os.environ`` and
  ``./.env``) on ``use()``, and the engine applies that env over the caller's
  own org/team/user secrets, so a deployed engine sends none.
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


# ---------------------------------------------------------------------------
# SDK env: deployed engines send none
# ---------------------------------------------------------------------------


def _shared_and_per_caller(factory):
    from ai.modules.mcp import identity

    shared = factory()
    token = identity.CALLER_AUTH.set('rr_caller')
    try:
        per_caller = factory()
    finally:
        identity.CALLER_AUTH.reset(token)
    return shared, per_caller


async def _execute_arguments(engine_client):
    """Drive the real SDK ``use()`` through the seam; capture its ``execute`` arguments."""
    calls = []

    async def _call(command, **arguments):
        calls.append((command, arguments))
        return {'token': 'tok-1'}

    engine_client._client.call = _call
    engine_client._connected = True  # skip the socket; use() itself is the real SDK
    await engine_client.use(pipeline={'source': 'a', 'components': []})
    assert [c for c, _ in calls] == ['execute']
    return calls[0][1]


@pytest.fixture
def _server_env(monkeypatch, tmp_path):
    """ROCKETRIDE_* vars the engine process itself carries, via env and ./.env."""
    monkeypatch.setenv('ROCKETRIDE_FOO', 'server-secret')
    (tmp_path / '.env').write_text('ROCKETRIDE_DOTENV=server-dotenv\n')
    monkeypatch.chdir(tmp_path)


@pytest.mark.asyncio
@pytest.mark.parametrize('host', ['0.0.0.0', '10.0.0.5', ''])
async def test_deployed_engine_clients_send_no_env(monkeypatch, fake_web_server, _server_env, host):
    captured = _init(monkeypatch, fake_web_server, host)

    for engine_client in _shared_and_per_caller(captured['factory']):
        assert engine_client._client._env == {}
        arguments = await _execute_arguments(engine_client)
        assert 'env' not in arguments


def test_deployed_engine_clients_keep_explicit_uri_and_auth(monkeypatch, fake_web_server, _server_env):
    captured = _init(monkeypatch, fake_web_server, '0.0.0.0', config={'rocketride_uri': 'wss://engine.example'})

    shared, per_caller = _shared_and_per_caller(captured['factory'])

    for engine_client in (shared, per_caller):
        assert engine_client._client._env == {}
        assert engine_client.base_url == 'https://engine.example'
        assert engine_client._client._uri.startswith('wss://engine.example')
    assert shared._client._apikey == 'svc-key'
    assert per_caller._client._apikey == 'rr_caller'


@pytest.mark.asyncio
@pytest.mark.parametrize('host', ['127.0.0.1', 'localhost', '::1'])
async def test_local_engine_clients_keep_sdk_default_env(monkeypatch, fake_web_server, _server_env, host):
    captured = _init(monkeypatch, fake_web_server, host)

    for engine_client in _shared_and_per_caller(captured['factory']):
        arguments = await _execute_arguments(engine_client)
        assert arguments['env']['ROCKETRIDE_FOO'] == 'server-secret'
        assert arguments['env']['ROCKETRIDE_DOTENV'] == 'server-dotenv'
