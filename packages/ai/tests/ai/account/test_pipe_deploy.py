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
ORG = {'type': 'org', 'id': 'org-1'}


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
    account.publish_list.assert_awaited_once_with('org-1', 'pipe', [ME, TEAM_B, TEAM_A, ORG])
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

    account.publish_list.assert_awaited_once_with('org-1', 'pipe', [ME, TEAM_A, ORG])
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


# ==== The Catalog and the desktop (plan 9.1, Step 6b.4) ========================


def _listed(version, name='Support Bot', **manifest):
    """A registry entry whose version was deployed with a store block (listed)."""
    return {
        'version': version,
        'metadata': {'manifest': {'name': name, 'mode': 'free', 'categories': ['support'], **manifest}},
    }


def _unlisted(version):
    """A registry entry deployed as a plain dict: the backends' name-only manifest."""
    return {'version': version, 'metadata': {'manifest': {'name': 'Plain'}}}


def test_the_host_app_is_one_named_constant():
    """Every agent tile opens rocketride.playground (G2): one constant, never chosen per pipe."""
    from ai.constants import CONST_PIPE_HOST_APP_ID

    assert CONST_PIPE_HOST_APP_ID == 'rocketride.playground'
    assert pipe_deploy_mod.CONST_PIPE_HOST_APP_ID is CONST_PIPE_HOST_APP_ID


def test_the_kind_lookup_a_pipe_row_is_a_pipe_an_app_row_an_app_an_unknown_name_an_app():
    """The desktop's kinds are the name rows' (G2): only a 'pipe' row makes an entry a pipe."""
    kinds = {'acme.supportBot': 'pipe', 'rocketride.playground': 'app', 'acme.someNode': 'node'}
    assert pipe_deploy_mod.desktop_kind(kinds, 'acme.supportBot') == 'pipe'
    assert pipe_deploy_mod.desktop_kind(kinds, 'rocketride.playground') == 'app'
    assert pipe_deploy_mod.desktop_kind(kinds, 'acme.unknown') == 'app'
    assert pipe_deploy_mod.desktop_kind(kinds, 'acme.someNode') == 'app'


def test_a_catalog_entry_is_the_catalog_row_with_its_launcher():
    """kind, address and host ride the row; the registry number is dropped (no semver, no MF remote)."""
    entry = pipe_deploy_mod.pipe_catalog_entry('acme.supportBot', _listed(4, icon='icon.svg'), 'me')

    assert entry == {
        'id': 'acme.supportBot',
        'name': 'Support Bot',
        'publisher': 'acme',
        'description': '',
        'defaultSource': '',
        'tagline': '',
        'categories': ['support'],
        'tags': [],
        'links': {},
        'mode': 'free',
        'icon': '/pipelines/acme.supportBot/v4/icon.svg',
        'kind': 'pipe',
        'pipe': 'acme.supportBot',
        'hostAppId': 'rocketride.playground',
        'moduleId': 'rocketride_playground',
        'rung': 'personal',
        'public': False,
        'appStatus': 'free',
        'onDesktop': False,
    }
    assert 'registryVersion' not in entry and 'version' not in entry
    public = pipe_deploy_mod.pipe_catalog_entry('acme.supportBot', _listed(4), 'public')
    assert (public['rung'], public['public']) == ('public', True)


def test_an_unlisted_or_missing_version_is_no_catalog_entry():
    assert pipe_deploy_mod.pipe_catalog_entry('acme.supportBot', _unlisted(4), 'team') is None
    assert pipe_deploy_mod.pipe_catalog_entry('acme.supportBot', None, 'team') is None


def _pin(org='org-1', name='acme.supportBot', version=4, rung='team'):
    """A serving pin as resolve_pins answers it."""
    return SimpleNamespace(
        rung=rung,
        version=version,
        deployment=SimpleNamespace(org_id=org, team_id='=team/team-b', project_id=name),
    )


@pytest.mark.asyncio
async def test_a_reachable_pipe_is_its_answering_versions_entry(monkeypatch):
    """The one resolver picks the rung and version; that version's listing is the entry."""
    resolve = AsyncMock(return_value=SimpleNamespace(first=_pin(org='org-9', version=6, rung='public')))
    monkeypatch.setattr(pipe_deploy_mod, 'resolve_pins', resolve)
    account = AsyncMock()
    account.deployments_versions = AsyncMock(return_value=[_listed(7), _listed(6, name='Six')])
    caller = _caller()

    entry = await pipe_deploy_mod.reachable_pipe_entry(account, caller, 'zeta.supportBot')

    resolve.assert_awaited_once_with('pipe', caller, 'zeta.supportBot')
    account.deployments_versions.assert_awaited_once_with('org-9', 'zeta.supportBot')
    assert (entry['id'], entry['name'], entry['rung'], entry['hostAppId']) == (
        'zeta.supportBot',
        'Six',
        'public',
        'rocketride.playground',
    )


@pytest.mark.asyncio
async def test_an_unreachable_pipe_is_nothing_and_a_failing_store_raises(monkeypatch):
    """No pin, an unlisted version, a source address, a scope refusal: None. A store failure raises."""
    account = AsyncMock()
    account.deployments_versions = AsyncMock(return_value=[_unlisted(4)])
    caller = _caller()

    monkeypatch.setattr(pipe_deploy_mod, 'resolve_pins', AsyncMock(return_value=SimpleNamespace(first=None)))
    assert await pipe_deploy_mod.reachable_pipe_entry(account, caller, 'acme.supportBot') is None

    monkeypatch.setattr(pipe_deploy_mod, 'resolve_pins', AsyncMock(return_value=SimpleNamespace(first=_pin())))
    assert await pipe_deploy_mod.reachable_pipe_entry(account, caller, 'acme.supportBot') is None

    for bad in ('acme.supportBot.chat', 'acme', 'not a name'):
        assert await pipe_deploy_mod.reachable_pipe_entry(account, caller, bad) is None

    monkeypatch.setattr(pipe_deploy_mod, 'resolve_pins', AsyncMock(side_effect=PermissionError('scope')))
    assert await pipe_deploy_mod.reachable_pipe_entry(account, caller, 'acme.supportBot') is None

    monkeypatch.setattr(pipe_deploy_mod, 'resolve_pins', AsyncMock(side_effect=RuntimeError('db down')))
    with pytest.raises(RuntimeError, match='db down'):
        await pipe_deploy_mod.reachable_pipe_entry(account, caller, 'acme.supportBot')


def _catalog_account(own_rows, public_rows, versions):
    """An account whose publish table answers the own slots and the store, and whose registry holds ``versions``."""
    account = AsyncMock()

    async def publish_list(org_id, kind, audiences):
        return list(public_rows) if audiences == [PUBLIC] else list(own_rows)

    async def deployments_versions(org_id, name):
        found = versions.get((org_id, name))
        if isinstance(found, Exception):
            raise found
        return list(found or [])

    account.publish_list = AsyncMock(side_effect=publish_list)
    account.deployments_versions = AsyncMock(side_effect=deployments_versions)
    return account


@pytest.mark.asyncio
async def test_the_catalog_lists_own_rungs_then_the_store_each_pipe_once_at_its_answering_rung():
    """@me, then @team in team order, then @public of every org; a pipe answered by a nearer rung is not listed again."""
    account = _catalog_account(
        own_rows=[_pub('acme.teamPipe', TEAM_A, version=2), _pub('acme.mine', ME, version=3)],
        public_rows=[
            _pub('acme.mine', PUBLIC, version=1, artifact_state='ready'),
            _pub('zeta.storePipe', PUBLIC, org='org-9', version=5, artifact_state='ready'),
            _pub('zeta.inReview', PUBLIC, org='org-9', version=1, artifact_state='submit'),
        ],
        versions={
            ('org-1', 'acme.mine'): [_listed(3, name='Mine'), _listed(1, name='Mine v1')],
            ('org-1', 'acme.teamPipe'): [_listed(2, name='Team pipe')],
            ('org-9', 'zeta.storePipe'): [_listed(5, name='Store pipe')],
            ('org-9', 'zeta.inReview'): [_listed(1, name='In review')],
        },
    )

    entries = await pipe_deploy_mod.catalog_pipe_entries(account, _caller())

    assert [(e['id'], e['name'], e['rung'], e['public']) for e in entries] == [
        ('acme.mine', 'Mine', 'personal', False),
        ('acme.teamPipe', 'Team pipe', 'team', False),
        ('zeta.storePipe', 'Store pipe', 'public', True),
    ]
    assert all(
        e['kind'] == 'pipe' and e['pipe'] == e['id'] and e['hostAppId'] == 'rocketride.playground' for e in entries
    )


@pytest.mark.asyncio
async def test_the_catalog_never_shows_an_unlisted_version_and_skips_an_unreadable_one():
    """A plain dict deploy is no listing; one registry read that fails drops that pipe alone."""
    account = _catalog_account(
        own_rows=[_pub('acme.plain', TEAM_A)],
        public_rows=[
            _pub('zeta.broken', PUBLIC, org='org-9', artifact_state='ready'),
            _pub('zeta.fine', PUBLIC, org='org-9', artifact_state='ready'),
        ],
        versions={
            ('org-1', 'acme.plain'): [_unlisted(1)],
            ('org-9', 'zeta.broken'): RuntimeError('registry down'),
            ('org-9', 'zeta.fine'): [_listed(1, name='Fine')],
        },
    )

    entries = await pipe_deploy_mod.catalog_pipe_entries(account, _caller())

    assert [e['id'] for e in entries] == ['zeta.fine']


@pytest.mark.asyncio
async def test_the_catalog_keeps_a_keys_scope_and_gives_a_stray_duplicate_to_the_lowest_org():
    """A scoped key lists only what it may call; two orgs' public rows of one name: the lowest org id answers."""
    account = _catalog_account(
        own_rows=[],
        public_rows=[
            _pub('zeta.dup', PUBLIC, org='org-9', version=2, artifact_state='ready'),
            _pub('zeta.dup', PUBLIC, org='org-3', version=1, artifact_state='ready'),
            _pub('zeta.hidden', PUBLIC, org='org-3', artifact_state='ready'),
        ],
        versions={
            ('org-3', 'zeta.dup'): [_listed(1, name='From org 3')],
            ('org-9', 'zeta.dup'): [_listed(2, name='From org 9')],
            ('org-3', 'zeta.hidden'): [_listed(1)],
        },
    )

    entries = await pipe_deploy_mod.catalog_pipe_entries(
        account, _caller(endpoints=['zeta.dup.*'], teams=('team-a',), order=('team-a',))
    )

    assert [(e['id'], e['name']) for e in entries] == [('zeta.dup', 'From org 3')]


@pytest.mark.asyncio
async def test_the_catalog_refuses_an_anonymous_caller_and_raises_a_failing_publish_table():
    with pytest.raises(PermissionError):
        await pipe_deploy_mod.catalog_pipe_entries(AsyncMock(), None)
    account = AsyncMock()
    account.publish_list = AsyncMock(side_effect=RuntimeError('db down'))
    with pytest.raises(RuntimeError, match='db down'):
        await pipe_deploy_mod.catalog_pipe_entries(account, _caller())


@pytest.mark.asyncio
async def test_desktop_tiles_are_the_pipe_names_the_caller_still_reaches(monkeypatch):
    """One kind lookup; app names and unknown names are skipped, an unreachable pipe has no tile, order is kept."""
    account = AsyncMock()
    account.deployments_kinds = AsyncMock(
        return_value={
            'acme.b': 'pipe',
            'rocketride.playground': 'app',
            'acme.a': 'pipe',
            'acme.gone': 'pipe',
            'acme.broken': 'pipe',
        }
    )

    async def reachable(acct, info, name):
        if name == 'acme.gone':
            return None
        if name == 'acme.broken':
            raise RuntimeError('db down')
        return {'id': name, 'kind': 'pipe', 'onDesktop': False}

    monkeypatch.setattr(pipe_deploy_mod, 'reachable_pipe_entry', reachable)

    tiles = await pipe_deploy_mod.desktop_pipe_tiles(
        account,
        _caller(),
        ['acme.b', 'rocketride.playground', 'acme.unknown', 'acme.gone', 'acme.broken', 'acme.a', 'acme.b'],
    )

    account.deployments_kinds.assert_awaited_once_with(
        'org-1', ['acme.b', 'rocketride.playground', 'acme.unknown', 'acme.gone', 'acme.broken', 'acme.a']
    )
    assert tiles == [
        {'id': 'acme.b', 'kind': 'pipe', 'onDesktop': True},
        {'id': 'acme.a', 'kind': 'pipe', 'onDesktop': True},
    ]


@pytest.mark.asyncio
async def test_an_empty_desktop_or_a_caller_without_an_org_has_no_tiles_and_no_lookup():
    account = AsyncMock()
    assert await pipe_deploy_mod.desktop_pipe_tiles(account, _caller(), []) == []
    no_org = SimpleNamespace(userId='u-1', endpoints=None, teamOrder=[], organization=None)
    assert await pipe_deploy_mod.desktop_pipe_tiles(account, no_org, ['acme.a']) == []
    account.deployments_kinds.assert_not_awaited()
