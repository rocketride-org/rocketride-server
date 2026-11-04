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

"""
OSS boot-seed trigger (``Account._seed_builtin_apps``): the per-app FORCE
decision. The version-march (manifest version string moved) stays; this adds
the digest trigger — an upgrade that rebuilt a bundle without bumping the
manifest version must still march, and a seed row predating the digest field
reads as changed. The trigger is tested in isolation: the shared seeder is
replaced with a recorder, so only the force policy is under test.
"""

import asyncio
from typing import Any, Dict, List


from ai.account import seed_apps
from ai.account.oss import Account
from ai.account.seed_apps import SEED_COMMENT

APP_ID = 'rocketride.hello'
ENTRY = {'id': APP_ID, 'name': 'Hello', 'version': '1.0.0', 'entry': '/apps/hello-ui/remoteEntry.js'}


def _seed_row(version: int, manifest_version: str = '1.0.0', digest: Any = 'sha-current') -> Dict:
    """A rail row the seeder minted: SEED_COMMENT + manifest + optional digest."""
    build = {'status': 'ok'}
    if digest is not None:
        build['bundleSha256'] = digest
    return {
        'version': version,
        'comment': SEED_COMMENT,
        'state': 'ready',
        'metadata': {'manifest': {'id': APP_ID, 'version': manifest_version}, 'build': build},
    }


def _run_trigger(monkeypatch, rows: List[Dict], local_digest: Any, entry: Dict = ENTRY) -> List[bool]:
    """Run _seed_builtin_apps against fakes; return the force flags it chose."""
    account = Account.__new__(Account)

    async def versions(org_id: str, app_id: str) -> List[Dict]:
        return list(rows)

    account.deployments_versions = versions  # type: ignore[method-assign]
    monkeypatch.setattr(seed_apps, 'load_manifest_entries', lambda: [entry])
    monkeypatch.setattr(seed_apps, 'bundle_digest', lambda app_id: local_digest)
    forces: List[bool] = []

    async def recorder(acct: Any, org_id: str, e: Dict, actor: Dict, *, force: bool = False, **kw: Any) -> bool:
        forces.append(force)
        return force

    monkeypatch.setattr(seed_apps, 'seed_manifest_app', recorder)
    asyncio.run(account._seed_builtin_apps())
    return forces


def test_absent_app_seeds_without_force(monkeypatch):
    assert _run_trigger(monkeypatch, [], 'sha-current') == [False]


def test_current_version_and_digest_is_a_noop(monkeypatch):
    assert _run_trigger(monkeypatch, [_seed_row(1)], 'sha-current') == [False]


def test_version_march_still_forces(monkeypatch):
    assert _run_trigger(monkeypatch, [_seed_row(1, manifest_version='0.9.0')], 'sha-current') == [True]


def test_changed_bundle_forces_even_without_a_version_bump(monkeypatch):
    assert _run_trigger(monkeypatch, [_seed_row(1)], 'sha-rebuilt') == [True]


def test_seed_row_without_a_digest_reads_as_changed(monkeypatch):
    # Predates the field: one re-seed records the digest.
    assert _run_trigger(monkeypatch, [_seed_row(1, digest=None)], 'sha-current') == [True]


def test_no_local_bundle_never_forces_on_digest(monkeypatch):
    assert _run_trigger(monkeypatch, [_seed_row(1)], None) == [False]


def test_user_rows_without_seed_rows_still_force_a_seed(monkeypatch):
    # OSS reclaims: the public rung must point at a seed, never a user row.
    rows = [{'version': 3, 'comment': 'my deploy', 'state': 'ready', 'metadata': {}}]
    assert _run_trigger(monkeypatch, rows, 'sha-current') == [True]


def test_newest_seed_row_wins_over_older_ones(monkeypatch):
    # Newest-first ordering: the current seed is compared, not a stale one.
    rows = [_seed_row(2, digest='sha-current'), _seed_row(1, digest='sha-old')]
    assert _run_trigger(monkeypatch, rows, 'sha-current') == [False]
