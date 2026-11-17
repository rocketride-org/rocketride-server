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

"""Golden record of what the engine serves while app isolation is ``off`` (#1022).

PR1 and PR2 of the #1022 fix add isolation machinery behind ``RR_APP_ISOLATION``.
While it is ``off`` they must leave every response byte for byte as PR0 ships
it: same status, same headers (``Date`` and ``ETag`` aside), same body. This test drives the
real ``shell_static``, ``apps_session`` and ``apps_static`` handlers over a
seeded tree and compares each response with ``golden/off_golden.json``.

The shell documents (``/``, a prerender capture, ``/shell/index.html``, the SPA
fallback) are pinned WITH the PR0 headers (``frame-ancestors`` and COOP). Hashed
assets, bundles, icons and the resolution probe carry no framing policy.

Regenerate after an intended change with ``RR_UPDATE_GOLDEN=1 pytest <this file>``;
the run rewrites only ``golden/off_golden.json``.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import ai.modules.shell.shell as shell_mod

GOLDEN = Path(__file__).parent / 'golden' / 'off_golden.json'
FIXED_MTIME = 1_700_000_000

# One first-party and one third-party app; one public and one private version.
APPS = [
    {'id': 'rocketride.home', 'name': 'Home', 'version': '3.1.0', 'registryVersion': 7, 'orgId': 'platform-org'},
    {'id': 'acme.thirdparty', 'name': 'Acme', 'version': '1.0.0', 'registryVersion': 2, 'orgId': 'acme-org'},
]
PRIVATE_VERSION = 3  # acme.thirdparty v3 is not entitled to anonymous callers


def _write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)
    os.utime(path, (FIXED_MTIME, FIXED_MTIME))


@pytest.fixture
def seeded(tmp_path, monkeypatch):
    """A seeded shell tree, apps tree, fake store, fake account and fake resolution."""
    shell = tmp_path / 'shell'
    _write(shell / 'index.html', '<!doctype html><title>shell</title>')
    _write(shell / '_prerender' / 'pricing' / 'index.html', '<!doctype html><title>pricing</title>')
    _write(shell / 'static' / 'main.abc123.js', 'console.log("shell")')
    apps = tmp_path / 'apps'
    _write(apps / 'acme.thirdparty' / 'icon.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>')
    monkeypatch.setattr(shell_mod, '_shell_root', str(shell))
    monkeypatch.setattr(shell_mod, '_apps_root', str(apps))
    monkeypatch.setattr(shell_mod, '_is_saas', lambda: False)
    # The golden pins the DEFAULT policy, whatever RR_SHELL_FRAME_ANCESTORS_EXTRA
    # the test process inherits.
    monkeypatch.setattr(
        shell_mod,
        '_SHELL_DOCUMENT_HEADERS',
        {
            **shell_mod._SHELL_DOCUMENT_HEADERS,
            'Content-Security-Policy': f'frame-ancestors {shell_mod._frame_ancestor_sources("")}',
        },
    )

    async def fake_apps_for_token(token: str) -> list:
        return APPS

    async def fake_version_dirs_for(token: str, app_id: str, want=None) -> dict:
        return {v: f'{app_id}/v{v}/dist' for v in (1, 2, 7)}

    monkeypatch.setattr(shell_mod, '_apps_for_token', fake_apps_for_token)
    monkeypatch.setattr(shell_mod, '_version_dirs_for', fake_version_dirs_for)

    async def read_bytes(path: str) -> bytes:
        return f'// bundle {path}\n'.encode()

    import ai.account.store as store_mod

    monkeypatch.setattr(
        store_mod.Store,
        'instance',
        classmethod(lambda cls: SimpleNamespace(_store=SimpleNamespace(read_bytes=read_bytes))),
    )

    import ai.account as account_pkg

    async def fake_authenticate(token: str):
        return SimpleNamespace(userId='user-1') if token == 'good-token' else (401, 'bad')

    monkeypatch.setattr(account_pkg.account, 'authenticate', fake_authenticate, raising=False)

    app = FastAPI()
    app.get('/')(shell_mod.shell_static)
    app.get('/pricing')(shell_mod.shell_static)
    app.get('/shell/{file_path:path}')(shell_mod.shell_static)
    app.post('/apps/session')(shell_mod.apps_session)
    app.get('/apps/{path:path}')(shell_mod.apps_static)
    return TestClient(app)


REQUESTS = [
    ('GET', '/', {}),
    ('GET', '/pricing', {}),
    ('GET', '/shell/index.html', {}),
    ('GET', '/shell/static/main.abc123.js', {}),
    ('GET', '/shell/some/client/route', {}),
    ('POST', '/apps/session', {'Authorization': 'Bearer good-token'}),
    ('GET', '/apps/rocketride.home', {}),
    ('GET', '/apps/acme.thirdparty', {}),
    ('GET', '/apps/acme.thirdparty/v2/remoteEntry.js', {}),
    ('GET', f'/apps/acme.thirdparty/v{PRIVATE_VERSION}/remoteEntry.js', {}),
    ('GET', '/apps/acme.thirdparty/icon.svg', {}),
]


def _record(client: TestClient) -> list:
    out = []
    for method, path, headers in REQUESTS:
        resp = client.request(method, path, headers=headers)
        out.append(
            {
                'request': f'{method} {path}',
                'status': resp.status_code,
                # date changes per run; etag hashes mtime and size, which
                # depend on the checkout, not on the served policy.
                'headers': {k: v for k, v in sorted(resp.headers.items()) if k not in ('date', 'etag')},
                'bodySha256': hashlib.sha256(resp.content).hexdigest(),
            }
        )
    return out


def test_off_mode_responses_match_the_golden_fixture(seeded, monkeypatch):
    monkeypatch.delenv('RR_APP_ISOLATION', raising=False)  # off is the default
    actual = _record(seeded)
    if os.environ.get('RR_UPDATE_GOLDEN') == '1':
        GOLDEN.write_text(json.dumps(actual, indent=2, sort_keys=True) + '\n')
    expected = json.loads(GOLDEN.read_text())
    assert actual == expected
