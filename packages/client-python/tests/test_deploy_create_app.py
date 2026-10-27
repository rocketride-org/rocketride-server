# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""deploy.create_app defaults the developer id from the account; deploy.add_app forwards the working copy's projectId without stamping it (TS twin parity)."""

import json
import os

import pytest

from rocketride import _app_scaffold
from rocketride.deploy import DeployApi


class _FakeClient:
    """Just enough client for create_app: connection info and the cached login result."""

    def __init__(self, account_info):
        self._account_info = account_info

    def get_connection_info(self):
        return {'uri': ''}

    def get_account_info(self):
        return self._account_info


@pytest.fixture
def captured(monkeypatch):
    """Capture the developer_id create_app hands to the scaffold."""
    calls = {}

    def fake_create_app_workspace(workspace_root, slug, **kwargs):
        calls['developer_id'] = kwargs['developer_id']
        return {'appId': f'{kwargs["developer_id"] or "local"}.{slug}'}

    monkeypatch.setattr(_app_scaffold, 'create_app_workspace', fake_create_app_workspace)
    return calls


async def test_uses_the_org_developer_id(captured):
    await DeployApi(_FakeClient({'organization': {'developerId': 'acme'}})).create_app('clock', install=False)

    assert captured['developer_id'] == 'acme'


async def test_explicit_developer_id_wins(captured):
    await DeployApi(_FakeClient({'organization': {'developerId': 'acme'}})).create_app(
        'clock', developer_id='other', install=False
    )

    assert captured['developer_id'] == 'other'


@pytest.mark.parametrize('account_info', [None, {}, {'organization': None}, {'organization': {'developerId': None}}])
async def test_falls_through_to_the_scaffold_default(captured, account_info):
    await DeployApi(_FakeClient(account_info)).create_app('clock', install=False)

    assert captured['developer_id'] is None


def _write_app(ws, manifest, legacy_marker=None):
    """Write a minimal app folder under ws/apps/clock."""
    folder = os.path.join(ws, 'apps', 'clock')
    os.makedirs(os.path.join(folder, 'src'))
    with open(os.path.join(folder, 'package.json'), 'w', encoding='utf-8') as f:
        json.dump({'name': 'clock', 'appManifest': manifest}, f)
    with open(os.path.join(folder, 'src', 'App.tsx'), 'w', encoding='utf-8') as f:
        f.write('export default () => null;\n')
    if legacy_marker is not None:
        with open(os.path.join(folder, 'clock.rrapp'), 'w', encoding='utf-8') as f:
            json.dump(legacy_marker, f)
    return folder


@pytest.fixture
def sent(monkeypatch):
    """Capture the metadata add_app sends instead of calling a server."""
    calls = {}

    async def fake_add(self, **kwargs):
        calls.update(kwargs)
        return {'artifact': {}}

    monkeypatch.setattr(DeployApi, 'add', fake_add)
    return calls


@pytest.mark.parametrize(
    ('manifest', 'legacy_marker', 'expected'),
    [
        ({'id': 'acme.clock', 'projectId': 'manifest-guid'}, None, 'manifest-guid'),
        ({'id': 'acme.clock'}, {'id': 'acme.clock', 'projectId': 'legacy-guid'}, 'legacy-guid'),
    ],
)
async def test_add_app_forwards_the_working_copy_project_id(sent, tmp_path, manifest, legacy_marker, expected):
    _write_app(str(tmp_path), manifest, legacy_marker)

    await DeployApi(_FakeClient({})).add_app('apps/clock', workspace_root=str(tmp_path))

    assert sent['metadata'] == {'projectId': expected, 'appRoot': 'apps/clock'}


async def test_add_app_never_stamps_a_missing_project_id(sent, tmp_path):
    folder = _write_app(str(tmp_path), {'id': 'acme.clock'})
    with open(os.path.join(folder, 'package.json'), encoding='utf-8') as f:
        before = f.read()

    await DeployApi(_FakeClient({})).add_app('apps/clock', workspace_root=str(tmp_path))

    assert sent['metadata'] == {'appRoot': 'apps/clock'}
    with open(os.path.join(folder, 'package.json'), encoding='utf-8') as f:
        assert f.read() == before


async def test_add_app_caller_project_id_wins(sent, tmp_path):
    _write_app(str(tmp_path), {'id': 'acme.clock', 'projectId': 'manifest-guid'})

    await DeployApi(_FakeClient({})).add_app(
        'apps/clock', workspace_root=str(tmp_path), metadata={'projectId': 'caller-guid'}
    )

    assert sent['metadata']['projectId'] == 'caller-guid'
