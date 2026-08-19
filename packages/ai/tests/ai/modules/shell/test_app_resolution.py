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

"""The /apps/<appId> resolution-info endpoint (deploy smoke-test probe).

A BARE app id answers with what a bundle fetch would serve THIS caller —
the same manifest entry the shell's connect resolves, reduced to the safe
subset plus the versioned entry URL. Tests mount ``apps_static`` on a
minimal FastAPI app (the task_http suite's pattern) with the manifest
resolution patched, and pin:

  - the payload is EXACTLY the safe subset (data minimization is a
    contract — a new field must consciously edit this test),
  - the caller's /apps cookie is the resolution identity,
  - invisible apps and dev-overlay-only entries fall through to the
    static tree's 404 (the endpoint is not an existence oracle),
  - two-segment asset paths and versioned bundle paths are untouched.
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

import ai.modules.shell.shell as shell_mod


# =============================================================================
# HELPERS
# =============================================================================


def _client(monkeypatch, tmp_path, apps, capture=None):
    """A TestClient over apps_static with the manifest resolution faked.

    Args:
        monkeypatch: pytest fixture.
        tmp_path:    Stands in for the static assets tree (_apps_root).
        apps:        Manifest entries _apps_for_token should resolve.
        capture:     Optional list collecting the tokens resolution saw.

    Returns:
        TestClient with GET /apps/{path} wired to the real handler.
    """

    async def fake_apps_for_token(token: str) -> list:
        """Return the canned manifest; record the identity used."""
        if capture is not None:
            capture.append(token)
        return apps

    monkeypatch.setattr(shell_mod, '_apps_for_token', fake_apps_for_token)
    monkeypatch.setattr(shell_mod, '_apps_root', str(tmp_path))

    app = FastAPI()
    app.add_api_route('/apps/{file_path:path}', shell_mod.apps_static, methods=['GET'])
    return TestClient(app)


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


# =============================================================================
# TESTS
# =============================================================================


def test_bare_app_id_answers_the_resolution_document(monkeypatch, tmp_path):
    """The probe: what a bundle fetch would serve, and nothing more."""
    seen: list = []
    client = _client(monkeypatch, tmp_path, [HOME], capture=seen)

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


def test_anonymous_resolution_uses_the_empty_identity(monkeypatch, tmp_path):
    """No /apps cookie resolves as anonymous — the public set."""
    seen: list = []
    client = _client(monkeypatch, tmp_path, [HOME], capture=seen)

    assert client.get('/apps/rocketride.home').status_code == 200
    assert seen == ['']


def test_invisible_app_is_the_same_404_as_before(monkeypatch, tmp_path):
    """An app the caller cannot see falls through to the static tree's 404
    — the endpoint must not be an existence oracle for private apps.
    """
    client = _client(monkeypatch, tmp_path, [])
    assert client.get('/apps/ghost.app').status_code == 404


def test_dev_overlay_only_entry_is_not_resolvable(monkeypatch, tmp_path):
    """A visible entry WITHOUT a registryVersion (dev-overlay preview) has
    nothing versioned to serve — the probe must say 404, not invent a URL.
    """
    overlay = {'id': 'me.dev', 'name': 'Dev', 'entry': 'http://localhost:3100/remoteEntry.js'}
    client = _client(monkeypatch, tmp_path, [overlay])
    assert client.get('/apps/me.dev').status_code == 404


def test_asset_paths_are_untouched(monkeypatch, tmp_path):
    """Two-segment paths still serve the static assets tree, resolution or
    not — the new branch handles ONLY the bare id.
    """
    icon_dir = tmp_path / 'rocketride.home'
    icon_dir.mkdir()
    (icon_dir / 'icon.svg').write_text('<svg/>', encoding='utf-8')
    client = _client(monkeypatch, tmp_path, [HOME])

    resp = client.get('/apps/rocketride.home/icon.svg')

    assert resp.status_code == 200
    assert resp.text == '<svg/>'
