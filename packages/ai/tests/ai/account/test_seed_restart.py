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

"""End-to-end: consecutive OSS boot seeds over a REAL file store and the REAL boot seeder.

Each "boot" is a fresh Store singleton and a fresh Account, with time moved on,
so every per-process value differs between boots; only the bundle bytes and
apps.json stay (or change) as the test says.
"""

import asyncio
import json
import os
import time

import pytest

from ai.account import seed_apps
from ai.account.oss import Account
from ai.account.store import Store

APP = 'rocketride.hello'
ENTRY = {'id': APP, 'name': 'Hello', 'version': '1.2.0', 'moduleId': 'rocketride_hello'}


@pytest.fixture
def env(tmp_path, monkeypatch):
    store_dir = tmp_path / 'store'
    store_dir.mkdir()
    bundle = tmp_path / 'static' / 'apps' / APP
    (bundle / 'static' / 'js').mkdir(parents=True)
    (bundle / 'remoteEntry.js').write_text('remote v1')
    (bundle / 'static' / 'js' / 'index.abc.js').write_text('index v1')
    monkeypatch.setenv('RR_STORE_URL', f'filesystem://{store_dir}')
    monkeypatch.setattr(seed_apps, '_local_bundle_root', lambda app_id: str(tmp_path / 'static' / 'apps' / app_id))
    monkeypatch.setattr(seed_apps, 'load_manifest_entries', lambda: [dict(ENTRY)])
    yield store_dir, bundle
    Store.reset()


def _boot():
    """One server start: new store singleton, new account, the real boot seed."""
    Store.reset()
    account = Account.__new__(Account)
    account._deployments_backend = None
    asyncio.run(account._seed_builtin_apps())
    return account


def _meta(store_dir):
    path = os.path.join(store_dir, 'orgs', 'local', 'files', '.deployments', APP, 'meta.json')
    with open(path, 'rb') as f:
        raw = f.read()
    return raw, json.loads(raw)


def test_unchanged_restarts_publish_nothing_and_a_changed_bundle_publishes_one(env):
    store_dir, bundle = env

    _boot()
    raw1, meta1 = _meta(store_dir)
    assert [v['version'] for v in meta1['versions']] == [1]
    assert meta1['publishes']['@public']['version'] == 1

    # Two more unchanged restarts: the registry file is byte-identical.
    for _ in range(2):
        time.sleep(0.05)
        _boot()
        raw, _ = _meta(store_dir)
        assert raw == raw1

    # A rebuilt bundle: exactly one new version, the public pin moves to it.
    (bundle / 'static' / 'js' / 'index.abc.js').write_text('index v2')
    _boot()
    raw2, meta2 = _meta(store_dir)
    assert [v['version'] for v in meta2['versions']] == [1, 2]
    assert meta2['publishes']['@public']['version'] == 2
    assert meta2['nextVersion'] == 3

    # And restarts after it are no-ops again.
    _boot()
    raw3, _ = _meta(store_dir)
    assert raw3 == raw2
