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

"""Everything stays as it is while isolation is ``off`` (#1022 PR1, design section 11, phase 0).

With ``RR_APP_ISOLATION`` unset or ``off``: the probe has no ``appIsolation``,
no entry carries ``firstParty`` / ``isolated`` or loses a field, the connect
result is the AccountInfo's own, ``/_t``, ``/_p`` and ``/_rr`` answer as they do
on the base (404 on every host), and no middleware is installed. The golden
fixture (``test_off_golden.py``, unchanged) covers the shell's own routes.

Test T40 of ``.rr-sec/PR1_PLAN.md``. Most checks are GUARDS and hold on the
base; the probe's ``appIsolation`` under ``optin``/``enforce`` is the red half.
"""

from __future__ import annotations

import copy

import pytest
from fastapi.testclient import TestClient

from . import isolation_support as sup
from .isolation_support import stamped_apps

PROBE_KEYS_OFF = {'version', 'capabilities', 'platform', 'apps', 'endpoints'}


@pytest.fixture
def off(isolation_env):
    isolation_env.set(RR_APP_ISOLATION=None)
    return isolation_env


@pytest.mark.asyncio
@pytest.mark.parametrize('mode_var', [None, 'off'])
async def test_off_probe_and_connect_unchanged(mode_var, isolation_env):
    """T40 (guard): under ``off`` the probe and the connect reply carry no isolation field and drop no field."""
    isolation_env.set(RR_APP_ISOLATION=mode_var)
    apps = stamped_apps()
    original = copy.deepcopy(apps)

    for caps in (None, [], ['appIsolation:1']):
        body = await sup.probe_body(copy.deepcopy(apps), caps)
        assert set(body) == PROBE_KEYS_OFF, set(body) ^ PROBE_KEYS_OFF
        assert 'appIsolation' not in body
        assert body['apps'] == original  # not one field of one entry changed

    from ai.account.models import AccountInfo

    expected = AccountInfo(
        userId='u1', auth='rr_secret', userToken='rr_secret', apps=copy.deepcopy(apps)
    ).to_connect_result()
    for auth_args in ({}, {'shellCaps': []}, {'shellCaps': ['appIsolation:1']}):
        _, response = await sup.connect(copy.deepcopy(apps), auth_args)
        assert response['body'] == expected
        for entry in response['body']['apps']:
            assert 'registryVersion' in entry  # nothing was dropped for an "old shell"


@pytest.mark.asyncio
async def test_off_pushes_are_unchanged(off, monkeypatch):
    """T40 (guard): the account push and the manifest push are the plain AccountInfo views under ``off``."""
    from ai.account.models import AccountInfo

    apps = stamped_apps()
    expected = AccountInfo(
        userId='u1', auth='rr_secret', userToken='rr_secret', apps=copy.deepcopy(apps)
    ).to_push_result()
    body, _ = await sup.pushed_account(copy.deepcopy(apps), monkeypatch, shell_caps=())
    assert body == expected
    manifest_body = await sup.manifest_pushed_account(copy.deepcopy(apps), monkeypatch, shell_caps=())
    assert [a['id'] for a in manifest_body['apps']] == [a['id'] for a in apps]
    for entry in manifest_body['apps']:
        assert 'registryVersion' in entry


def test_off_wire_view_returns_its_input(off):
    """T40: ``wire_view`` is the identity under ``off``, whatever the caps."""
    wire_view = sup.need(sup.load_module('ai.modules.shell.app_origin'), 'wire_view')
    apps = stamped_apps()
    for caps in (None, (), ('appIsolation:1',)):
        assert wire_view(apps, caps) == apps


def test_off_app_host_paths_behave_as_on_the_base(off):
    """T40 (guard): ``/_t``, ``/_p``, ``/_rr`` are plain 404s on every host, app-host-shaped or not."""
    client = TestClient(sup.shell_inner_app(), base_url=sup.SHELL_ORIGIN)
    label = sup.label_for('acme.thirdparty')
    for host in ('app.example', sup.app_host_of(label), 'localhost', 'a' * 25 + '.apps.example'):
        for path in (
            '/_t/x.y.z/v1/remoteEntry.js',
            '/_p/acme.thirdparty/v1/remoteEntry.js',
            '/_rr/frame.html',
            '/_rr/clear',
        ):
            resp = client.get(path, headers={'host': host})
            assert resp.status_code == 404, (host, path)
    # and the shell's own routes still answer on an app-host-shaped name
    assert client.get('/auth', headers={'host': sup.app_host_of(label)}).status_code == 200


def test_off_no_middleware_and_no_checks_at_startup(tmp_path, monkeypatch):
    """T40: ``off`` installs nothing and checks nothing (no template, key, runtime or capabilities file)."""
    import ai.modules.shell as shell_pkg
    import ai.modules.shell.shell as shell_mod
    from ai.web.server import WebServer

    sup.apply_env(monkeypatch, {})
    monkeypatch.setattr(shell_mod, '_shell_root', str(tmp_path / 'nothing' / 'shell'))
    shell_pkg.initModule(sup.FakeServer(), {})  # must not raise
    host_mod = sup.module_or_none('ai.web.app_host')
    if host_mod is not None:
        assert all(m.cls is not getattr(host_mod, 'AppHostMiddleware') for m in WebServer().app.user_middleware)


@pytest.mark.asyncio
@pytest.mark.parametrize('mode', ['optin', 'enforce'])
async def test_probe_carries_app_isolation_when_not_off(mode, isolation_env):
    """T40 (behavioural): not ``off``: the probe body gains ``appIsolation {mode, originTemplate, protoMin, protoMax}``."""
    isolation_env.set(RR_APP_ISOLATION=mode, RR_APP_ISOLATION_APPS='acme.thirdparty' if mode == 'optin' else None)
    body = await sup.probe_body(stamped_apps(), ['appIsolation:1'])
    assert body['appIsolation'] == {
        'mode': mode,
        'originTemplate': sup.TEMPLATE,
        'protoMin': 1,
        'protoMax': 1,
    }
    assert set(body) == PROBE_KEYS_OFF | {'appIsolation'}
    for secret in ('k1:', 'RR_EDGE_SECRET'):  # nothing about keys or the edge ever rides the probe
        assert secret not in repr(body)
