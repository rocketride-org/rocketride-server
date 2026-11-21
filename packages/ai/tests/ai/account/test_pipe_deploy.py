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

"""Unit tests for ai.account.pipe_deploy: the publish row source.

ONE read of the one publish table per project (plan 10.1, C.17); the slots
come back in the caller's order. A failing store raises; a name is never
reported absent because the database was down (audit 2026-11-12).
"""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

import ai.account.pipe_deploy as pipe_deploy_mod
from ai.account import account as account_singleton
from ai.account.audience import PUBLIC_AUDIENCE
from ai.account.pipe_deploy import pipe_catalog_row, publish_rows, resolve_pipe_version


def _row(audience, version=1, state='enabled', artifact_state='ready', billing=''):
    """One publish row as publish_of_app answers it."""
    return {
        'kind': 'pipe',
        'audience': audience,
        'version': version,
        'state': state,
        'artifactState': artifact_state,
        'billingTeamId': billing,
    }


@pytest.mark.asyncio
async def test_a_failing_publish_read_raises_instead_of_reading_as_no_rows():
    """publish_of_app failing is the caller's error, not an empty row set."""
    account = AsyncMock()
    account.publish_of_app = AsyncMock(side_effect=RuntimeError('db down'))

    with pytest.raises(RuntimeError, match='db down'):
        await publish_rows(account, 'org-1', 'docBrain', ['=team/team-1'])


@pytest.mark.asyncio
async def test_one_read_answers_every_slot_in_the_callers_order():
    """The project's rows are read ONCE; the slots asked for come back in order."""
    account = AsyncMock()
    account.publish_of_app = AsyncMock(
        return_value=[
            _row({'type': 'public', 'id': ''}, version=3, artifact_state='ready'),
            _row({'type': 'team', 'id': 'team-1'}, version=2, billing='team-1'),
            _row({'type': 'user', 'id': 'u-1'}, version=1, artifact_state='private', billing='team-home'),
            _row({'type': 'team', 'id': 'team-9'}, version=2),
        ]
    )

    rows = await publish_rows(account, 'org-1', 'docBrain', ['=user/u-1', '=team/team-1', PUBLIC_AUDIENCE])

    account.publish_of_app.assert_awaited_once_with('org-1', 'pipe', 'docBrain')
    assert [(r.slot, r.version, r.artifact_state, r.billing_team_id) for r in rows] == [
        ('=user/u-1', 1, 'private', 'team-home'),
        ('=team/team-1', 2, 'ready', 'team-1'),
        (PUBLIC_AUDIENCE, 3, 'ready', ''),
    ]
    assert all(r.kind == 'pipe' and r.org_id == 'org-1' and r.project_id == 'docBrain' for r in rows)


@pytest.mark.asyncio
async def test_a_slot_without_a_row_yields_nothing():
    """A team that holds no publication of the name is skipped, not an error."""
    account = AsyncMock()
    account.publish_of_app = AsyncMock(return_value=[_row({'type': 'team', 'id': 'team-1'})])

    rows = await publish_rows(account, 'org-1', 'docBrain', ['=team/team-2', PUBLIC_AUDIENCE])

    assert rows == []


# ==== The catalog row (plan 9, C.17b) ==========================================

LISTED_ENTRY = {
    'version': 3,
    'metadata': {
        'manifest': {
            'name': 'Doc Brain',
            'description': 'Reads',
            'defaultSource': 'webhook_1',
            'tagline': 'Reads documents',
            'categories': ['documents'],
            'tags': ['ocr'],
            'icon': 'icon.svg',
            'readme': 'docs/README.md',
            'links': {'homepage': 'https://example.com'},
            'mode': 'subscription',
            'billing': {'plans': [{'nickname': 'Pro'}]},
        }
    },
}


def test_a_listed_version_is_a_catalog_row_with_versioned_urls():
    """The app row's field names (pricing surfaces as ``mode`` alone, like an app row; the plans
    stay on the manifest for the approve path); icon and readme are the version's immutable URLs.
    """
    assert pipe_catalog_row('acme.docBrain', LISTED_ENTRY) == {
        'id': 'acme.docBrain',
        'name': 'Doc Brain',
        'publisher': 'acme',
        'description': 'Reads',
        'defaultSource': 'webhook_1',
        'tagline': 'Reads documents',
        'categories': ['documents'],
        'tags': ['ocr'],
        'links': {'homepage': 'https://example.com'},
        'mode': 'subscription',
        'version': 3,
        'icon': '/pipelines/acme.docBrain/v3/icon.svg',
        'readme': '/pipelines/acme.docBrain/v3/docs/README.md',
    }


def test_an_undeclared_icon_and_readme_are_omitted_from_the_row():
    manifest = {**LISTED_ENTRY['metadata']['manifest'], 'icon': '', 'readme': ''}
    row = pipe_catalog_row('acme.docBrain', {'version': 3, 'metadata': {'manifest': manifest}})
    assert 'icon' not in row and 'readme' not in row


def test_an_unlisted_version_has_no_catalog_row():
    """A dict deploy without a store block: the backends' synthesized name-only manifest lists nothing."""
    assert pipe_catalog_row('acme.docBrain', {'version': 3, 'metadata': {'manifest': {'name': 'Doc Brain'}}}) is None
    assert pipe_catalog_row('acme.docBrain', {'version': 3, 'metadata': {}}) is None
    assert pipe_catalog_row('acme.docBrain', {'version': 3}) is None


# ==== The serving resolver =====================================================


def _pin_row(version=3, artifact_state='ready', state='enabled'):
    return _row({'type': 'public', 'id': ''}, version=version, state=state, artifact_state=artifact_state)


@pytest.mark.asyncio
async def test_anonymous_resolution_is_the_publishers_public_row_alone(monkeypatch):
    """No caller: the publisher org is found through the developer id, and only a 'ready' public row serves."""
    monkeypatch.setattr(account_singleton, 'get_org_of_developer_id', AsyncMock(return_value='org-9'), raising=False)
    monkeypatch.setattr(account_singleton, 'publish_of_app', AsyncMock(return_value=[_pin_row()]), raising=False)

    pin = await resolve_pipe_version(None, 'acme.docBrain')

    assert (pin.rung, pin.version, pin.deployment.org_id) == ('public', 3, 'org-9')
    account_singleton.publish_of_app.assert_awaited_once_with('org-9', 'pipe', 'acme.docBrain')

    monkeypatch.setattr(
        account_singleton, 'publish_of_app', AsyncMock(return_value=[_pin_row(artifact_state='submit')])
    )
    assert await resolve_pipe_version(None, 'acme.docBrain') is None


@pytest.mark.asyncio
async def test_a_caller_gets_the_first_pin_and_a_bad_name_is_nothing(monkeypatch):
    """Authenticated: resolve_pins answers; a malformed name or a source address is a None, never an error."""
    first = SimpleNamespace(version=2)
    monkeypatch.setattr(pipe_deploy_mod, 'resolve_pins', AsyncMock(return_value=SimpleNamespace(first=first)))
    info = SimpleNamespace(userId='u1')

    assert await resolve_pipe_version(info, 'acme.docBrain') is first
    assert await resolve_pipe_version(info, 'acme.docBrain.chat') is None
    assert await resolve_pipe_version(info, 'not a name') is None
    assert await resolve_pipe_version(None, 'acme') is None


@pytest.mark.asyncio
async def test_a_rejected_caller_is_nothing_but_a_failing_store_raises(monkeypatch):
    """The caller's own faults (scope, team) answer None; a storage error is never a 'not found'."""
    info = SimpleNamespace(userId='u1')
    monkeypatch.setattr(pipe_deploy_mod, 'resolve_pins', AsyncMock(side_effect=PermissionError('scope')))
    assert await resolve_pipe_version(info, 'acme.docBrain') is None

    monkeypatch.setattr(pipe_deploy_mod, 'resolve_pins', AsyncMock(side_effect=RuntimeError('db down')))
    with pytest.raises(RuntimeError, match='db down'):
        await resolve_pipe_version(info, 'acme.docBrain')


# ==== The picker's walk (plan 3.6, C.16c) ======================================


def _caller(endpoints=None, teams=('team-a', 'team-b'), order=('team-b', 'team-a')):
    """A signed-in caller of org-1 (developer ``acme``) with a team order."""
    return SimpleNamespace(
        userId='u-1',
        endpoints=endpoints,
        teamOrder=list(order),
        organization={
            'id': 'org-1',
            'developerId': 'acme',
            'teams': [{'id': t, 'name': t.replace('team-', 'Team ').upper()} for t in teams],
        },
    )


def _pub(name, audience, *, org='org-1', version=1, state='enabled', artifact_state='private', snapshot=None):
    """One publish row as publish_list answers it."""
    return {
        'orgId': org,
        'projectId': name,
        'appId': name,
        'kind': 'pipe',
        'audience': audience,
        'version': version,
        'state': state,
        'artifactState': artifact_state,
        'snapshot': snapshot if snapshot is not None else {'name': name.split('.')[-1]},
    }


ME = {'type': 'user', 'id': 'u-1'}
TEAM_A = {'type': 'team', 'id': 'team-a'}
TEAM_B = {'type': 'team', 'id': 'team-b'}
PUBLIC = {'type': 'public', 'id': ''}


@pytest.mark.asyncio
async def test_own_publications_walk_me_then_teams_in_team_order_each_pipe_once():
    """@me first, then the team order (team-b before team-a); a pipe is listed at the rung that answers it."""
    account = AsyncMock()
    account.publish_list = AsyncMock(
        return_value=[
            _pub('acme.alpha', TEAM_A),
            _pub('acme.shared', TEAM_A, version=4),
            _pub('acme.shared', TEAM_B, version=2),
            _pub('acme.mine', ME, version=7),
            _pub('acme.shared', ME, version=9),
            _pub('acme.beta', TEAM_B),
        ]
    )

    entries = await pipe_deploy_mod.own_pipe_publications(account, _caller())

    # One read, own slots only: the store is never walked here
    account.publish_list.assert_awaited_once_with('org-1', 'pipe', [ME, TEAM_B, TEAM_A])
    assert [(e['pipe'], e['rung'], e['version']) for e in entries] == [
        ('acme.mine', 'me', 7),
        ('acme.shared', 'me', 9),
        ('acme.beta', 'team', 1),
        ('acme.alpha', 'team', 1),
    ]
    beta = entries[2]
    assert beta == {
        'kind': 'pipe',
        'id': 'acme.beta',
        'pipe': 'acme.beta',
        'name': 'beta',
        'publisher': 'acme',
        'description': '',
        'rung': 'team',
        'version': 1,
        'teamId': 'team-b',
        'teamName': 'TEAM B',
    }


@pytest.mark.asyncio
async def test_own_publications_skip_rows_that_do_not_serve_and_rows_of_other_orgs():
    """A disabled or failed row is not listed; a row of another org (global user keys) never is."""
    account = AsyncMock()
    account.publish_list = AsyncMock(
        return_value=[
            _pub('acme.off', TEAM_A, state='disabled'),
            _pub('acme.broken', TEAM_A, artifact_state='failed'),
            _pub('zeta.elsewhere', ME, org='org-9'),
            _pub('acme.ok', TEAM_A, artifact_state='submit'),
        ]
    )

    entries = await pipe_deploy_mod.own_pipe_publications(account, _caller())

    assert [e['pipe'] for e in entries] == ['acme.ok']


@pytest.mark.asyncio
async def test_a_scoped_key_lists_its_frozen_team_and_only_the_pipes_it_may_call():
    """A key with an endpoints scope probes its one team and drops the pipes outside the scope."""
    account = AsyncMock()
    account.publish_list = AsyncMock(
        return_value=[_pub('acme.allowed', TEAM_A), _pub('acme.other', TEAM_A), _pub('acme.mine', ME)]
    )
    caller = _caller(endpoints=['acme.allowed.*'], teams=('team-a',), order=('team-a',))

    entries = await pipe_deploy_mod.own_pipe_publications(account, caller)

    account.publish_list.assert_awaited_once_with('org-1', 'pipe', [ME, TEAM_A])
    assert [e['pipe'] for e in entries] == ['acme.allowed']


@pytest.mark.asyncio
async def test_own_publications_refuse_an_anonymous_caller_and_raise_a_failing_store():
    """No caller is a refusal; a store failure is the caller's error, never an empty list."""
    account = AsyncMock()
    with pytest.raises(PermissionError):
        await pipe_deploy_mod.own_pipe_publications(account, None)

    account.publish_list = AsyncMock(side_effect=RuntimeError('db down'))
    with pytest.raises(RuntimeError, match='db down'):
        await pipe_deploy_mod.own_pipe_publications(account, _caller())


@pytest.mark.asyncio
async def test_the_store_is_searched_never_listed():
    """A blank term is refused before any read: no request answers the whole public rung."""
    account = AsyncMock()
    account.publish_list = AsyncMock(return_value=[])
    for blank in ('', '   ', None):
        with pytest.raises(ValueError, match='searched, never listed'):
            await pipe_deploy_mod.search_public_pipes(account, _caller(), blank)
    account.publish_list.assert_not_awaited()
    with pytest.raises(PermissionError):
        await pipe_deploy_mod.search_public_pipes(account, None, 'docs')


@pytest.mark.asyncio
async def test_a_store_search_matches_serving_public_rows_by_name_description_or_id():
    """Case-insensitive substring over the registry name and the snapshot; only 'ready' public rows serve."""
    account = AsyncMock()
    account.publish_list = AsyncMock(
        return_value=[
            _pub('zeta.docBrain', PUBLIC, org='org-9', artifact_state='ready', snapshot={'name': 'Doc Brain'}),
            _pub(
                'omega.reader',
                PUBLIC,
                org='org-7',
                artifact_state='ready',
                snapshot={'name': 'Reader', 'description': 'Reads DOCS aloud'},
            ),
            _pub('beta.docsInReview', PUBLIC, artifact_state='submit', snapshot={'name': 'Docs in review'}),
            _pub('gamma.weather', PUBLIC, artifact_state='ready', snapshot={'name': 'Weather'}),
            _pub('delta.docsOff', PUBLIC, artifact_state='ready', state='disabled'),
        ]
    )

    entries = await pipe_deploy_mod.search_public_pipes(account, _caller(), '  Doc ')

    account.publish_list.assert_awaited_once_with('org-1', 'pipe', [PUBLIC])
    assert [(e['pipe'], e['rung'], e['name']) for e in entries] == [
        ('zeta.docBrain', 'public', 'Doc Brain'),
        ('omega.reader', 'public', 'Reader'),
    ]
    assert entries[1]['description'] == 'Reads DOCS aloud'
    assert 'teamId' not in entries[0]


@pytest.mark.asyncio
async def test_a_store_search_respects_a_keys_endpoints_scope():
    """A scoped key finds only the public pipes its scope names."""
    account = AsyncMock()
    account.publish_list = AsyncMock(
        return_value=[
            _pub('zeta.docA', PUBLIC, artifact_state='ready'),
            _pub('zeta.docB', PUBLIC, artifact_state='ready'),
        ]
    )

    entries = await pipe_deploy_mod.search_public_pipes(account, _caller(endpoints=['zeta.docB.chat']), 'doc')

    assert [e['pipe'] for e in entries] == ['zeta.docB']
