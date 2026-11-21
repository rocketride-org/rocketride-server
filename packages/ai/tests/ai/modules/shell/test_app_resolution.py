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
# SOFTWARE.

"""The artifact serving route: ``/apps/*`` and ``/pipelines/*`` through ONE handler.

Tests mount ``artifact_static`` on both prefixes and ``artifacts_session`` on
``/artifacts/session`` (the task_http suite's minimal-FastAPI pattern) with
the resolvers faked, and pin the three shapes per kind:

  - ``<id>/v<N>/<rest>`` streams the version's serving dir from the store,
    immutable; the kind-specific dir comes from the resolver, nothing else
    differs between an app and a pipe;
  - ``<id>/<rest>`` answers 302 to the caller's current version, no-cache;
  - ``<id>`` answers the resolution document (the deploy smoke-test probe),
    EXACTLY the safe subset: a new field must consciously edit this test.

Every miss is one 404 (no existence oracle), the on-disk static tree is gone,
``/apps/session`` is gone, and the cookie ``/artifacts/session`` mints rides
path '/'.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import ai.account.pipe_deploy as pipe_deploy_mod
import ai.modules.shell.shell as shell_mod
from ai.account import account as account_singleton
from ai.account.store import Store


# =============================================================================
# HELPERS
# =============================================================================

# A manifest entry as the account resolvers mint it: the safe fields PLUS
# internal facts that must never leak through the probe.
HOME = {
    'id': 'rocketride.home',
    'name': 'Home',
    'version': '3.1.0',
    'registryVersion': 7,
    'orgId': 'platform-org',
    'mode': 'free',
    'authenticated': False,
}

# The pipe pin the published-rung resolver answers with.
PIN = SimpleNamespace(version=4, deployment=SimpleNamespace(org_id='org-1', team_id='@public', project_id='acme.doc'))


def _client(monkeypatch, apps=(HOME,), servable=(7,), pin=PIN, pipe_servable=(4,), files=None, capture=None):
    """A TestClient over the shell module's artifact routes with the resolvers faked.

    Args:
        monkeypatch:   pytest fixture.
        apps:          Manifest entries _apps_for_token should resolve.
        servable:      App registry versions the caller may fetch (what
                       _version_dirs_for reports for kind 'app').
        pin:           The pin resolve_pipe_version answers (None = nothing serves).
        pipe_servable: Pipe registry versions the caller may fetch.
        files:         {store path: bytes} the fake store serves.
        capture:       Optional list collecting the tokens resolution saw.
    """

    async def fake_apps_for_token(token: str) -> list:
        if capture is not None:
            capture.append(token)
        return list(apps)

    async def fake_version_dirs_for(token: str, kind: str, artifact_id: str, want: int | None = None) -> dict:
        versions = servable if kind == 'app' else pipe_servable
        return {version: f'{kind}/{artifact_id}/v{version}/dir' for version in versions}

    async def fake_resolve_pipe_version(info, pipe_id):
        return pin

    async def fake_versions(org_id, project_id):
        return [{'version': 4, 'metadata': {'manifest': {'name': 'Doc Brain', 'mode': 'free'}}}]

    async def read_bytes(path: str) -> bytes:
        if files is None or path not in files:
            raise FileNotFoundError(path)
        return files[path]

    monkeypatch.setattr(shell_mod, '_apps_for_token', fake_apps_for_token)
    monkeypatch.setattr(shell_mod, '_version_dirs_for', fake_version_dirs_for)
    monkeypatch.setattr(pipe_deploy_mod, 'resolve_pipe_version', fake_resolve_pipe_version)
    monkeypatch.setattr(account_singleton, 'deployments_versions', fake_versions, raising=False)
    monkeypatch.setattr(
        Store, 'instance', staticmethod(lambda: SimpleNamespace(_store=SimpleNamespace(read_bytes=read_bytes)))
    )

    app = FastAPI()
    app.add_api_route('/artifacts/session', shell_mod.artifacts_session, methods=['POST'])
    for prefix in ('apps', 'pipelines'):
        app.add_api_route(f'/{prefix}/{{file_path:path}}', shell_mod.artifact_static, methods=['GET'])
    return TestClient(app)


# =============================================================================
# RESOLUTION — the bare id
# =============================================================================


def test_bare_app_id_answers_the_resolution_document(monkeypatch):
    """The probe: what a bundle fetch would serve, and nothing more."""
    seen: list = []
    client = _client(monkeypatch, capture=seen)

    # Cookies belong on the client instance (per-request cookies are
    # deprecated in starlette's TestClient).
    client.cookies.set(shell_mod._APP_COOKIE, 'tok-1')
    resp = client.get('/apps/rocketride.home')

    assert resp.status_code == 200
    # EXACT payload — the safe subset is a contract, not a starting point.
    assert resp.json() == {
        'appId': 'rocketride.home',
        'name': 'Home',
        'version': '3.1.0',
        'registryVersion': 7,
        'entry': '/apps/rocketride.home/v7/remoteEntry.js',
    }
    # Mutable resolution facts must never be pinned by a client cache.
    assert resp.headers['cache-control'] == 'no-cache, must-revalidate'
    # Resolution ran under the SAME identity a bundle fetch would use.
    assert seen == ['tok-1']


def test_bare_pipe_id_answers_the_same_shape(monkeypatch):
    """The pipe probe: the published-rung resolver's version, the version's serving root as entry."""
    client = _client(monkeypatch)
    resp = client.get('/pipelines/acme.doc')

    assert resp.status_code == 200
    assert resp.json() == {
        'pipeId': 'acme.doc',
        'name': 'Doc Brain',
        'version': '',
        'registryVersion': 4,
        'entry': '/pipelines/acme.doc/v4/',
    }
    assert resp.headers['cache-control'] == 'no-cache, must-revalidate'


def test_anonymous_resolution_uses_the_empty_identity(monkeypatch):
    """No cookie resolves as anonymous — the public set."""
    seen: list = []
    client = _client(monkeypatch, capture=seen)

    assert client.get('/apps/rocketride.home').status_code == 200
    assert seen == ['']


@pytest.mark.parametrize('url', ['/apps/ghost.app', '/pipelines/ghost.pipe', '/apps/rocketride.home/v7'])
def test_invisible_or_versionless_ids_are_the_one_404(monkeypatch, url):
    """An artifact the caller cannot see, or a version with no file, is the same 404 as any miss."""
    client = _client(monkeypatch, apps=[], pin=None)
    assert client.get(url).status_code == 404


def test_entry_only_row_is_not_resolvable(monkeypatch):
    """A visible entry WITHOUT a registryVersion (dev-overlay-only) has nothing versioned to serve."""
    overlay = {'id': 'me.dev', 'name': 'Dev', 'entry': 'http://localhost:3100/remoteEntry.js'}
    client = _client(monkeypatch, apps=[overlay])
    assert client.get('/apps/me.dev').status_code == 404


def test_unservable_version_is_not_resolvable(monkeypatch):
    """A version the caller cannot actually fetch is never advertised, for either kind."""
    client = _client(monkeypatch, servable=(), pipe_servable=())
    assert client.get('/apps/rocketride.home').status_code == 404
    assert client.get('/pipelines/acme.doc').status_code == 404


# =============================================================================
# VERSIONED — canonical, immutable, both kinds through one handler
# =============================================================================


def test_versioned_app_file_streams_from_the_versions_dir(monkeypatch):
    client = _client(monkeypatch, files={'app/rocketride.home/v7/dir/remoteEntry.js': b'export {}'})
    resp = client.get('/apps/rocketride.home/v7/remoteEntry.js')

    assert resp.status_code == 200 and resp.content == b'export {}'
    assert resp.headers['cache-control'] == 'private, max-age=3600, immutable'
    assert resp.headers['content-type'].startswith('text/javascript') or 'javascript' in resp.headers['content-type']


def test_versioned_pipe_file_streams_from_the_pipes_dir(monkeypatch):
    """The kind-specific dir is the resolver's; the handler is the same."""
    client = _client(monkeypatch, files={'pipe/acme.doc/v4/dir/docs/README.md': b'# Doc Brain'})
    resp = client.get('/pipelines/acme.doc/v4/docs/README.md')

    assert resp.status_code == 200 and resp.content == b'# Doc Brain'
    assert resp.headers['cache-control'] == 'private, max-age=3600, immutable'


def test_versioned_miss_is_the_one_404(monkeypatch):
    """Unentitled version, absent file and traversal alike."""
    client = _client(monkeypatch, files={'app/rocketride.home/v7/dir/remoteEntry.js': b'x'})
    assert client.get('/apps/rocketride.home/v9/remoteEntry.js').status_code == 404
    assert client.get('/apps/rocketride.home/v7/missing.js').status_code == 404
    assert client.get('/apps/rocketride.home/v7/..%5Cremote.js').status_code == 404
    assert client.get('/pipelines/acme.doc/v4/docs/README.md').status_code == 404


# =============================================================================
# UNVERSIONED — 302 to the caller's current version
# =============================================================================


def test_unversioned_app_path_redirects_to_the_current_version(monkeypatch):
    client = _client(monkeypatch)
    resp = client.get('/apps/rocketride.home/icon.svg', follow_redirects=False)

    assert resp.status_code == 302
    assert resp.headers['location'] == '/apps/rocketride.home/v7/icon.svg'
    assert resp.headers['cache-control'] == 'no-cache'


def test_unversioned_pipe_path_redirects_to_the_current_version(monkeypatch):
    client = _client(monkeypatch)
    resp = client.get('/pipelines/acme.doc/images/flow.png', follow_redirects=False)

    assert resp.status_code == 302
    assert resp.headers['location'] == '/pipelines/acme.doc/v4/images/flow.png'
    assert resp.headers['cache-control'] == 'no-cache'


def test_unversioned_redirect_re_encodes_the_decoded_segments(monkeypatch):
    """The request path arrives decoded; the Location names the same file, encoded again (a space, a '#')."""
    client = _client(monkeypatch)
    resp = client.get('/pipelines/acme.doc/images/flow%20a%23b.png', follow_redirects=False)

    assert resp.status_code == 302
    assert resp.headers['location'] == '/pipelines/acme.doc/v4/images/flow%20a%23b.png'


def test_unversioned_path_of_an_unresolvable_artifact_is_404_not_a_disk_read(monkeypatch):
    """The on-disk static tree is gone: nothing serves unversioned, and there is no root to probe."""
    client = _client(monkeypatch, apps=[], pin=None)
    assert client.get('/apps/rocketride.home/icon.svg', follow_redirects=False).status_code == 404
    assert not hasattr(shell_mod, '_apps_root')


# =============================================================================
# THE COOKIE — /artifacts/session, path '/'
# =============================================================================


def test_artifacts_session_mints_the_cookie_on_the_root_path(monkeypatch):
    client = _client(monkeypatch)
    monkeypatch.setattr(shell_mod, '_authenticated', AsyncMock(return_value=SimpleNamespace(userId='u1')))

    resp = client.post('/artifacts/session', headers={'Authorization': 'Bearer tok-1'})

    assert resp.status_code == 200 and resp.json() == {'ok': True}
    cookie = resp.headers['set-cookie']
    assert cookie.startswith(f'{shell_mod._APP_COOKIE}=tok-1;') and 'Path=/;' in cookie and 'HttpOnly' in cookie


def test_artifacts_session_refuses_an_invalid_token(monkeypatch):
    client = _client(monkeypatch)
    monkeypatch.setattr(shell_mod, '_authenticated', AsyncMock(return_value=None))

    assert client.post('/artifacts/session', headers={'Authorization': 'Bearer bad'}).status_code == 401
    assert client.post('/artifacts/session').json() == {'ok': False}


def test_apps_session_is_gone(monkeypatch):
    """The old mint point no longer exists: a POST finds no handler (the GET
    catch-all owns the path, so the router answers 405) and a GET resolves
    'session' as an id nobody can see.
    """
    client = _client(monkeypatch, apps=[])
    assert client.post('/apps/session', headers={'Authorization': 'Bearer tok'}).status_code == 405
    assert client.get('/apps/session').status_code == 404
    assert not hasattr(shell_mod, 'apps_session') and not hasattr(shell_mod, 'apps_static')
