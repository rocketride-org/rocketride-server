# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
A fake GitHub API for the credential, write and installation tests.

``FakeGitHub`` stands in for ``requests.request``: it answers the App's installation
lookups and token mints itself and every other call from ``routes``, recording each
request with the bearer it carried. ``real_node`` builds the node's real IGlobal and
IInstance from a config, so map parsing, installation lookups, token caches and the
redaction wrapper all run as in the engine. Every credential here is a fake.
"""

from __future__ import annotations

import datetime
import io
import json
import re
import time
from contextlib import contextmanager
from dataclasses import dataclass
from types import SimpleNamespace

import requests

from ._stubs import conn_config, scoped_stubs

RATE_HEADERS = {
    'X-RateLimit-Remaining': '4999',
    'X-RateLimit-Limit': '5000',
    'X-RateLimit-Reset': '2000000000',
    'X-RateLimit-Resource': 'core',
}
RATE = {'remaining': 4999, 'limit': 5000, 'reset': 2000000000, 'resource': 'core'}


def response(payload, status=200, headers=None, raw=None) -> requests.Response:
    """A response whose body is read from ``raw``, so both loaded and streamed reads work."""
    resp = requests.Response()
    resp.status_code = status
    resp.headers.update(RATE_HEADERS if headers is None else headers)
    resp.raw = io.BytesIO(json.dumps(payload).encode() if raw is None else raw)
    return resp


@dataclass
class Call:
    method: str
    path: str
    bearer: str
    params: dict | None
    body: dict | None


class FakeGitHub:
    """``requests.request`` for tests: installation lookups, token mints and routed answers."""

    def __init__(self) -> None:
        self.installations: dict[str, int] = {}
        self.routes: dict = {}
        self.calls: list[Call] = []
        self.expires_in = 3600
        self.lookup_status: int | None = None
        self.mint_status: int | None = None
        # Installations whose token request answers 404, as after the App was reinstalled.
        self.mint_missing: set[str] = set()
        # Seconds each token request takes, so concurrent calls overlap.
        self.mint_delay = 0.0

    def __call__(self, method, url, headers=None, params=None, json=None, timeout=None, stream=False):
        path = url.removeprefix('https://api.github.com')
        bearer = (headers or {}).get('Authorization', '').removeprefix('Bearer ')
        call = Call(method, path, bearer, params, json)
        self.calls.append(call)
        found = re.fullmatch(r'/repos/([^/]+/[^/]+)/installation', path)
        if method == 'GET' and found:
            if self.lookup_status is not None:
                return response({'message': f'refused {bearer}'}, self.lookup_status)
            installation = self.installations.get(found.group(1).lower())
            if installation is None:
                return response({'message': f'Not Found {bearer}'}, 404)
            return response({'id': installation, 'app_id': 1})
        found = re.fullmatch(r'/app/installations/([0-9]+)/access_tokens', path)
        if method == 'POST' and found:
            if self.mint_status is not None:
                # GitHub refusing the JWT and, as a worst case, echoing it.
                return response({'message': f'Bad credentials {bearer}'}, self.mint_status)
            installation = found.group(1)
            if installation in self.mint_missing:
                return response({'message': 'Not Found'}, 404)
            if self.mint_delay:
                time.sleep(self.mint_delay)
            count = 1 + sum(1 for c in self.calls if c.path == path and c is not call)
            expires = datetime.datetime.fromtimestamp(time.time() + self.expires_in, datetime.timezone.utc)
            return response(
                {'token': f'ghs_fake_{installation}_{count}', 'expires_at': expires.strftime('%Y-%m-%dT%H:%M:%SZ')},
                201,
            )
        route = self.routes.get((method, path))
        if route is None:
            # Loud on purpose: a request to a path no test set up is a 404, never a quiet success.
            return response({'message': f'Not Found: no route for {method} {path}'}, 404)
        return route(call) if callable(route) else route

    def requests_to(self, path_prefix: str) -> list[Call]:
        return [call for call in self.calls if call.path.startswith(path_prefix)]

    def bearer_for(self, path: str) -> str:
        """The bearer of the last request to exactly ``path``."""
        return [call for call in self.calls if call.path == path][-1].bearer


@contextmanager
def real_node(cfg: dict):
    """The node's real IGlobal (beginGlobal on ``cfg``) under a real IInstance."""
    with scoped_stubs(cfg):
        from tool_github.IGlobal import IGlobal
        from tool_github.IInstance import IInstance

        glb = IGlobal()
        glb.IEndpoint = SimpleNamespace(endpoint=SimpleNamespace(openMode='open'))
        glb.glb = SimpleNamespace(logicalType='tool_github', connConfig=conn_config())
        glb.beginGlobal()
        inst = IInstance()
        inst.IGlobal = glb
        yield inst


def dispatch(inst, tool: str, args: dict):
    """Run a tool the way the engine does: through the published tool map."""
    return inst._collect_tool_methods()[tool](args)


def app(pem: str, app_id: str = '111', installation_id: str | None = None) -> dict:
    """A GitHub App credential object for a credentialMap value."""
    entry = {'appId': app_id, 'privateKey': pem}
    if installation_id is not None:
        entry['installationId'] = installation_id
    return entry


def app_config(pem: str, **overrides) -> dict:
    """Node config for GitHub App auth without an installation ID."""
    return {'authType': 'app', 'appId': '111', 'privateKey': pem, 'installationId': '', **overrides}


def claims(bearer: str, pem: str) -> dict:
    """Verify an App JWT's signature with the key and return its claims (times not checked)."""
    import jwt
    from cryptography.hazmat.primitives import serialization

    key = serialization.load_pem_private_key(pem.encode(), password=None).public_key()
    return jwt.decode(bearer, key, algorithms=['RS256'], options={'verify_exp': False, 'verify_iat': False})
