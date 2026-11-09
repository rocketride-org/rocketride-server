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
Publish-gate tests: privilege, reserved prefixes, cross-app collisions derived
from published manifests, data entries, snapshot files, and the build-emitted
manifest as the gated source. Every problem is reported at once, with an
actionable message; storage failures fail closed.
"""

from __future__ import annotations

import pytest

import ai.modules.shell.public_pages as pp
from ai.modules.shell.public_pages import gate_errors

from .hostile_fixtures import FILES, HOME_MANIFEST, hostile_account

DIST = 'orgs/p/files/.deployments/rocketride.other/v000001-abc/dist'


@pytest.fixture(autouse=True)
def _roots(monkeypatch):
    monkeypatch.setenv('RR_PUBLIC_ROOT_APPS', 'rocketride.home,rocketride.other,rocketride.secret')


async def test_manifest_without_the_sections_costs_nothing():
    acct = hostile_account()
    assert await gate_errors('acme.brandy', {'name': 'Brandy'}, DIST, acct) == []
    assert acct.publish_list_calls == 0


async def test_third_party_rejected():
    errors = await gate_errors('acme.brandy', {'publicPages': [{'path': '/x', 'title': 'X'}]}, DIST, hostile_account())
    assert len(errors) == 1 and 'platform capability' in errors[0]


async def test_a_manifest_without_a_valid_page_never_loads_the_platform_claims():
    acct = hostile_account()
    acct.fail = True  # platform storage is down
    third_party = {'publicPages': [{'path': '/x', 'title': 'X'}]}
    errors = await gate_errors('acme.brandy', third_party, 'orgs/a/files/.deployments/acme.brandy/v1/dist', acct)
    assert len(errors) == 1 and 'platform capability' in errors[0]
    assert acct.publish_list_calls == 0


async def test_cross_app_collision_with_a_published_manifest_is_rejected():
    manifest = {'publicPages': [{'path': '/pricing', 'title': 'Mine'}, {'path': '/fresh', 'title': 'F'}]}
    errors = await gate_errors('rocketride.other', manifest, DIST, hostile_account())
    assert errors == [
        "publicPages path '/pricing' is already claimed by the published app rocketride.home "
        '(first claim wins; the claim is released when that app unpublishes); choose another path'
    ]


async def test_republishing_your_own_paths_is_not_a_collision():
    assert await gate_errors('rocketride.home', HOME_MANIFEST, DIST, hostile_account()) == []


async def test_an_unpublished_apps_claims_are_released():
    # rocketride.secret claims /leaksecret, but its public row is disabled.
    manifest = {'publicPages': [{'path': '/leaksecret', 'title': 'Now mine'}]}
    assert await gate_errors('rocketride.other', manifest, DIST, hostile_account()) == []


async def test_missing_snapshot_rejected_present_snapshot_allowed():
    manifest = {'publicPages': [{'path': '/fresh', 'title': 'F', 'snapshot': 'pages/fresh.html'}]}
    errors = await gate_errors('rocketride.other', manifest, DIST, hostile_account())
    assert len(errors) == 1 and "snapshot 'pages/fresh.html' is not in the built version" in errors[0]
    FILES[f'{DIST}/pages/fresh.html'] = b'<html></html>'
    assert await gate_errors('rocketride.other', manifest, DIST, hostile_account()) == []


async def test_every_problem_is_reported_at_once():
    manifest = {
        'publicPages': [
            {'path': '/Bad', 'title': 'x'},
            {'path': '/api/x', 'title': 'x'},
            {'path': '/d', 'title': 'x', 'data': ['nope']},
            {'path': '/w/*', 'title': 'x'},
            {'path': '/pricing', 'title': 'x'},
            {'path': '/s', 'title': 'x', 'snapshot': 'pages/s.html'},
        ]
    }
    errors = await gate_errors('rocketride.other', manifest, DIST, hostile_account())
    assert len(errors) == 6
    needles = ('lowercase', 'reserved', "unknown data source 'nope'", 'wildcard pages', 'already claimed', 'snapshot')
    for needle in needles:
        assert any(needle in e for e in errors), needle


async def test_a_snapshot_read_failure_other_than_not_found_fails_closed(monkeypatch):
    from .hostile_fixtures import read_file

    async def flaky(path):
        if path.endswith('/pages/fresh.html'):
            raise OSError('store down')
        return await read_file(path)

    monkeypatch.setattr(pp, 'read_artifact_file', flaky)
    manifest = {'publicPages': [{'path': '/fresh', 'title': 'F', 'snapshot': 'pages/fresh.html'}]}
    with pytest.raises(OSError):
        await gate_errors('rocketride.other', manifest, DIST, hostile_account())


async def test_storage_failure_fails_closed():
    acct = hostile_account()
    acct.fail = True
    with pytest.raises(RuntimeError):
        await gate_errors('rocketride.other', {'publicPages': [{'path': '/x', 'title': 'X'}]}, DIST, acct)


async def test_an_unreadable_root_app_fails_closed_naming_it():
    acct = hostile_account()
    del acct.artifacts[('00000000-platform', 'rocketride.home', 1)]
    with pytest.raises(RuntimeError, match='rocketride.home'):
        await gate_errors('rocketride.other', {'publicPages': [{'path': '/x', 'title': 'X'}]}, DIST, acct)


async def test_a_root_app_with_an_unreadable_current_version_can_publish_a_fix():
    acct = hostile_account()
    del acct.artifacts[('00000000-platform', 'rocketride.home', 1)]
    assert await gate_errors('rocketride.home', HOME_MANIFEST, DIST, acct) == []


async def test_an_unreadable_non_root_platform_app_never_blocks_a_publish():
    # rocketride.tool cannot claim root pages, so it holds no claim to check against.
    acct = hostile_account()
    acct.add('00000000-platform', 'rocketride.tool', {'name': 'Tool'})
    del acct.artifacts[('00000000-platform', 'rocketride.tool', 1)]
    assert await gate_errors('rocketride.home', HOME_MANIFEST, DIST, acct) == []


async def test_a_platform_version_without_an_artifact_path_fails_closed():
    with pytest.raises(ValueError, match='no artifact path'):
        await gate_errors('rocketride.other', {'name': 'Other'}, '', hostile_account())
    # A third party's build output is never read: nothing to locate.
    assert await gate_errors('acme.brandy', {'name': 'B'}, '', hostile_account()) == []


async def test_platform_build_output_manifest_is_the_gated_source():
    # The saas build ships publicPages in dist/app-manifest.json, not in
    # metadata.manifest: the gate validates the emitted file.
    FILES[f'{DIST}/app-manifest.json'] = b'{"publicPages": [{"path": "/Bad", "title": "x"}], "futureSection": {"x": 1}}'
    errors = await gate_errors('rocketride.other', {'name': 'Other'}, DIST, hostile_account())
    assert len(errors) == 1 and 'lowercase' in errors[0]


async def test_malformed_build_output_manifest_is_refused():
    FILES[f'{DIST}/app-manifest.json'] = b'[1, 2]'
    errors = await gate_errors('rocketride.other', {'name': 'Other'}, DIST, hostile_account())
    assert 'app-manifest.json in the build output is not a JSON object' in errors[0]


async def test_third_party_build_output_is_never_read(monkeypatch):
    async def boom(path):
        raise AssertionError('no read for a third party')

    monkeypatch.setattr(pp, 'read_artifact_file', boom)
    assert await gate_errors('acme.brandy', {'name': 'B'}, DIST, hostile_account()) == []
