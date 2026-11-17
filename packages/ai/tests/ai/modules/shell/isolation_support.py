# MIT License
#
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE

"""Shared support for the #1022 PR1 (app-origin) tests.

The PR1 tests are written before the product code, so this module is also the
list of SEAMS the implementation has to honour. Everything a test patches or
reads is named here:

* Configuration comes from ``os.environ`` at CALL time (``load_isolation_config``
  and the helpers that take a ``config=`` argument), never from an import-time
  snapshot, so ``monkeypatch.setenv`` works.
* The static tree is located from ``ai.modules.shell.shell._shell_root`` (the
  existing seam): the capabilities data file is
  ``<_shell_root>/isolation/capabilities.json`` and the guest runtime marker is
  ``<dirname(_shell_root)>/shell-guest/runtime.json`` (``frame.html`` and the
  guest bundle sit beside it).
* Time-to-live logic reads ``time.time()`` (as ``shell.py``'s caches do).
* Account behaviour is reached through the ``ai.account.account`` singleton
  (``account_info_for``, ``is_first_party``, ``approved_capabilities``,
  ``publish_list``, ``deployments_*``) and through ``ai.account.app_deploy``
  (``entitled_version_dirs`` / ``open_version_dirs``), all looked up at call time.
* The store is read through ``ai.account.store.Store.instance()._store.read_bytes``,
  as ``_serve_versioned`` does.
* Asynchronous: ``account_info_for``, ``is_first_party``, ``resolve_isolation``,
  ``entitlement_ok`` and ``version_verdict`` are coroutines (they reach the
  registry); ``label_of``, ``stamp_isolation`` (after the verdict is known),
  ``wire_view``, ``mint_frame_token``, ``verify_frame_token`` and
  ``validate_network`` are plain functions.
"""

from __future__ import annotations

import base64
import hashlib
import importlib
import json
import secrets
import time
from html.parser import HTMLParser
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Dict, Iterable, List, Optional

import pytest
from fastapi import FastAPI, WebSocket  # module level: FastAPI resolves string annotations here
from fastapi.responses import JSONResponse

FIXTURES = Path(__file__).parent / 'fixtures' / 'isolation'

APPS_DOMAIN = 'apps.example'
TEMPLATE = 'https://{label}.apps.example'
LOCAL_TEMPLATE = 'http://{label}.apps.localhost:8765'
SHELL_ORIGIN = 'https://app.example'

CAPABILITIES_STUB = {
    'v': 1,
    'rows': [
        {'cap': 'core', 'op': 'client.request', 'command': 'rrext_ping', 'args': {}},
        {'cap': 'core', 'op': 'shell.frameToken.refresh', 'args': {}},
        {
            'cap': 'pipelines.run',
            'op': 'client.request',
            'command': 'terminate',
            'args': {'token': 'run-handle'},
        },
        {
            'cap': 'fs.app',
            'op': 'client.request',
            'command': 'rrext_store',
            'subcommands': ['fs_stat'],
            'args': {'subcommand': 'string', 'path': 'app-path'},
        },
    ],
}


# ---------------------------------------------------------------------------
# Modules that do not exist until the implementation lands
# ---------------------------------------------------------------------------


def load_module(name: str):
    """Import a module the fix adds; a missing one is a test FAILURE with a clear reason."""
    try:
        return importlib.import_module(name)
    except ModuleNotFoundError as exc:
        if exc.name == name:
            pytest.fail(f'module {name} does not exist yet (#1022 PR1)', pytrace=False)
        raise


def module_or_none(name: str):
    """Import a module that may not exist yet; None when it is absent (guards only)."""
    try:
        return importlib.import_module(name)
    except ModuleNotFoundError as exc:
        if exc.name == name:
            return None
        raise


def need(module, name: str):
    """One attribute of a fix module; a missing one is a test FAILURE, not an error."""
    if not hasattr(module, name):
        pytest.fail(f'{module.__name__}.{name} does not exist yet (#1022 PR1)', pytrace=False)
    return getattr(module, name)


# ---------------------------------------------------------------------------
# Keys, environment, static tree
# ---------------------------------------------------------------------------


def b64u(data: bytes) -> str:
    """URL-safe base64 without padding."""
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode('ascii')


def unb64u(text: str) -> bytes:
    """Inverse of ``b64u``."""
    return base64.urlsafe_b64decode(text + '=' * (-len(text) % 4))


def new_key(size: int = 32) -> bytes:
    """A fresh random key (generated per call; no key is ever committed)."""
    return secrets.token_bytes(size)


def key_entry(kid: str, key: bytes) -> str:
    """One ``kid:b64url`` entry of RR_APP_FRAME_TOKEN_KEYS."""
    return f'{kid}:{b64u(key)}'


def valid_env(**overrides: Optional[str]) -> Dict[str, str]:
    """The smallest VALID non-off configuration; ``name=None`` removes a variable."""
    env = {
        'RR_APP_ISOLATION': 'enforce',
        'RR_APP_ORIGIN_TEMPLATE': TEMPLATE,
        'RR_APP_FRAME_TOKEN_KEYS': key_entry('k1', new_key()),
        'RR_SHELL_ORIGINS': SHELL_ORIGIN,
    }
    for name, value in overrides.items():
        if value is None:
            env.pop(name, None)
        else:
            env[name] = value
    return env


ISOLATION_VARS = (
    'RR_APP_ISOLATION',
    'RR_APP_ISOLATION_APPS',
    'RR_APP_ORIGIN_TEMPLATE',
    'RR_APP_FRAME_TOKEN_KEYS',
    'RR_SHELL_ORIGINS',
    'RR_APP_HOST_SOURCE',
    'RR_EDGE_SECRET',
    'RR_FRONTEND_ORIGIN',
    'RR_APP_URL',
    'RR_TRUSTED_CLIENT_IP_HEADER',
)


def apply_env(monkeypatch, env: Dict[str, str]) -> None:
    """Make ``env`` THE isolation environment: every other isolation variable is unset."""
    for name in ISOLATION_VARS:
        monkeypatch.delenv(name, raising=False)
    for name, value in env.items():
        monkeypatch.setenv(name, value)


def write_static_tree(root: Path, *, runtime: Any = True, caps: Any = True, frame: bool = True) -> Path:
    """Build ``<root>/static`` with the shell tree and the guest tree; returns ``static``.

    ``runtime`` / ``caps``: True writes the valid file, False omits it, a str
    writes that text verbatim. ``runtime.json`` carries the sha256 of the
    capabilities file it ships with.
    """
    static = root / 'static'
    shell = static / 'shell'
    guest = static / 'shell-guest'
    (shell / 'isolation').mkdir(parents=True, exist_ok=True)
    guest.mkdir(parents=True, exist_ok=True)
    (shell / 'index.html').write_text('<!doctype html><title>shell</title>')

    caps_text = json.dumps(CAPABILITIES_STUB, indent=2) + '\n' if caps is True else caps
    if caps is not False:
        (shell / 'isolation' / 'capabilities.json').write_text(caps_text)

    if runtime is not False:
        if runtime is True:
            marker = json.loads((FIXTURES / 'runtime.json').read_text())
            marker['capabilitiesSha256'] = hashlib.sha256(
                (shell / 'isolation' / 'capabilities.json').read_bytes()
                if (shell / 'isolation' / 'capabilities.json').exists()
                else b''
            ).hexdigest()
            runtime_text = json.dumps(marker)
        else:
            runtime_text = runtime
        (guest / 'runtime.json').write_text(runtime_text)
    if frame:
        (guest / 'frame.html').write_text((FIXTURES / 'frame.html').read_text())
        (guest / 'guest-test.js').write_text('/* guest runtime test stub */')
    return static


# ---------------------------------------------------------------------------
# Clock
# ---------------------------------------------------------------------------

_clock_base = [time.time()]


class FakeClock:
    """A controllable ``time.time`` (``advance`` moves it). Bases never repeat across tests."""

    def __init__(self, monkeypatch):
        _clock_base[0] += 100_000  # state that outlives a test (rate windows) is always in the past
        self.now = _clock_base[0]
        monkeypatch.setattr(time, 'time', lambda: self.now)

    def advance(self, seconds: float) -> None:
        self.now += seconds


# ---------------------------------------------------------------------------
# In-memory registry installed over the account singleton
# ---------------------------------------------------------------------------


class FakeRegistry:
    """Publish rows, deployments and identities behind the account singleton.

    One ``add`` creates a consistent rail entry, artifact and publish row, so
    the REAL ``resolve_app_pins`` / ``entitled_version_dirs`` run over it.
    """

    def __init__(self):
        self.rows: List[dict] = []
        self.versions: Dict[tuple, List[dict]] = {}
        self.artifacts: Dict[tuple, dict] = {}
        self.membership: Dict[str, dict] = {'u1': {'org': 'org-1', 'teams': ['t1']}}
        self.tokens: Dict[str, str] = {'good-token': 'u1'}
        self.first_party: set = set()  # (app_id, binding_org_id)
        self.approved: Dict[tuple, list] = {}  # (app_id, version) -> caps
        self.account_info_calls: List[tuple] = []

    # -- seeding ------------------------------------------------------------

    def add(
        self,
        app_id: str,
        version: int = 1,
        *,
        org: str = 'acme-org',
        audience: tuple = ('public', ''),
        deploy_state: str = 'ready',
        build: str = 'ok',
        network: Optional[list] = None,
        approved: Optional[list] = None,
        platform: bool = False,
        required: Optional[list] = None,
    ) -> dict:
        manifest: Dict[str, Any] = {'id': app_id, 'name': app_id}
        if network is not None:
            manifest['network'] = network
        metadata: Dict[str, Any] = {'manifest': manifest, 'build': {'status': build}}
        if platform:
            metadata['platform'] = True
        if approved is not None:
            metadata['approvedCapabilities'] = approved
            self.approved[(app_id, version)] = approved
        artifact_path = f'orgs/{org}/files/.deployments/{app_id}/v{version:06d}-fake.json'
        entry = {
            'version': version,
            'state': deploy_state,
            'metadata': metadata,
            'artifactPath': artifact_path,
        }
        self.versions.setdefault((org, app_id), []).append(entry)
        self.artifacts[(org, app_id, version)] = {
            'kind': 'app',
            'appId': app_id,
            'moduleId': app_id.replace('.', '_'),
            'name': app_id,
            'appVersion': '1.0.0',
            'metadata': metadata,
        }
        row = {
            'orgId': org,
            'appId': app_id,
            'audience': {'type': audience[0], 'id': audience[1]},
            'version': version,
            'state': 'enabled',
            'artifactState': deploy_state,
            'artifactBuild': build,
            'artifactPath': artifact_path,
            'snapshot': {'name': app_id, 'requiredPermissions': required or []},
        }
        self.rows.append(row)
        if platform:
            self.first_party.add((app_id, org))
        return row

    def dist_dir(self, app_id: str, version: int = 1, org: str = 'acme-org') -> str:
        """The store dist dir the real resolvers hand back for one seeded version."""
        from ai.account.app_deploy import _dist_dir_of

        for entry in self.versions[(org, app_id)]:
            if entry['version'] == version:
                return _dist_dir_of(entry['artifactPath'])
        raise KeyError((org, app_id, version))

    # -- identities ---------------------------------------------------------

    def info_of(self, user_id: str, org_id: Optional[str] = None):
        member = self.membership.get(user_id)
        if not member or (org_id is not None and member['org'] != org_id):
            return None
        return SimpleNamespace(
            userId=user_id,
            displayName='User',
            organization={'id': member['org'], 'teams': [{'id': t} for t in member['teams']]},
            sysPermissions=[],
            auth='rr_user',
        )

    # -- install ------------------------------------------------------------

    def install(self, monkeypatch, *, saas: bool = True, review_ladder: bool = True) -> 'FakeRegistry':
        from ai.account import account

        reg = self

        async def publish_list(org_id, kind, audiences):
            keys = {(a['type'], a.get('id', '')) for a in audiences}
            return [dict(r) for r in reg.rows if (r['audience']['type'], r['audience']['id']) in keys]

        async def deployments_versions(org_id, app_id):
            return [dict(e) for e in reg.versions.get((org_id, app_id), [])]

        async def deployments_artifact(org_id, app_id, version):
            return reg.artifacts[(org_id, app_id, version)]

        async def authenticate(credential):
            user = reg.tokens.get(credential)
            return reg.info_of(user) if user else (401, 'bad credential')

        async def account_info_for(user_id, org_id):
            reg.account_info_calls.append((user_id, org_id))
            return reg.info_of(user_id, org_id)

        async def is_first_party(app_id, binding_org_id):
            return (app_id, binding_org_id) in reg.first_party

        async def approved_capabilities(org_id, app_id, version):
            return list(reg.approved.get((app_id, version)) or ['core'])

        monkeypatch.setattr(account, 'capabilities', ('saas',) if saas else ('oss',), raising=False)
        monkeypatch.setattr(account, 'review_ladder', review_ladder, raising=False)
        for name, fn in (
            ('publish_list', publish_list),
            ('deployments_versions', deployments_versions),
            ('deployments_artifact', deployments_artifact),
            ('authenticate', authenticate),
            ('account_info_for', account_info_for),
            ('is_first_party', is_first_party),
            ('approved_capabilities', approved_capabilities),
        ):
            monkeypatch.setattr(account, name, fn, raising=False)
        return self


def install_store(monkeypatch) -> List[str]:
    """Fake store whose ``read_bytes`` echoes the path; returns the list of paths read."""
    import ai.account.store as store_mod

    reads: List[str] = []

    async def read_bytes(path: str) -> bytes:
        reads.append(path)
        return f'// bundle {path}\n'.encode()

    monkeypatch.setattr(
        store_mod.Store,
        'instance',
        classmethod(lambda cls: SimpleNamespace(_store=SimpleNamespace(read_bytes=read_bytes))),
    )
    return reads


# ---------------------------------------------------------------------------
# Route table and ASGI apps
# ---------------------------------------------------------------------------


class FakeServer:
    """Collects what ``initModule`` registers, like ``WebServer.add_route``."""

    def __init__(self):
        self.routes: List[tuple] = []

    def add_route(self, path, routeHandler, methods=None, public=False, **kwargs):
        self.routes.append((path, routeHandler, list(methods or ['GET'])))


def shell_inner_app(hits: Optional[list] = None):
    """The shell module's real route table (via ``initModule``) plus ``/auth`` and ``/ws``.

    ``hits`` receives the ``(type, path)`` of every scope that reaches the app:
    a request the outer middleware refuses never shows up in it.
    """
    import ai.modules.shell as shell_pkg

    server = FakeServer()
    # Startup check (d) inspects the account CLASS of a SaaS edition; these tests
    # fake the SaaS account by patching the singleton, so start the module as OSS
    # and put the edition back for the requests.
    from ai.account import account

    edition = account.capabilities
    account.capabilities = ('oss',)
    try:
        shell_pkg.initModule(server, {})
    finally:
        account.capabilities = edition
    app = FastAPI()
    for path, handler, methods in server.routes:
        app.add_api_route(path, handler, methods=methods)

    @app.get('/auth')
    async def _auth():
        resp = JSONResponse({'inner': 'auth'})
        resp.set_cookie('inner_session', 'x')
        return resp

    @app.websocket('/ws')
    async def _ws(ws: WebSocket):
        await ws.accept()
        await ws.send_text('hello from inner')
        await ws.close()

    if hits is None:
        return app

    async def spy(scope, receive, send):
        if scope['type'] in ('http', 'websocket'):
            hits.append((scope['type'], scope['path']))
        await app(scope, receive, send)

    return spy


def outer_app(inner, config, *, require: bool = True):
    """Wrap ``inner`` in AppHostMiddleware. ``require=False`` (guards) returns it bare when the module is absent."""
    mod = module_or_none('ai.web.app_host') if not require else load_module('ai.web.app_host')
    if mod is None:
        return inner
    return need(mod, 'AppHostMiddleware')(inner, config=config)


def app_host_of(label: str, template: str = TEMPLATE) -> str:
    """The ``Host`` header value of one app label under a template."""
    return template.split('//', 1)[1].replace('{label}', label)


class _MetaParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.metas: List[dict] = []

    def handle_starttag(self, tag, attrs):
        if tag == 'meta':
            self.metas.append(dict(attrs))


def meta_content(html: str, name: str) -> Optional[str]:
    """The ``content`` of ``<meta name=...>`` in a document, or None."""
    parser = _MetaParser()
    parser.feed(html)
    for meta in parser.metas:
        if meta.get('name') == name:
            return meta.get('content')
    return None


def csp_directives(value: str) -> Dict[str, List[str]]:
    """Parse a CSP header into ``{directive: [sources]}``."""
    out: Dict[str, List[str]] = {}
    for part in value.split(';'):
        tokens = part.split()
        if tokens:
            out[tokens[0]] = tokens[1:]
    return out


def label_for(app_id: str) -> str:
    """Independent re-derivation of the design's label: ``a`` + 24 chars of base32(sha256)."""
    digest = hashlib.sha256(app_id.encode('utf-8')).digest()
    return 'a' + base64.b32encode(digest).decode('ascii').rstrip('=').lower()[:24]


def sorted_unique(items: Iterable[str]) -> List[str]:
    return sorted(set(items))


# ---------------------------------------------------------------------------
# The four places an app list reaches a client: probe, connect, push, manifest push
# ---------------------------------------------------------------------------


def app_entry(app_id: str, *, isolated=None, first_party=None, version: int = 3, **extra) -> dict:
    """One wire entry as ``resolve_app_pins`` builds it (stamp fields only when given)."""
    entry: Dict[str, Any] = {
        'id': app_id,
        'moduleId': app_id.replace('.', '_'),
        'name': app_id,
        'version': '1.0.0',
        'registryVersion': version,
        'entry': f'/apps/{app_id}/v{version}/remoteEntry.js',
        'appStatus': 'free',
        'onDesktop': True,
    }
    if isolated is not None:
        entry['isolated'] = isolated
    if first_party is not None:
        entry['firstParty'] = first_party
    entry.update(extra)
    return entry


def stamped_apps() -> List[dict]:
    """An isolated third-party entry, a first-party entry and an unstamped one."""
    return [
        app_entry('acme.thirdparty', isolated=True, first_party=False),
        app_entry('rocketride.home', isolated=False, first_party=True),
        app_entry('acme.plain'),
    ]


def by_id(apps: List[dict]) -> Dict[str, dict]:
    return {a['id']: a for a in apps}


async def probe_body(apps: list, shell_caps=None) -> dict:
    """The body ``rrext_public_probe`` answers when the account's public apps are ``apps``."""
    from unittest.mock import AsyncMock, MagicMock

    from ai.modules.task.commands.cmd_public import PublicCommands

    conn = PublicCommands.__new__(PublicCommands)
    account = SimpleNamespace(capabilities=['oss'], get_public_apps=AsyncMock(return_value=apps))
    conn._server = MagicMock()
    conn._server._server = SimpleNamespace(account=account)
    conn.build_response = MagicMock(side_effect=lambda req, body=None: {'type': 'response', 'body': body})
    arguments = {} if shell_caps is None else {'shellCaps': shell_caps}
    result = await PublicCommands.on_rrext_public_probe(conn, {'command': 'rrext_public_probe', 'arguments': arguments})
    return result['body']


def make_conn(server=None):
    """A ``TaskConn`` with the multi-mixin ``__init__`` bypassed (as test_task_conn does)."""
    from unittest.mock import AsyncMock, MagicMock

    from ai.modules.task.task_conn import TaskConn

    conn = TaskConn.__new__(TaskConn)
    conn._connection_id = 1
    conn._client_ip = '127.0.0.1'
    conn._authenticated = False
    conn._account_info = None
    conn._auth_attempts = 0
    conn._messages_in = 0
    conn._messages_out = 0
    conn._last_activity = 0.0
    conn._connected_at = 0.0
    conn._client_info = {}
    conn._server = server or MagicMock()
    transport = MagicMock()
    transport.send = AsyncMock()
    transport.disconnect = MagicMock()
    conn._transport = transport
    conn.build_response = MagicMock(side_effect=lambda req, body=None: {'type': 'response', 'body': body})
    conn.build_error = MagicMock(side_effect=lambda req, msg: {'type': 'response', 'success': False, 'message': msg})
    conn.debug_message = MagicMock()
    return conn


async def connect(apps: list, auth_args: Optional[dict] = None):
    """Run ``TaskConn.on_auth`` for a user whose desktop apps are ``apps``; returns ``(conn, response)``."""
    from unittest.mock import AsyncMock, MagicMock

    from ai.account.models import AccountInfo
    from ai.modules.task.task_conn import TaskConn

    info = AccountInfo(userId='u1', auth='rr_secret', userToken='rr_secret', apps=apps)
    server = MagicMock()
    server._server = MagicMock()
    server._server.authenticate_credential = AsyncMock(return_value=info)
    server.release_unauthed_slot = MagicMock()
    server.broadcast_server_event = AsyncMock()
    conn = make_conn(server)
    arguments = {'auth': 'rr_secret'}
    arguments.update(auth_args or {})
    response = await TaskConn.on_auth(conn, {'command': 'auth', 'arguments': arguments})
    return conn, response


async def pushed_account(apps: list, monkeypatch, shell_caps=()):
    """The ``apaext_account`` body ``push_account_update`` sends a connection that declared ``shell_caps``.

    Returns ``(body, stored_info)``: the stored AccountInfo must stay untouched by the wire view.
    """
    from unittest.mock import AsyncMock, MagicMock

    from ai.account import account as real_account
    from ai.account.models import AccountInfo
    from ai.modules.task.task_server import TaskServer

    fresh = AccountInfo(userId='u1', auth='rr_secret', userToken='rr_secret', apps=apps)
    service = MagicMock()
    service.get_authentication_result = AsyncMock(return_value=fresh)
    monkeypatch.setattr(real_account, '_service', service, raising=False)
    conn = MagicMock()
    conn._account_info = SimpleNamespace(userId='u1', auth='rr_secret')
    conn._shell_caps = tuple(shell_caps)
    conn.send_event = AsyncMock()
    conn.get_connection_id = MagicMock(return_value=1)
    ts = TaskServer.__new__(TaskServer)
    ts._connections = {1: conn}
    ts.debug_message = MagicMock()
    await TaskServer.push_account_update(ts, 'u1')
    args, kwargs = conn.send_event.call_args
    assert args[0] == 'apaext_account'
    return kwargs['body'], fresh


async def manifest_pushed_account(apps: list, monkeypatch, shell_caps=()):
    """The body the OSS branch of ``manifest_push.push_refresh`` sends a connection with ``shell_caps``."""
    from unittest.mock import AsyncMock

    from ai.account import account as real_account
    from ai.account import manifest_push
    from ai.account.models import AccountInfo

    async def get_apps_for_user(user_id, teams):
        return [dict(a) for a in apps]

    monkeypatch.setattr(real_account, 'get_apps_for_user', get_apps_for_user, raising=False)
    monkeypatch.delattr(real_account, '_service', raising=False)
    conn = SimpleNamespace(
        _account_info=AccountInfo(userId='u1', auth='rr_secret', userToken='rr_secret'),
        _shell_caps=tuple(shell_caps),
        send_event=AsyncMock(),
    )
    server = SimpleNamespace(_connections={1: conn})
    await manifest_push.push_refresh(server, 'u1', 'app-publish')
    for call in conn.send_event.call_args_list:
        if call.args[0] == 'apaext_account':
            return call.kwargs['body']
    raise AssertionError('no apaext_account push was sent')
