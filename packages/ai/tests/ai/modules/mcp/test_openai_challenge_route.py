# Copyright 2026 Aparavi Software AG. MIT License.
"""The challenge route through the real WebServer and AuthMiddleware.

``WebServer()`` loads ``dist/server/.env``, so each test sets or clears the
variable after construction. The handler reads it per request, so that order
keeps the result independent of a developer's local settings.
"""

import pytest

from ai.web.openai_apps_challenge import CHALLENGE_PATH, ENV_CHALLENGE_TOKEN

from .test_route_reservation import _HEADERS, _TOOLS_CALL, _eaas_order, _serve, _web_server


@pytest.mark.asyncio
async def test_challenge_is_served_without_credentials_when_configured(monkeypatch, tmp_path):
    server = _web_server(monkeypatch, tmp_path, [])
    monkeypatch.setenv(ENV_CHALLENGE_TOKEN, 'tok-xyz')
    _eaas_order(server)

    async with _serve(server) as app:
        challenge = await app.get(CHALLENGE_PATH)
        mcp = await app.post('/mcp', json=_TOOLS_CALL, headers=_HEADERS)

    assert challenge.status_code == 200
    assert challenge.content == b'tok-xyz'
    assert mcp.status_code == 401


@pytest.mark.asyncio
async def test_challenge_answers_404_not_401_when_unset(monkeypatch, tmp_path):
    server = _web_server(monkeypatch, tmp_path, [])
    monkeypatch.delenv(ENV_CHALLENGE_TOKEN, raising=False)
    _eaas_order(server)

    async with _serve(server) as app:
        challenge = await app.get(CHALLENGE_PATH)

    assert challenge.status_code == 404
