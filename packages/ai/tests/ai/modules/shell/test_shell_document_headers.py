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

"""Document headers on the shell pages the engine serves (#1022, PR0).

A shell document (the SPA ``index.html``, a prerendered marketing capture,
or any ``.html`` under the shell root) must carry:

  - ``Content-Security-Policy: frame-ancestors 'self' vscode-webview: vscode-file:``
    so no cross-origin page can frame the shell (the VS Code webview, inside the
    desktop workbench, is the one legitimate parent);
  - ``Cross-Origin-Opener-Policy: same-origin-allow-popups`` so a page that
    ``window.open``s the shell loses its ``window.opener`` handle.

Extra frame ancestors from ``RR_SHELL_FRAME_ANCESTORS_EXTRA`` are appended and
validated at import. Hashed static assets are not documents and get neither
header; HTML under ``static/`` is a document and gets both.
"""

from __future__ import annotations

import importlib

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import ai.modules.shell.shell as shell_mod

CSP = "frame-ancestors 'self' vscode-webview: vscode-file:"
COOP = 'same-origin-allow-popups'
ENV = 'RR_SHELL_FRAME_ANCESTORS_EXTRA'


def _client() -> TestClient:
    """Mount shell_static as ``initModule`` does: ``/shell/*`` plus public routes."""
    app = FastAPI()
    app.get('/shell/{file_path:path}')(shell_mod.shell_static)
    for route in shell_mod.PUBLIC_ROUTES:
        app.get(route)(shell_mod.shell_static)
    return TestClient(app)


@pytest.fixture
def shell_root(tmp_path, monkeypatch):
    """A built shell: index.html, a prerender capture for /pricing, a hashed asset, a stray html."""
    (tmp_path / 'index.html').write_text('<!doctype html><title>shell</title>')
    (tmp_path / '_prerender' / 'pricing').mkdir(parents=True)
    (tmp_path / '_prerender' / 'pricing' / 'index.html').write_text('<!doctype html><title>pricing</title>')
    (tmp_path / 'static').mkdir()
    (tmp_path / 'static' / 'main.abc123.js').write_text('console.log(1)')
    (tmp_path / 'static' / 'view.abc123.html').write_text('<!doctype html><title>view</title>')
    (tmp_path / 'about.html').write_text('<!doctype html><title>about</title>')
    (tmp_path / 'legacy.htm').write_text('<!doctype html><title>legacy</title>')
    (tmp_path / 'page.xhtml').write_text('<html xmlns="http://www.w3.org/1999/xhtml"><title>x</title></html>')
    (tmp_path / 'themes').mkdir()
    (tmp_path / 'themes' / 'dark.json').write_text('{}')
    monkeypatch.setattr(shell_mod, '_shell_root', str(tmp_path))
    return tmp_path


@pytest.fixture
def reload_shell(monkeypatch, tmp_path):
    """Reload the module under an env value; always restore it clean afterwards."""

    def _reload(value):
        monkeypatch.setenv(ENV, value)
        return importlib.reload(shell_mod)

    yield _reload
    monkeypatch.delenv(ENV, raising=False)
    importlib.reload(shell_mod)


def _assert_document_headers(resp) -> None:
    assert resp.status_code == 200
    assert resp.headers.get('content-security-policy') == CSP
    assert resp.headers.get('cross-origin-opener-policy') == COOP


def test_spa_fallback_sends_frame_ancestors_and_coop(shell_root):
    """T1: an unmatched route serves index.html with both headers."""
    _assert_document_headers(_client().get('/shell/some/route'))


def test_prerender_capture_sends_document_headers(shell_root):
    """T2: the prerendered /pricing capture is a document too."""
    resp = _client().get('/pricing')
    assert 'pricing' in resp.text
    _assert_document_headers(resp)


def test_shell_html_file_sends_document_headers(shell_root):
    """T3: an .html file under the shell root (index.html and any other) is a document."""
    client = _client()
    _assert_document_headers(client.get('/shell/index.html'))
    resp = client.get('/shell/about.html')
    assert 'about' in resp.text
    _assert_document_headers(resp)


def test_htm_and_xhtml_files_are_documents(shell_root):
    """T3b: .htm and .xhtml are documents too."""
    client = _client()
    _assert_document_headers(client.get('/shell/legacy.htm'))
    _assert_document_headers(client.get('/shell/page.xhtml'))


def test_html_under_static_is_a_document_and_stays_immutable(shell_root):
    """T3c: an HTML entry page under static/ gets the framing policy AND the immutable cache."""
    resp = _client().get('/shell/static/view.abc123.html')
    _assert_document_headers(resp)
    assert resp.headers['cache-control'] == 'public, max-age=31536000, immutable'


def test_non_document_shell_file_has_no_document_csp(shell_root):
    """T4b (control): theme JSON and other non-HTML files are not documents."""
    resp = _client().get('/shell/themes/dark.json')
    assert resp.status_code == 200
    assert 'content-security-policy' not in resp.headers
    assert 'cross-origin-opener-policy' not in resp.headers


def test_hashed_static_asset_has_no_document_csp(shell_root):
    """T4 (control): content-hashed bundles are not documents; no framing policy on them."""
    resp = _client().get('/shell/static/main.abc123.js')
    assert resp.status_code == 200
    assert 'content-security-policy' not in resp.headers
    assert 'cross-origin-opener-policy' not in resp.headers
    assert resp.headers['cache-control'] == 'public, max-age=31536000, immutable'


@pytest.mark.parametrize(
    ('value', 'expected'),
    [
        ('https://a.example', f'{CSP} https://a.example'),
        ('https://a.example  http://localhost:3000', f'{CSP} https://a.example http://localhost:3000'),
        ('HTTPS://*.Code-Server.Example:8443', f'{CSP} https://*.code-server.example:8443'),
        ('vscode-webview: vscode-file:', CSP),
        ('', CSP),
    ],
)
def test_frame_ancestors_extra_env_is_appended(shell_root, reload_shell, monkeypatch, value, expected):
    """T5: RR_SHELL_FRAME_ANCESTORS_EXTRA is appended (lowercased, deduplicated) to 'self' and the VS Code defaults."""
    mod = reload_shell(value)
    monkeypatch.setattr(mod, '_shell_root', str(shell_root))
    resp = _client().get('/shell/some/route')
    assert resp.status_code == 200
    assert resp.headers.get('content-security-policy') == expected
    assert resp.headers.get('cross-origin-opener-policy') == COOP


@pytest.mark.parametrize(
    'bad',
    [
        "'unsafe-inline'",
        "'self'",
        'a;b',
        'https://x/path',
        'https://a.example, vscode-webview:',
        '*.example',
        '*',
        'https://*',
        'http://*:80',
        'https://*.com',
        'https://a..b',
        'https:',
        'HTTP:',
        'data:',
        'blob:',
        'ws:',
        'wss:',
        'filesystem:',
        'javascript:',
    ],
)
def test_invalid_frame_ancestors_extra_refuses_import(reload_shell, bad):
    """T6: a malformed value stops startup and names the offending token."""
    with pytest.raises(ValueError, match='invalid RR_SHELL_FRAME_ANCESTORS_EXTRA'):
        reload_shell(bad)
