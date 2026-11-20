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

"""Tests for the publish-row helpers shared by the store walk and the public page aggregate.

``app_deploy`` (what a browser is handed) and ``public_pages`` (the public page
map) both decide serving and precedence through ``ai.account.app_rows``, so
these rules are pinned here, once, for both callers.
"""

import pytest

from ai.account.app_rows import (
    precedence_sorted,
    public_artifact,
    public_winners,
    resolve_account,
    serving_block_of,
)
from ai.account.store import StorageError

AUD_USER = {'type': 'user', 'id': 'u1'}
AUD_TEAM = {'type': 'team', 'id': 't1'}
AUD_PUBLIC = {'type': 'public', 'id': ''}


def _binding(audience, binding='enabled', deployment='ready', build='ok'):
    """One joined publish row as the backends return it."""
    return {'state': binding, 'audience': dict(audience), 'artifactState': deployment, 'artifactBuild': build}


@pytest.mark.parametrize(
    'row, ladder, expected',
    [
        (_binding(AUD_USER), True, ''),
        # The owner's own switch outranks every other cause.
        (_binding(AUD_USER, binding='disabled', deployment='failed', build='failed'), True, 'disabled'),
        (_binding(AUD_TEAM, deployment='failed'), True, 'failed'),
        (_binding(AUD_PUBLIC, deployment='submit'), True, 'in-review'),
        (_binding(AUD_PUBLIC, deployment='rejected'), True, 'rejected'),
        (_binding(AUD_PUBLIC, deployment='private'), True, 'not-approved'),
        # No review ladder: public serves like an internal rung.
        (_binding(AUD_PUBLIC, deployment='private'), False, ''),
        # Internal rungs serve anything but a failed deployment.
        (_binding(AUD_TEAM, deployment='submit'), True, ''),
        (_binding(AUD_USER, build='failed'), True, 'build-failed'),
        (_binding(AUD_USER, build='building'), True, 'building'),
        (_binding(AUD_USER, build=''), True, 'building'),
        # Review comes before the build: an unapproved, unbuilt public version is not approved.
        (_binding(AUD_PUBLIC, deployment='private', build='building'), True, 'not-approved'),
    ],
)
def test_serving_block_of_names_why_a_binding_does_not_serve(row, ladder, expected):
    """#2461: one gate decides serving for the manifest AND the owner's view."""
    assert serving_block_of(row, ladder) == expected


def test_serving_block_of_treats_missing_fields_as_not_serving():
    assert serving_block_of({}, True) == 'disabled'
    assert serving_block_of({'state': 'enabled'}, True) == 'building'
    # No audience reads as an internal rung: no review needed, but still no build.
    assert serving_block_of({'state': 'enabled', 'artifactBuild': 'ok'}, True) == ''


def _row(audience, org):
    return {'audience': dict(audience), 'orgId': org}


def test_precedence_sorted_puts_the_most_specific_audience_last():
    rows = [_row(AUD_USER, 'o1'), _row(AUD_PUBLIC, 'o1'), _row(AUD_TEAM, 'o1')]
    ordered = precedence_sorted(rows)
    assert [r['audience']['type'] for r in ordered] == ['public', 'team', 'user']
    assert [r['audience']['type'] for r in rows] == ['user', 'public', 'team']  # the input is not reordered


def test_precedence_sorted_lets_the_lowest_org_win_a_same_rung_tie():
    rows = [_row(AUD_PUBLIC, 'org-a'), _row(AUD_PUBLIC, 'org-c'), _row(AUD_PUBLIC, 'org-b')]
    assert [r['orgId'] for r in precedence_sorted(rows)] == ['org-c', 'org-b', 'org-a']
    # The rung still decides first: a team row of the highest org beats every public row.
    rows.append(_row(AUD_TEAM, 'org-z'))
    assert precedence_sorted(rows)[-1]['orgId'] == 'org-z'


def test_precedence_sorted_ranks_an_unknown_or_missing_audience_with_public():
    unknown = {'audience': {'type': 'org'}, 'orgId': 'o2'}
    missing = {'orgId': 'o3'}
    ordered = precedence_sorted([_row(AUD_TEAM, 'o9'), unknown, missing, _row(AUD_PUBLIC, 'o1')])
    assert ordered[-1]['audience'] == AUD_TEAM
    # The three rank-0 rows keep the org order: highest first, so the lowest lands last among them.
    assert [r['orgId'] for r in ordered[:3]] == ['o3', 'o2', 'o1']


class _Account:
    """An account layer whose public rung lists ``rows``."""

    def __init__(self, rows, capabilities=(), review_ladder=True):
        self.rows = rows
        self.capabilities = capabilities
        self.review_ladder = review_ladder
        self.listed = []

    async def publish_list(self, org_id, kind, audiences):
        self.listed.append((org_id, kind, audiences))
        return [dict(r) for r in self.rows]


def _public(app_id, org, **fields):
    return {**_binding(AUD_PUBLIC), 'appId': app_id, 'orgId': org, **fields}


@pytest.mark.parametrize('capabilities, org', [((), 'local'), (('saas',), '')], ids=['oss', 'saas'])
async def test_public_winners_lists_the_public_rung_of_every_org_on_saas_only(capabilities, org):
    acct = _Account([], capabilities)
    assert await public_winners(acct) == (org, {})
    assert acct.listed == [(org, 'app', [{'type': 'public', 'id': ''}])]


async def test_public_winners_reads_the_account_it_is_given():
    org, winners = await public_winners(_Account([_public('a.x', 'o1')]))
    assert org == 'local' and list(winners) == ['a.x']


async def test_public_winners_picks_each_apps_serving_precedence_winner():
    rows = [
        _public('a.x', 'org-b'),
        _public('a.x', 'org-0', state='disabled'),
        # An anonymous caller holds no permissions.
        _public('a.x', 'org-1', snapshot={'requiredPermissions': ['billing.read']}),
        _public('a.x', 'org-a'),
        _public('a.y', 'org-c', artifactState='submit'),
    ]
    _, winners = await public_winners(_Account(rows))
    assert {app: row['orgId'] for app, row in winners.items()} == {'a.x': 'org-a'}
    # Without a review ladder an unapproved public binding serves.
    _, winners = await public_winners(_Account(rows, review_ladder=False))
    assert {app: row['orgId'] for app, row in winners.items()} == {'a.x': 'org-a', 'a.y': 'org-c'}


class _Registry:
    """An account layer whose registry holds ``artifacts`` by (org, app, version)."""

    def __init__(self, artifacts):
        self.artifacts = artifacts
        self.reads = []

    async def deployments_artifact(self, org_id, app_id, version):
        self.reads.append((org_id, app_id, version))
        if (org_id, app_id, version) not in self.artifacts:
            raise StorageError(f'{app_id} v{version}: not in the registry')
        return self.artifacts[(org_id, app_id, version)]


def _app_artifact(**manifest):
    return {'kind': 'app', 'name': 'X', 'metadata': {'manifest': manifest}}


def _winner(**fields):
    return {'appId': 'a.x', 'orgId': 'org-a', 'version': 3, 'artifactPath': 'orgs/org-a/a.x/v3.json', **fields}


async def test_public_artifact_reads_the_winning_version_from_the_rows_publisher_org():
    artifact = _app_artifact(public=True)
    acct = _Registry({('org-a', 'a.x', 3): artifact})
    assert await public_artifact(acct, '', 'a.x', _winner(snapshot={'name': 'X'})) is artifact
    assert acct.reads == [('org-a', 'a.x', 3)]


async def test_public_artifact_reads_a_row_that_names_no_org_from_the_rungs_org():
    acct = _Registry({('local', 'a.x', 3): _app_artifact()})
    assert await public_artifact(acct, 'local', 'a.x', _winner(orgId='')) is not None
    assert acct.reads == [('local', 'a.x', 3)]


async def test_a_binding_that_says_public_false_hides_the_app_unread():
    acct = _Registry({})
    assert await public_artifact(acct, '', 'a.x', _winner(snapshot={'public': False})) is None
    # Hidden comes first: a hidden app's malformed row is not an error.
    assert await public_artifact(acct, '', 'a.x', _winner(snapshot={'public': False}, version='3')) is None
    assert acct.reads == []


@pytest.mark.parametrize(
    'artifact',
    [
        # The DB edition's snapshot drops public: the manifest still says it.
        _app_artifact(public=False),
        # The store walk serves app artifacts only.
        {'kind': 'pipeline', 'metadata': {'manifest': {}}},
        None,
        [],
    ],
    ids=['manifest-says-private', 'not-an-app', 'none', 'not-a-dict'],
)
async def test_an_artifact_the_store_walk_would_not_serve_hides_the_app(artifact):
    acct = _Registry({('org-a', 'a.x', 3): artifact})
    assert await public_artifact(acct, '', 'a.x', _winner(snapshot={'name': 'X'})) is None


@pytest.mark.parametrize(
    'fields',
    [{'version': '3'}, {'version': None}, {'artifactPath': ''}, {'artifactPath': None}],
    ids=['version-text', 'no-version', 'empty-path', 'no-path'],
)
async def test_a_malformed_row_is_a_value_error_and_reads_nothing(fields):
    acct = _Registry({})
    with pytest.raises(ValueError, match='malformed public row'):
        await public_artifact(acct, '', 'a.x', _winner(**fields))
    assert acct.reads == []


async def test_a_registry_failure_reaches_the_caller():
    with pytest.raises(StorageError, match='not in the registry'):
        await public_artifact(_Registry({}), '', 'a.x', _winner())


def test_resolve_account_defaults_to_the_engines_account_layer():
    from ai.account import account

    acct = _Registry({})
    assert resolve_account(acct) is acct
    assert resolve_account(None) is account
