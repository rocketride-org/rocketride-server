# Copyright 2026 Aparavi Software AG. MIT License.
"""The engine URI MCP tools connect back to is resolved once, at module init.

Rules, in order:

1. Explicit ``rocketride_uri`` config / ``ROCKETRIDE_URI`` env wins, as-is.
2. Loopback-only bind -> the engine's own local address (``ws://<host>:<port>``),
   so a laptop engine never silently drives RocketRide's cloud.
3. Otherwise -> the public origin of ``MCP_RESOURCE_IDENTIFIER``
   (``https`` -> ``wss``, ``http`` -> ``ws``, path dropped).

That single value feeds the shared and per-caller engine clients, the widget
CSP ``connectDomains`` origin, and the user-facing upload/dropper links.
"""

import logging

import pytest

_UNSET = object()


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for name in ('ROCKETRIDE_URI', 'MCP_RESOURCE_IDENTIFIER', 'MCP_DEV_NO_AUTH', 'ROCKETRIDE_AUTH'):
        monkeypatch.delenv(name, raising=False)
    # The shared client still needs a credential; the URI is what is under test.
    monkeypatch.setenv('ROCKETRIDE_APIKEY', 'svc-key')


def _init(monkeypatch, fake_web_server, *, host=_UNSET, port=_UNSET, config=None):
    """Run initModule on a fake server bound at host/port; capture its wiring."""
    import ai.modules.mcp as mcp_module

    server_config = {}
    if host is not _UNSET:
        server_config['host'] = host
    if port is not _UNSET:
        server_config['port'] = port
    fake_web_server.config = server_config

    captured = {}
    real_build = mcp_module.build_mcp_server

    def _capture(engine_factory, task_registry=None, **kwargs):
        captured['factory'] = engine_factory
        captured['engine_origin'] = kwargs.get('engine_origin')
        return real_build(engine_factory, task_registry, **kwargs)

    monkeypatch.setattr(mcp_module, 'build_mcp_server', _capture)
    mcp_module.initModule(fake_web_server, dict(config or {}))
    return captured


def _assert_wiring(captured, uri, origin):
    """Shared client, per-caller client and CSP origin all carry the resolution."""
    from ai.modules.mcp import identity

    shared = captured['factory']()
    assert shared._uri == uri
    assert shared.base_url == origin

    token = identity.CALLER_AUTH.set('rr_caller')
    try:
        per_caller = captured['factory']()
    finally:
        identity.CALLER_AUTH.reset(token)
    assert per_caller is not shared
    assert per_caller._uri == uri
    assert per_caller.base_url == origin

    assert captured['engine_origin'] == origin


# ---------------------------------------------------------------------------
# Rule 1: explicit wins
# ---------------------------------------------------------------------------


def test_explicit_env_uri_used_unchanged_even_on_public_bind(monkeypatch, fake_web_server):
    monkeypatch.setenv('ROCKETRIDE_URI', 'wss://engine-host:5565')
    captured = _init(monkeypatch, fake_web_server, host='0.0.0.0', port=5565)
    _assert_wiring(captured, 'wss://engine-host:5565', 'https://engine-host:5565')


def test_explicit_cleartext_loopback_uri_is_used_unchanged_on_a_loopback_bind(monkeypatch, fake_web_server):
    """A loopback engine never puts the credential on a wire anyone can read."""
    monkeypatch.setenv('ROCKETRIDE_URI', 'ws://127.0.0.1:5565')
    captured = _init(monkeypatch, fake_web_server, host='127.0.0.1', port=5565)
    _assert_wiring(captured, 'ws://127.0.0.1:5565', 'http://127.0.0.1:5565')


def test_explicit_config_uri_beats_env_and_loopback_default(monkeypatch, fake_web_server):
    monkeypatch.setenv('ROCKETRIDE_URI', 'ws://from-env:1')
    captured = _init(
        monkeypatch,
        fake_web_server,
        host='127.0.0.1',
        port=5565,
        config={'rocketride_uri': 'wss://from-config.example'},
    )
    _assert_wiring(captured, 'wss://from-config.example', 'https://from-config.example')


def test_init_does_not_mutate_callers_config(monkeypatch, fake_web_server):
    import ai.modules.mcp as mcp_module

    fake_web_server.config = {'host': '127.0.0.1', 'port': 5565}
    config = {'mcp_dev_no_auth': False}
    mcp_module.initModule(fake_web_server, config)
    assert config == {'mcp_dev_no_auth': False}


# ---------------------------------------------------------------------------
# Rule 2: loopback bind -> the engine's own local address
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ('host', 'port', 'uri', 'origin'),
    [
        ('127.0.0.1', 5565, 'ws://127.0.0.1:5565', 'http://127.0.0.1:5565'),
        ('localhost', 6000, 'ws://127.0.0.1:6000', 'http://127.0.0.1:6000'),
        ('::1', 5565, 'ws://[::1]:5565', 'http://[::1]:5565'),
    ],
)
def test_loopback_bind_defaults_to_local_engine(monkeypatch, fake_web_server, host, port, uri, origin):
    monkeypatch.setenv('MCP_RESOURCE_IDENTIFIER', 'https://api-staging.rocketride.ai/mcp')
    captured = _init(monkeypatch, fake_web_server, host=host, port=port)
    _assert_wiring(captured, uri, origin)


def test_engine_default_bind_is_loopback_on_default_port(monkeypatch, fake_web_server):
    """No host/port configured anywhere -> WebServer binds localhost:5565."""
    captured = _init(monkeypatch, fake_web_server)
    _assert_wiring(captured, 'ws://127.0.0.1:5565', 'http://127.0.0.1:5565')


# ---------------------------------------------------------------------------
# Rule 3: public bind -> public origin of the MCP resource identifier
# ---------------------------------------------------------------------------


@pytest.mark.parametrize('host', ['0.0.0.0', 'engine.internal', '', None])
def test_public_bind_defaults_to_public_resource_origin(monkeypatch, fake_web_server, host):
    captured = _init(monkeypatch, fake_web_server, host=host, port=5565)
    _assert_wiring(captured, 'wss://api.rocketride.ai', 'https://api.rocketride.ai')


@pytest.mark.parametrize(
    ('resource', 'uri', 'origin'),
    [
        (
            'https://api-staging.rocketride.ai/mcp',
            'wss://api-staging.rocketride.ai',
            'https://api-staging.rocketride.ai',
        ),
    ],
)
def test_public_bind_follows_configured_resource_identifier(monkeypatch, fake_web_server, resource, uri, origin):
    monkeypatch.setenv('MCP_RESOURCE_IDENTIFIER', resource)
    captured = _init(monkeypatch, fake_web_server, host='0.0.0.0', port=5565)
    _assert_wiring(captured, uri, origin)


def test_unset_uri_no_longer_raises_missing_engine_uri(monkeypatch, fake_web_server):
    captured = _init(monkeypatch, fake_web_server, host='0.0.0.0', port=5565)
    captured['factory']()  # would raise 'Missing engine URI' before the default


def test_shared_client_still_requires_auth(monkeypatch, fake_web_server):
    monkeypatch.delenv('ROCKETRIDE_APIKEY', raising=False)
    captured = _init(monkeypatch, fake_web_server, host='0.0.0.0', port=5565)
    with pytest.raises(ValueError, match='Missing engine auth'):
        captured['factory']()


# ---------------------------------------------------------------------------
# User-facing surfaces: CSP and upload/dropper links
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_widget_csp_uses_resolved_public_origin(monkeypatch, fake_web_server, tmp_path):
    from mcp.client import Client

    import ai.modules.mcp.handlers as handlers_mod
    from ai.modules.mcp import apps

    captured = _init(monkeypatch, fake_web_server, host='0.0.0.0', port=5565)
    (tmp_path / 'dropper.html').write_text('<!doctype html><html><body>d</body></html>', encoding='utf-8')
    server = handlers_mod.build_mcp_server(
        captured['factory'], apps_dir=tmp_path, engine_origin=captured['engine_origin']
    )
    async with Client(server) as client:
        listed = await client.list_resources()
    dropper = next(r for r in listed.resources if str(r.uri) == apps.DROPPER_URI)
    assert dropper.meta == {'ui': {'csp': {'connectDomains': ['https://api.rocketride.ai']}}}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ('host', 'env_uri', 'origin'),
    [
        ('0.0.0.0', None, 'https://api.rocketride.ai'),
        ('127.0.0.1', None, 'http://127.0.0.1:5565'),
        ('127.0.0.1', 'wss://engine-host:5565', 'https://engine-host:5565'),
    ],
)
async def test_dropper_links_use_resolved_origin(monkeypatch, fake_web_server, fake_engine, host, env_uri, origin):
    from ai.modules.mcp.registry import TaskRegistry
    from ai.modules.mcp.tooling import ToolRegistry
    from ai.modules.mcp.tools import execution

    if env_uri:
        monkeypatch.setenv('ROCKETRIDE_URI', env_uri)
    captured = _init(monkeypatch, fake_web_server, host=host, port=5565)
    # The real client the factory builds decides base_url; the fake only
    # stands in for the engine round-trip.
    fake_engine.base_url = captured['factory']().base_url

    registry = ToolRegistry()
    execution.register(registry)
    result = await registry.handler('run_dropper_pipe')(
        fake_engine, TaskRegistry(), {'pipeline': {'components': [], 'source': 'x'}}
    )

    assert result['ok'] is True, result
    assert result['upload_url'].startswith(f'{origin}/task/data?auth=')
    assert result['dropper_url'].startswith(f'{origin}/dropper?auth=')


# ---------------------------------------------------------------------------
# Startup log
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ('host', 'env_uri', 'rule', 'shown'),
    [
        ('0.0.0.0', 'wss://user:secret@engine-host/?auth=hunter2', 'explicit', 'wss://engine-host/'),
        ('127.0.0.1', None, 'loopback default', 'ws://127.0.0.1:5565'),
        ('0.0.0.0', None, 'public default', 'wss://api.rocketride.ai'),
    ],
)
def test_logs_one_startup_line_without_credentials(monkeypatch, fake_web_server, caplog, host, env_uri, rule, shown):
    if env_uri:
        monkeypatch.setenv('ROCKETRIDE_URI', env_uri)
    with caplog.at_level(logging.INFO, logger='ai.modules.mcp'):
        _init(monkeypatch, fake_web_server, host=host, port=5565)
    lines = [r.getMessage() for r in caplog.records if 'engine URI' in r.getMessage()]
    assert len(lines) == 1, lines
    assert shown in lines[0]
    assert rule in lines[0]
    assert 'secret' not in lines[0] and 'hunter2' not in lines[0] and 'user' not in lines[0]


# ---------------------------------------------------------------------------
# Encrypted transport: a non-loopback bind must not put the caller credential
# on the wire in the clear.
#
# handle_mcp binds the CALLER's credential to the per-request engine client,
# and WsEngineClient sends it in the first DAP `auth` message. On ws:// that
# frame is plaintext, so every MCP caller's key is exposed to the path.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize('host', ['0.0.0.0', 'engine.internal', '', None])
@pytest.mark.parametrize('uri', ['ws://engine-host:5565', 'http://engine-host:5565'])
def test_explicit_cleartext_uri_is_refused_on_a_non_loopback_bind(monkeypatch, fake_web_server, host, uri):
    monkeypatch.setenv('ROCKETRIDE_URI', uri)
    with pytest.raises(RuntimeError) as excinfo:
        _init(monkeypatch, fake_web_server, host=host, port=5565)
    message = str(excinfo.value)
    assert 'ROCKETRIDE_URI' in message, message  # names the variable it came from
    assert 'engine-host' in message, message  # names the offending value


def test_explicit_cleartext_uri_from_config_names_the_config_key(monkeypatch, fake_web_server):
    with pytest.raises(RuntimeError, match='rocketride_uri'):
        _init(monkeypatch, fake_web_server, host='0.0.0.0', port=5565, config={'rocketride_uri': 'ws://engine:1'})


def test_cleartext_resource_identifier_is_refused_on_a_non_loopback_bind(monkeypatch, fake_web_server):
    """The derived case: http:// resource identifier -> ws:// engine URI."""
    monkeypatch.setenv('MCP_RESOURCE_IDENTIFIER', 'http://example.test:8080/mcp')
    with pytest.raises(RuntimeError) as excinfo:
        _init(monkeypatch, fake_web_server, host='0.0.0.0', port=5565)
    message = str(excinfo.value)
    assert 'MCP_RESOURCE_IDENTIFIER' in message, message
    assert 'example.test:8080' in message, message


def test_loopback_default_keeps_its_cleartext_local_uri(monkeypatch, fake_web_server):
    """Rule 2 resolves ws://127.0.0.1 by design; the guard must not break it."""
    captured = _init(monkeypatch, fake_web_server, host='localhost', port=5565)
    _assert_wiring(captured, 'ws://127.0.0.1:5565', 'http://127.0.0.1:5565')


@pytest.mark.parametrize('host', ['0.0.0.0', 'engine.internal', '', None, '127.0.0.1', 'localhost', '::1'])
@pytest.mark.parametrize(
    ('uri', 'origin'),
    [
        ('ws://127.0.0.1:5565', 'http://127.0.0.1:5565'),
        ('http://localhost:5565', 'http://localhost:5565'),
        ('ws://localhost:5565', 'http://localhost:5565'),
        ('ws://127.0.0.53:5565', 'http://127.0.0.53:5565'),  # anywhere in 127.0.0.0/8
        ('ws://[::1]:5565', 'http://[::1]:5565'),
        ('http://LOCALHOST:5565', 'http://LOCALHOST:5565'),
    ],
)
def test_cleartext_to_a_loopback_target_is_kept_whatever_the_bind(monkeypatch, fake_web_server, host, uri, origin):
    """The rule keys on the TARGET, not the bind.

    A credential sent to `ws://127.0.0.1:5565` never reaches a wire anyone can
    tap, so there is nothing to protect. Refusing it would break every
    deployment whose image carries the shipped `dist/server/.env`
    (`ROCKETRIDE_URI=http://localhost:5565`, copied in by
    `docker/Dockerfile.engine`) -- the pod would fail to boot over a credential
    that never leaves it.
    """
    monkeypatch.setenv('ROCKETRIDE_URI', uri)
    captured = _init(monkeypatch, fake_web_server, host=host, port=5565)
    _assert_wiring(captured, uri, origin)


def test_cleartext_loopback_resource_identifier_is_kept_on_a_public_bind(monkeypatch, fake_web_server):
    """The derived case follows the same rule: the target decides."""
    monkeypatch.setenv('MCP_RESOURCE_IDENTIFIER', 'http://localhost:8080/mcp')
    captured = _init(monkeypatch, fake_web_server, host='0.0.0.0', port=5565)
    assert captured['factory']()._uri == 'ws://localhost:8080'


def test_a_non_loopback_target_is_still_refused_on_a_public_bind(monkeypatch, fake_web_server):
    """Narrowing the rule must not reopen the hole it was written to close."""
    monkeypatch.setenv('ROCKETRIDE_URI', 'ws://engine.internal:5565')
    with pytest.raises(RuntimeError) as excinfo:
        _init(monkeypatch, fake_web_server, host='0.0.0.0', port=5565)
    assert 'engine.internal' in str(excinfo.value)


@pytest.mark.parametrize('host', ['127.0.0.1', 'localhost', '::1'])
@pytest.mark.parametrize('uri', ['ws://engine.remote:5565', 'http://engine.remote:5565'])
def test_explicit_cleartext_remote_uri_is_refused_on_a_loopback_bind(monkeypatch, fake_web_server, host, uri):
    """The BIND never made the wire safe -- only the TARGET does.

    A loopback-bound MCP server pointed at `ws://engine.remote:5565` still hands
    the caller's credential to `WsEngineClient`, which puts it on the network in
    the first DAP `auth` frame. The explicit branch must not skip the check.
    """
    monkeypatch.setenv('ROCKETRIDE_URI', uri)
    with pytest.raises(RuntimeError) as excinfo:
        _init(monkeypatch, fake_web_server, host=host, port=5565)
    message = str(excinfo.value)
    assert 'ROCKETRIDE_URI' in message, message
    assert 'engine.remote' in message, message


def test_explicit_cleartext_remote_uri_from_config_is_refused_on_a_loopback_bind(monkeypatch, fake_web_server):
    with pytest.raises(RuntimeError, match='rocketride_uri'):
        _init(
            monkeypatch,
            fake_web_server,
            host='127.0.0.1',
            port=5565,
            config={'rocketride_uri': 'ws://engine.remote:5565'},
        )


def test_explicit_cleartext_refusal_on_a_loopback_bind_stays_redacted(monkeypatch, fake_web_server):
    monkeypatch.setenv('ROCKETRIDE_URI', 'ws://user:secret@engine.remote:5565')
    with pytest.raises(RuntimeError) as excinfo:
        _init(monkeypatch, fake_web_server, host='127.0.0.1', port=5565)
    assert 'secret' not in str(excinfo.value), 'the refusal must stay redacted'


@pytest.mark.parametrize('host', ['127.0.0.1', 'localhost', '::1', '0.0.0.0', None])
def test_explicit_encrypted_remote_uri_is_accepted_on_any_bind(monkeypatch, fake_web_server, host):
    monkeypatch.setenv('ROCKETRIDE_URI', 'wss://engine.remote:5565')
    captured = _init(monkeypatch, fake_web_server, host=host, port=5565)
    _assert_wiring(captured, 'wss://engine.remote:5565', 'https://engine.remote:5565')


@pytest.mark.parametrize(
    'uri',
    [
        'ws://127.0.0.1.evil.test:5565',  # loopback literal as a LABEL, not the host
        'ws://localhost.evil.test:5565',
        'ws://notlocalhost:5565',
        'ws://user:secret@engine.internal:5565',  # userinfo must not be read as the host
    ],
)
def test_hosts_that_only_look_loopback_are_still_refused(monkeypatch, fake_web_server, uri):
    monkeypatch.setenv('ROCKETRIDE_URI', uri)
    with pytest.raises(RuntimeError) as excinfo:
        _init(monkeypatch, fake_web_server, host='0.0.0.0', port=5565)
    assert 'secret' not in str(excinfo.value), 'the refusal must stay redacted'


@pytest.mark.parametrize(
    ('resource', 'uri'),
    [
        ('https://api-staging.rocketride.ai/mcp', 'wss://api-staging.rocketride.ai'),
        ('https://api.rocketride.ai/mcp', 'wss://api.rocketride.ai'),
    ],
)
def test_https_staging_and_prod_defaults_still_resolve(monkeypatch, fake_web_server, resource, uri):
    monkeypatch.setenv('MCP_RESOURCE_IDENTIFIER', resource)
    captured = _init(monkeypatch, fake_web_server, host='0.0.0.0', port=5565)
    assert captured['factory']()._uri == uri


# ---------------------------------------------------------------------------
# Startup bind-mode log
#
# is_loopback_bind() judges the CONFIGURED host by name and the default host is
# 'localhost', so a deployment that never sets `host` silently runs as a local
# engine. The log has to say so in the first lines, or the misconfiguration is
# invisible until something leaks.
# ---------------------------------------------------------------------------


def _mode_lines(caplog):
    return [r for r in caplog.records if 'bind mode' in r.getMessage()]


def test_public_bind_logs_the_deployed_mode(monkeypatch, fake_web_server, caplog):
    with caplog.at_level(logging.INFO, logger='ai.modules.mcp'):
        _init(monkeypatch, fake_web_server, host='0.0.0.0', port=5565)

    info = [r.getMessage() for r in _mode_lines(caplog) if r.levelno == logging.INFO]
    assert len(info) == 1, info
    assert 'public/deployed' in info[0]
    assert 'host=0.0.0.0' in info[0]
    assert 'MCP_DEV_NO_AUTH' in info[0] and 'send_files' in info[0] and 'env' in info[0]
    assert not [r for r in _mode_lines(caplog) if r.levelno >= logging.WARNING]


def test_explicit_loopback_host_logs_local_mode_without_warning(monkeypatch, fake_web_server, caplog):
    with caplog.at_level(logging.INFO, logger='ai.modules.mcp'):
        _init(monkeypatch, fake_web_server, host='127.0.0.1', port=5565)

    info = [r.getMessage() for r in _mode_lines(caplog) if r.levelno == logging.INFO]
    assert len(info) == 1, info
    assert 'local/loopback' in info[0]
    assert 'host=127.0.0.1' in info[0]
    assert not [r for r in _mode_lines(caplog) if r.levelno >= logging.WARNING]


def test_loopback_by_fallback_warns_that_nobody_configured_a_host(monkeypatch, fake_web_server, caplog):
    """The silent-misconfiguration case: local privileges nobody asked for."""
    with caplog.at_level(logging.INFO, logger='ai.modules.mcp'):
        _init(monkeypatch, fake_web_server)  # no host anywhere

    assert 'local/loopback' in [r.getMessage() for r in _mode_lines(caplog) if r.levelno == logging.INFO][0]
    warnings = [r.getMessage() for r in _mode_lines(caplog) if r.levelno == logging.WARNING]
    assert len(warnings) == 1, warnings
    assert 'no host is configured' in warnings[0]


def test_bind_mode_is_logged_before_a_failing_engine_uri(monkeypatch, fake_web_server, caplog):
    """A refused engine URI must not swallow the line that explains the bind."""
    monkeypatch.setenv('ROCKETRIDE_URI', 'ws://engine-host:5565')
    with caplog.at_level(logging.INFO, logger='ai.modules.mcp'):
        with pytest.raises(RuntimeError):
            _init(monkeypatch, fake_web_server, host='0.0.0.0', port=5565)

    assert [r.getMessage() for r in _mode_lines(caplog)], 'bind mode must be logged before the URI is resolved'
