# Copyright 2026 Aparavi Software AG. MIT License.
"""OpenAI plugin domain verification: serve the challenge token.

OpenAI's plugin portal checks that we control the MCP host by fetching
``https://<host>/.well-known/openai-apps-challenge`` and comparing the body,
byte for byte, with the token it generated. The token comes from
``MCP_OPENAI_APPS_CHALLENGE_TOKEN``; when that is unset or blank the route
answers 404. The route is registered public on every boot, because an
unregistered path is private by default and would answer 401 instead.
"""

from __future__ import annotations

import os
from typing import Any, Optional

from fastapi.responses import PlainTextResponse

CHALLENGE_PATH = '/.well-known/openai-apps-challenge'
ENV_CHALLENGE_TOKEN = 'MCP_OPENAI_APPS_CHALLENGE_TOKEN'

_NO_STORE = {'Cache-Control': 'no-store'}


def challenge_token() -> Optional[str]:
    """Return the configured token with surrounding whitespace removed, or ``None``."""
    value = (os.environ.get(ENV_CHALLENGE_TOKEN) or '').strip()
    return value or None


async def openai_apps_challenge() -> PlainTextResponse:
    """Serve the exact token as plain text, or 404 when none is configured."""
    token = challenge_token()
    if token is None:
        return PlainTextResponse('Not Found', status_code=404, headers=_NO_STORE)
    return PlainTextResponse(token, headers=_NO_STORE)


def register_routes(server: Any) -> str:
    """Mount the challenge route as a public GET; return its path."""
    server.add_route(CHALLENGE_PATH, openai_apps_challenge, ['GET'], public=True)
    return CHALLENGE_PATH
