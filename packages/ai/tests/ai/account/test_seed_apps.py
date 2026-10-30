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

"""The seeder's bundle digest and the changed-build policy built on it.

A seeded version records the digest of the bundle it was copied from;
``bundle_changed`` compares the pod's bundle with the newest seed row's, so an
orchestrator can re-seed only the apps whose build moved. The local static
tree is a temp directory and the registry is a fake.
"""

import pytest

from ai.account import seed_apps
from ai.account.seed_apps import SEED_COMMENT, bundle_changed, bundle_digest, seed_app

APP_ID = 'rocketride.home'
ENTRY = {'id': APP_ID, 'name': 'Home', 'version': '1.0.0', 'entry': '/apps/rocketride.home/remoteEntry.js'}


@pytest.fixture
def static_apps(tmp_path, monkeypatch):
    """Point the seeder's local bundle root at a temp static/apps tree."""
    monkeypatch.setattr(seed_apps, '_local_bundle_root', lambda app_id: str(tmp_path / app_id))
    return tmp_path


def _write(root, files):
    for rel, data in files.items():
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)


class _Registry:
    """Just enough of the account for the seeder: rows newest-first, publish captured."""

    def __init__(self, rows=None):
        self.rows = list(rows or [])
        self.published = []

    async def deployments_versions(self, org_id, app_id):
        return list(self.rows)

    async def deployments_publish(self, org_id, app_id, artifact, actor, *, comment, metadata, state):
        self.published.append(metadata)
        return {
            'version': len(self.rows) + 1,
            'artifactPath': f'.deployments/{app_id}/v1-abcdef12.json',
            'metadata': metadata,
        }

    async def deployments_set_build(self, org_id, app_id, version, build):
        return {}


def _seed_row(digest=None, comment=SEED_COMMENT):
    build = {'status': 'ok', 'seeded': True}
    if digest is not None:
        build['bundleSha256'] = digest
    return {'version': 1, 'comment': comment, 'state': 'ready', 'metadata': {'build': build}}


# =============================================================================
# bundle_digest
# =============================================================================


def test_no_local_bundle_has_no_digest(static_apps):
    assert bundle_digest(APP_ID) is None


def test_the_same_files_give_the_same_digest_whatever_the_write_order(static_apps, tmp_path_factory, monkeypatch):
    _write(static_apps / APP_ID, {'remoteEntry.js': b'a', 'static/js/index.js': b'b'})
    first = bundle_digest(APP_ID)

    other = tmp_path_factory.mktemp('other')
    _write(other / APP_ID, {'static/js/index.js': b'b', 'remoteEntry.js': b'a'})
    monkeypatch.setattr(seed_apps, '_local_bundle_root', lambda app_id: str(other / app_id))

    assert bundle_digest(APP_ID) == first


@pytest.mark.parametrize(
    'files',
    [
        {'remoteEntry.js': b'a', 'static/js/index.js': b'changed'},
        {'remoteEntry.js': b'a', 'static/js/index.js': b'b', 'static/js/new.js': b'c'},
        {'remoteEntry.js': b'a'},
        {'remoteEntry.js': b'a', 'static/js/renamed.js': b'b'},
    ],
    ids=['content', 'added', 'removed', 'renamed'],
)
def test_any_file_change_changes_the_digest(static_apps, tmp_path_factory, monkeypatch, files):
    _write(static_apps / APP_ID, {'remoteEntry.js': b'a', 'static/js/index.js': b'b'})
    before = bundle_digest(APP_ID)

    other = tmp_path_factory.mktemp('other')
    _write(other / APP_ID, files)
    monkeypatch.setattr(seed_apps, '_local_bundle_root', lambda app_id: str(other / app_id))

    assert bundle_digest(APP_ID) != before


# =============================================================================
# seed_app records the digest
# =============================================================================


@pytest.mark.asyncio
async def test_a_seeded_version_records_its_bundle_digest(static_apps, monkeypatch):
    _write(static_apps / APP_ID, {'remoteEntry.js': b'a'})

    async def copied(app_id, artifact_path):
        return 1

    monkeypatch.setattr(seed_apps, 'copy_bundle_to_store', copied)
    registry = _Registry()

    await seed_app(registry, 'org', ENTRY, seed_apps.SYSTEM_ACTOR)

    assert registry.published[0]['build']['bundleSha256'] == bundle_digest(APP_ID)


# =============================================================================
# bundle_changed
# =============================================================================


@pytest.mark.asyncio
async def test_an_unchanged_bundle_is_not_reseeded(static_apps):
    _write(static_apps / APP_ID, {'remoteEntry.js': b'a'})
    registry = _Registry([_seed_row(bundle_digest(APP_ID))])

    assert await bundle_changed(registry, 'org', ENTRY) is False


@pytest.mark.asyncio
async def test_a_changed_bundle_is_reseeded(static_apps):
    _write(static_apps / APP_ID, {'remoteEntry.js': b'new build'})
    registry = _Registry([_seed_row('0' * 64)])

    assert await bundle_changed(registry, 'org', ENTRY) is True


@pytest.mark.asyncio
async def test_a_seed_row_from_before_the_digest_counts_as_changed(static_apps):
    _write(static_apps / APP_ID, {'remoteEntry.js': b'a'})
    registry = _Registry([_seed_row()])

    assert await bundle_changed(registry, 'org', ENTRY) is True


@pytest.mark.asyncio
async def test_only_the_newest_seed_row_counts_and_user_deploys_are_ignored(static_apps):
    _write(static_apps / APP_ID, {'remoteEntry.js': b'a'})
    current = bundle_digest(APP_ID)
    registry = _Registry(
        [
            _seed_row(comment='deployed from the App Builder'),
            _seed_row(current),
            _seed_row('0' * 64),
        ]
    )

    assert await bundle_changed(registry, 'org', ENTRY) is False


@pytest.mark.asyncio
@pytest.mark.parametrize(
    'rows',
    [[], [_seed_row(comment='deployed from the App Builder')]],
    ids=['no rows', 'no seed rows'],
)
async def test_apps_without_a_seed_row_are_left_to_the_plain_seed(static_apps, rows):
    _write(static_apps / APP_ID, {'remoteEntry.js': b'a'})

    assert await bundle_changed(_Registry(rows), 'org', ENTRY) is False


@pytest.mark.asyncio
async def test_without_a_local_bundle_there_is_nothing_to_reseed_from(static_apps):
    registry = _Registry([_seed_row('0' * 64)])

    assert await bundle_changed(registry, 'org', ENTRY) is False
