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

"""Response headers on versioned app bundle files (rocketride-saas #1022).

``/apps/<appId>/v<N>/<file>`` streams a third-party app's built ``dist/``
tree on the MAIN origin. A file there that a browser renders as a document
(HTML, SVG, XML, or anything of unknown type) would run the app developer's
script with the shell's origin when someone opens its URL directly. The
route therefore marks every such file as a download inside an opaque-origin
sandbox, and leaves the subresource types the shell loads (JS, CSS, JSON,
fonts, raster images, wasm) as they are.

The tests mount ``apps_static`` on a bare FastAPI app (no security-headers
middleware), so every header asserted here is set by the route itself.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import ai.modules.shell.shell as shell_mod
from ai.account.store import Store

# =============================================================================
# HELPERS
# =============================================================================

_APP = 'acme.brandy'
_DIST = f'{_APP}/v3/dist'


def _client(monkeypatch, files):
    """A TestClient over apps_static with one servable version (v3).

    Args:
        monkeypatch: pytest fixture.
        files:       dist-relative path -> bytes the store holds.

    Returns:
        TestClient with GET /apps/{path} wired to the real handler.
    """

    async def fake_version_dirs_for(token, app_id, want=None):
        """The caller may fetch v3 of acme.brandy and nothing else."""
        return {3: _DIST} if app_id == _APP else {}

    async def read_bytes(path):
        """The store's raw read: only the seeded dist files exist."""
        prefix = f'{_DIST}/'
        if not path.startswith(prefix) or path[len(prefix) :] not in files:
            raise FileNotFoundError(path)
        return files[path[len(prefix) :]]

    monkeypatch.setattr(shell_mod, '_version_dirs_for', fake_version_dirs_for)
    monkeypatch.setattr(
        Store, 'instance', classmethod(lambda cls: SimpleNamespace(_store=SimpleNamespace(read_bytes=read_bytes)))
    )

    app = FastAPI()
    app.add_api_route('/apps/{file_path:path}', shell_mod.apps_static, methods=['GET'])
    return TestClient(app)


def _get(monkeypatch, name, body=b'x'):
    """Serve one dist file by name and return the response."""
    return _client(monkeypatch, {name: body}).get(f'/apps/{_APP}/v3/{name}')


def _is_sandboxed_download(resp) -> bool:
    """The file is a download, and opens in an opaque-origin sandbox if rendered."""
    csp = resp.headers.get('content-security-policy', '')
    directives = [d.strip().split(' ')[0] for d in csp.split(';') if d.strip()]
    disposition = resp.headers.get('content-disposition', '')
    return 'sandbox' in directives and disposition.split(';')[0].strip().lower() == 'attachment'


# =============================================================================
# DOCUMENT-CAPABLE FILES: download + sandbox (fail on develop)
# =============================================================================


@pytest.mark.parametrize(
    'name',
    [
        'index.html',
        'docs/help.htm',
        'icon.svg',
        'feed.xml',
        'page.xhtml',
        'manual.pdf',
        'payload.unknownext',
        'noextension',
    ],
)
def test_document_capable_dist_files_are_sandboxed_downloads(monkeypatch, name):
    """A dist file a browser could render as a page never runs with the
    shell's origin: it carries ``Content-Disposition: attachment`` (opening
    the URL downloads it) and ``Content-Security-Policy: sandbox`` (if it is
    rendered anyway, it gets an opaque origin and no script).
    """
    resp = _get(monkeypatch, name)

    assert resp.status_code == 200
    assert _is_sandboxed_download(resp), dict(resp.headers)
    assert resp.headers.get('x-content-type-options') == 'nosniff'


def test_svg_icon_keeps_its_type_for_img_tags(monkeypatch):
    """The store tile shows a deployed icon through ``<img>``, which ignores
    Content-Disposition and never runs script: the SVG keeps its real type
    so the tile still renders it.
    """
    resp = _get(monkeypatch, 'icon.svg', b'<svg xmlns="http://www.w3.org/2000/svg"/>')

    assert resp.headers['content-type'].startswith('image/svg+xml')
    assert resp.content == b'<svg xmlns="http://www.w3.org/2000/svg"/>'


# =============================================================================
# SUBRESOURCE TYPES: unchanged (controls, pass on develop except nosniff)
# =============================================================================


@pytest.mark.parametrize(
    'name',
    [
        'remoteEntry.js',
        'static/js/async/123.mjs',
        'static/css/index.css',
        'mf-manifest.json',
        'static/font/inter.woff2',
        'static/image/logo.png',
        'static/image/photo.jpg',
        'favicon.ico',
        'static/wasm/mod.wasm',
    ],
)
def test_subresource_files_are_served_inline(monkeypatch, name):
    """The files Module Federation and the app's own CSS load are served
    inline, without the sandbox or attachment headers: the shell's loader
    fetches them as subresources, and a worker script must not inherit a
    sandbox policy.
    """
    resp = _get(monkeypatch, name, b'payload')

    assert resp.status_code == 200
    assert resp.content == b'payload'
    assert 'content-disposition' not in resp.headers
    assert 'sandbox' not in resp.headers.get('content-security-policy', '')
    assert resp.headers.get('cache-control') == 'private, max-age=3600'


def test_every_bundle_response_sets_nosniff_itself(monkeypatch):
    """The route sets nosniff itself, not only the server middleware, so a
    JS URL can never be sniffed into a document when the route is mounted
    without it.
    """
    resp = _get(monkeypatch, 'remoteEntry.js')

    assert resp.headers.get('x-content-type-options') == 'nosniff'


def test_unservable_version_is_still_a_plain_404(monkeypatch):
    """The header policy does not change the oracle-free 404."""
    client = _client(monkeypatch, {'index.html': b'x'})

    assert client.get(f'/apps/{_APP}/v9/index.html').status_code == 404
    assert client.get(f'/apps/{_APP}/v3/missing.html').status_code == 404
