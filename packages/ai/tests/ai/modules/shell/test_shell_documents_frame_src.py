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

"""Report-Only ``frame-src`` on shell documents (#1022 PR1, Appendix C).

When the mode is not ``off`` every shell DOCUMENT (the SPA ``index.html``, a
prerender capture, any HTML under the shell root) also carries
``Content-Security-Policy-Report-Only: frame-src 'self' <app wildcard>``, where
the wildcard is the origin template with ``{label}`` replaced by ``*``. It ships
Report-Only: it is enforced 30 days after staging reaches ``enforce``. Assets
get no such header, the enforced ``frame-ancestors`` header from PR0 is
unchanged, and under ``off`` nothing is added (the golden fixture pins that).

The mode is read per request (``os.environ`` at call time).

Test T41 of ``.rr-sec/PR1_PLAN.md``.
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import ai.modules.shell.shell as shell_mod

from . import isolation_support as sup

REPORT_ONLY = 'content-security-policy-report-only'


@pytest.fixture
def documents(isolation_env, tmp_path):
    """The built shell tree of the isolation fixture plus a prerender capture, an asset and a stray html."""
    shell = isolation_env.static / 'shell'
    (shell / '_prerender' / 'pricing').mkdir(parents=True)
    (shell / '_prerender' / 'pricing' / 'index.html').write_text('<!doctype html><title>pricing</title>')
    (shell / 'static').mkdir()
    (shell / 'static' / 'main.abc123.js').write_text('console.log(1)')
    (shell / 'static' / 'view.abc123.html').write_text('<!doctype html><title>view</title>')
    (shell / 'themes').mkdir()
    (shell / 'themes' / 'dark.json').write_text('{}')
    app = FastAPI()
    app.get('/shell/{file_path:path}')(shell_mod.shell_static)
    for route in shell_mod.PUBLIC_ROUTES:
        app.get(route)(shell_mod.shell_static)
    return TestClient(app)


DOCUMENT_PATHS = ['/', '/pricing', '/shell/index.html', '/shell/some/client/route', '/shell/static/view.abc123.html']
ASSET_PATHS = ['/shell/static/main.abc123.js', '/shell/themes/dark.json']


def _frame_src(resp):
    from .isolation_support import csp_directives

    return csp_directives(resp.headers[REPORT_ONLY])['frame-src']


@pytest.mark.parametrize('mode', ['optin', 'enforce'])
@pytest.mark.parametrize('path', DOCUMENT_PATHS)
def test_shell_documents_frame_src_report_only_only_when_not_off(mode, path, documents, isolation_env):
    """T41: a shell document gets a Report-Only ``frame-src 'self' https://*.apps.example`` when not ``off``."""
    isolation_env.set(RR_APP_ISOLATION=mode, RR_APP_ISOLATION_APPS='acme.x' if mode == 'optin' else None)
    resp = documents.get(path)
    assert resp.status_code == 200
    assert REPORT_ONLY in resp.headers, path
    assert _frame_src(resp) == ["'self'", 'https://*.apps.example']
    # the enforced policy of PR0 is exactly what it was: no frame-src enforced yet
    assert resp.headers['content-security-policy'].startswith('frame-ancestors ')
    assert 'frame-src' not in resp.headers['content-security-policy']


@pytest.mark.parametrize('path', DOCUMENT_PATHS)
def test_no_report_only_header_under_off(path, documents, isolation_env):
    """T41 (control): under ``off`` the documents carry no Report-Only policy at all."""
    isolation_env.set(RR_APP_ISOLATION=None)
    resp = documents.get(path)
    assert resp.status_code == 200
    assert REPORT_ONLY not in resp.headers


@pytest.mark.parametrize('path', ASSET_PATHS)
def test_assets_never_get_the_report_only_header(path, documents):
    """T41: scripts, styles and data files are not documents."""
    resp = documents.get(path)
    assert resp.status_code == 200
    assert REPORT_ONLY not in resp.headers


def test_localhost_template_keeps_scheme_and_port(documents, isolation_env):
    """T41: the wildcard is the template with ``{label}`` replaced by ``*`` (scheme and port kept)."""
    isolation_env.set(RR_APP_ORIGIN_TEMPLATE=sup.LOCAL_TEMPLATE)
    assert _frame_src(documents.get('/')) == ["'self'", 'http://*.apps.localhost:8765']
