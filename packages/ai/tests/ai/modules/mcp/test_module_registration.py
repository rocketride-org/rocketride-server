# Copyright 2026 Aparavi Software AG. MIT License.
"""Regression test for the engine-boot allowlist gap.

`WebServer.use()` (packages/ai/src/ai/web/server.py) raises ValueError for any
module name not present in `ai.modules.ALL`, and `eaas.py` calls
`server.use('mcp')` at boot. If 'mcp' is ever dropped from the allowlist again,
the engine fails to start entirely — this pins the membership so that
regression is caught immediately by the test suite instead of at boot time.
"""

import pytest


def test_mcp_is_in_module_allowlist():
    import ai.modules

    assert 'mcp' in ai.modules.ALL


@pytest.mark.asyncio
async def test_webserver_use_mcp_does_not_raise_and_mounts_route(monkeypatch, fake_engine):
    """Best-effort smoke test against the real WebServer.use() path.

    Confirms the allowlist fix actually unblocks `server.use('mcp')` end to
    end (not just the membership check) and that the module mounts `/mcp`.
    Uses the module's own `make_engine_client` monkeypatch (as the other MCP
    module tests do) so no real ROCKETRIDE_URI/AUTH is required.
    """
    pytest.importorskip('rocketlib')  # WebServer needs the engine env
    from ai.web.server import WebServer
    import ai.modules.mcp as mcp_module

    monkeypatch.setattr(mcp_module, 'make_engine_client', lambda cfg, on_event=None: fake_engine)

    server = WebServer()
    server.use('mcp', {'mcp_dev_no_auth': True})

    paths = {getattr(r, 'path', None) for r in server.app.routes}
    assert any(p and p.startswith('/mcp') for p in paths)


@pytest.mark.asyncio
async def test_webserver_use_mcp_default_mounts_authenticated(monkeypatch, fake_engine):
    """The production default (no dev bypass) must also mount /mcp — and must
    NOT mark it public, so AuthMiddleware keeps protecting it.
    """
    pytest.importorskip('rocketlib')  # WebServer needs the engine env
    from ai.web.server import WebServer
    import ai.modules.mcp as mcp_module

    monkeypatch.setattr(mcp_module, 'make_engine_client', lambda cfg, on_event=None: fake_engine)

    server = WebServer()
    server.use('mcp', {})

    paths = {getattr(r, 'path', None) for r in server.app.routes}
    assert any(p and p.startswith('/mcp') for p in paths)
    # _public_paths must exist (a rename would silently void this assertion
    # via a getattr fallback), and neither mount-path form may be public.
    assert hasattr(server, '_public_paths'), 'WebServer public-path backing list moved/renamed'
    public = list(server._public_paths or [])
    assert '/mcp' not in public
    assert '/mcp/' not in public
