"""
The OSS per-user desktop list (plan 9.1, B41): ``ai/account/desktop.py``
and the account-layer behaviour built on it.

- ``FileDesktopBackend`` — one JSON document per user in the raw store:
  round trip, missing/corrupt reads as "never written", id validation.
- ``AccountBase.desktop_app_ids`` / ``decorate_desktop`` — the first read
  seeds the inventory; later reads keep what the user chose.
- ``handle_app`` desktop writes — change the list, push the account.
- ``handle_public`` — the public catalog carries the same decoration and is
  answered by name (``catalog_order``), sorted before the page is cut.
- The OSS login assembly and the OSS account push decorate with the real
  membership (no forced ``onDesktop: True`` anywhere).
- Concurrency: the per-user lock keeps two adds from losing one another.
- Seeding: the public catalog seeds from the whole reachable inventory; a
  failed registry resolution never writes a desktop.
- Agents (Step 6b.4): the catalog lists the reachable pipes beside the apps;
  the desktop verbs take a pipe's address, the add gated by the name's kind;
  sign-in and the push deliver the desktop's agent tiles.
"""

from __future__ import annotations

import asyncio
from typing import Any, Dict, List
from unittest.mock import AsyncMock, MagicMock

import pytest

from ai.account import manifest_push
from ai.account.base import AccountBase, InventoryUnavailableError
from ai.account.deployment_backend import FileDeploymentBackend
from ai.account.desktop import DESKTOP_FORMAT_VERSION, FileDesktopBackend
from ai.account.store_providers.memory import MemoryStore


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


class _Account(AccountBase):
    """AccountBase made instantiable, with a MemoryStore-backed desktop, a
    fixed reachable inventory (two apps) and fixed name rows for the kind
    lookup (none unless given).
    """

    def __init__(
        self,
        inventory: List[Dict[str, Any]] | None = None,
        kinds: Dict[str, str] | None = None,
        agents: List[Dict[str, Any]] | None = None,
    ):
        self._desktop_backend_instance = FileDesktopBackend(MemoryStore())
        # The catalog's agents (the pipe walk has its own suite): none unless given
        self._agents = [dict(a) for a in (agents or [])]
        self._inventory = (
            inventory
            if inventory is not None
            else [
                {'id': 'rocketride.playground', 'name': 'Playground', 'shells': None},
                {'id': 'rocketride.sql', 'name': 'SQL', 'shells': ['oss']},
            ]
        )
        self._kinds = dict(kinds or {})

    async def authenticate(self, credential: str):
        return None

    async def deployments_kinds(self, org_id, project_ids):
        return {p: self._kinds[p] for p in project_ids if p in self._kinds}

    async def catalog_pipes(self, account_info):
        return [dict(a) for a in self._agents]

    async def get_apps_for_user(self, user_id, organizations):
        return [dict(a) for a in self._inventory]

    async def get_public_apps(self):
        return [dict(a) for a in self._inventory]


def _conn(authenticated: bool = True):
    """A conn stub: build_response/build_error capture their body/message."""
    conn = MagicMock()
    conn.build_response.side_effect = lambda _req, body=None: {'success': True, 'body': body}
    conn.build_error.side_effect = lambda _req, msg='': {'success': False, 'message': msg}
    conn._account_info = MagicMock(userId='local', organization={'id': 'local'}) if authenticated else None
    return conn


def _req(sub: str, **extra):
    """An rrext_app request dict for one subcommand."""
    return {'command': 'rrext_app', 'arguments': {'subcommand': sub, **extra}}


@pytest.fixture
def pushes(monkeypatch):
    """Record every account push the desktop writes make."""
    seen: List[str] = []

    async def push_account(server, user_id):
        seen.append(user_id)

    monkeypatch.setattr(manifest_push, 'push_account', push_account)
    return seen


# ---------------------------------------------------------------------------
# FileDesktopBackend
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_backend_round_trip_keeps_order_and_folds_duplicates():
    backend = FileDesktopBackend(MemoryStore())
    await backend.write('local', 'local', ['b', 'a', 'b'])
    assert await backend.read('local', 'local') == ['b', 'a']


@pytest.mark.asyncio
async def test_backend_missing_document_reads_as_never_written():
    backend = FileDesktopBackend(MemoryStore())
    assert await backend.read('local', 'local') is None


@pytest.mark.asyncio
async def test_backend_document_path_and_shape():
    store = MemoryStore()
    backend = FileDesktopBackend(store)
    await backend.write('local', 'local', ['rocketride.playground'])
    assert FileDesktopBackend.path('local', 'local') == 'orgs/local/files/.desktop/local.json'
    import json

    assert json.loads(await store.read_file('orgs/local/files/.desktop/local.json')) == {
        'version': DESKTOP_FORMAT_VERSION,
        'apps': ['rocketride.playground'],
    }


@pytest.mark.asyncio
async def test_backend_corrupt_or_newer_document_reads_as_never_written():
    store = MemoryStore()
    backend = FileDesktopBackend(store)
    await store.write_file(FileDesktopBackend.path('local', 'local'), 'not json')
    assert await backend.read('local', 'local') is None
    await store.write_file(FileDesktopBackend.path('local', 'local'), '{"version": 99, "apps": []}')
    assert await backend.read('local', 'local') is None
    await store.write_file(FileDesktopBackend.path('local', 'local'), '{"version": 1, "apps": [1]}')
    assert await backend.read('local', 'local') is None


@pytest.mark.parametrize('bad', ['', '..', '../x', 'a/b', '.hidden', 'a\\b', 'x' * 129])
def test_backend_refuses_unsafe_ids(bad):
    with pytest.raises(ValueError, match='Invalid (org|user) id'):
        FileDesktopBackend.path(bad, 'local')
    with pytest.raises(ValueError, match='Invalid (org|user) id'):
        FileDesktopBackend.path('local', bad)


# ---------------------------------------------------------------------------
# Seeding and decoration
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_first_read_seeds_the_inventory_and_later_reads_keep_the_choice():
    acct = _Account()
    assert await acct.desktop_app_ids('local', 'local', ['a', 'b']) == ['a', 'b']
    # The seed is stored: a different inventory on the next read changes nothing.
    assert await acct.desktop_app_ids('local', 'local', ['a', 'b', 'c']) == ['a', 'b']
    await acct._desktop_backend().write('local', 'local', ['b'])
    assert await acct.desktop_app_ids('local', 'local', ['a', 'b', 'c']) == ['b']


@pytest.mark.asyncio
async def test_decorate_desktop_stamps_free_and_the_real_membership():
    acct = _Account()
    await acct._desktop_backend().write('local', 'local', ['rocketride.sql'])
    apps = [{'id': 'rocketride.playground'}, {'id': 'rocketride.sql'}]
    assert await acct.decorate_desktop('local', 'local', apps) is apps
    assert [(a['appStatus'], a['onDesktop']) for a in apps] == [('free', False), ('free', True)]


# ---------------------------------------------------------------------------
# handle_app: list/get and the desktop writes
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_handle_app_list_first_sign_in_shows_the_whole_inventory():
    """An existing user's first sign-in after the upgrade sees the same
    desktop as before: everything reachable is seeded onto it.
    """
    acct = _Account()
    result = await acct.handle_app(_conn(), _req('list'))
    assert [(a['id'], a['appStatus'], a['onDesktop']) for a in result['body']['apps']] == [
        ('rocketride.playground', 'free', True),
        ('rocketride.sql', 'free', True),
    ]


@pytest.mark.asyncio
async def test_handle_app_desktop_remove_then_add_round_trips_and_pushes(pushes):
    acct = _Account()
    removed = await acct.handle_app(_conn(), _req('desktop_remove', appId='rocketride.sql'))
    assert removed['body'] == {'removed': True, 'appId': 'rocketride.sql'}
    assert await acct._desktop_backend().read('local', 'local') == ['rocketride.playground']
    listed = await acct.handle_app(_conn(), _req('list'))
    assert {a['id']: a['onDesktop'] for a in listed['body']['apps']} == {
        'rocketride.playground': True,
        'rocketride.sql': False,
    }
    got = await acct.handle_app(_conn(), _req('get', appId='rocketride.sql'))
    assert got['body']['app']['onDesktop'] is False and got['body']['prices'] == []

    added = await acct.handle_app(_conn(), _req('desktop_add', appId='rocketride.sql'))
    assert added['body'] == {'added': True, 'appId': 'rocketride.sql'}
    assert await acct._desktop_backend().read('local', 'local') == ['rocketride.playground', 'rocketride.sql']
    # Every write pushed the refreshed identity to the user's connections.
    assert pushes == ['local', 'local']


@pytest.mark.asyncio
async def test_handle_app_desktop_add_is_idempotent(pushes):
    acct = _Account()
    await acct.handle_app(_conn(), _req('desktop_add', appId='rocketride.playground'))
    await acct.handle_app(_conn(), _req('desktop_add', appId='rocketride.playground'))
    assert await acct._desktop_backend().read('local', 'local') == ['rocketride.playground', 'rocketride.sql']
    assert pushes == ['local', 'local']


@pytest.mark.asyncio
async def test_handle_app_desktop_add_refuses_an_unreachable_app(pushes):
    acct = _Account()
    result = await acct.handle_app(_conn(), _req('desktop_add', appId='someone.else'))
    assert result == {'success': False, 'message': 'App not found'}
    assert pushes == []


@pytest.mark.asyncio
async def test_handle_app_desktop_writes_need_an_app_id_and_a_session(pushes):
    acct = _Account()
    assert (await acct.handle_app(_conn(), _req('desktop_add')))['message'] == 'appId is required'
    assert (await acct.handle_app(_conn(authenticated=False), _req('desktop_remove', appId='x')))['message'] == (
        'Authentication required'
    )
    assert pushes == []


@pytest.mark.asyncio
async def test_handle_app_list_anonymous_has_nothing_on_a_desktop():
    acct = _Account()
    result = await acct.handle_app(_conn(authenticated=False), _req('list'))
    assert [(a['appStatus'], a['onDesktop']) for a in result['body']['apps']] == [('auth', False), ('auth', False)]


@pytest.mark.asyncio
async def test_handle_app_list_narrows_by_shell_after_decoration():
    acct = _Account()
    result = await acct.handle_app(_conn(), _req('list', shell='saas'))
    assert [a['id'] for a in result['body']['apps']] == ['rocketride.playground']


# ---------------------------------------------------------------------------
# handle_public: the catalog carries the same decoration
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_handle_public_decorates_for_the_signed_in_caller():
    acct = _Account()
    await acct._desktop_backend().write('local', 'local', ['rocketride.playground'])
    req = {'command': 'rrext_public_catalog', 'arguments': {'shell': 'oss'}}
    result = await acct.handle_public(_conn(), req)
    assert result['body']['total'] == 2
    assert {a['id']: (a['appStatus'], a['onDesktop']) for a in result['body']['apps']} == {
        'rocketride.playground': ('free', True),
        'rocketride.sql': ('free', False),
    }


@pytest.mark.asyncio
async def test_handle_public_anonymous_asks_for_a_sign_in():
    acct = _Account()
    result = await acct.handle_public(_conn(authenticated=False), {'command': 'rrext_public_catalog'})
    assert {(a['appStatus'], a['onDesktop']) for a in result['body']['apps']} == {('auth', False)}


# ---------------------------------------------------------------------------
# The OSS login assembly and the OSS account push
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_oss_login_assembly_uses_the_stored_desktop(monkeypatch):
    from ai.account import app_deploy
    from ai.account.oss import Account

    async def pins(org_id, team_id, teams, strict=False):
        return [{'id': 'rocketride.playground'}, {'id': 'rocketride.sql'}, {'name': 'malformed, no id'}]

    monkeypatch.setattr(app_deploy, 'resolve_app_pins', pins)
    acct = Account.__new__(Account)
    acct._desktop_backend_instance = FileDesktopBackend(MemoryStore())
    await acct._desktop_backend().write('local', 'local', ['rocketride.sql'])
    apps = await acct._assemble_apps()
    assert [(a['id'], a['appStatus'], a['onDesktop']) for a in apps] == [
        ('rocketride.playground', 'free', False),
        ('rocketride.sql', 'free', True),
    ]


@pytest.mark.asyncio
async def test_oss_login_assembly_survives_a_broken_desktop_store(monkeypatch):
    from ai.account import app_deploy
    from ai.account.oss import Account

    async def pins(org_id, team_id, teams, strict=False):
        return [{'id': 'rocketride.playground'}]

    class _Broken:
        async def read(self, org_id, user_id):
            raise RuntimeError('store down')

    monkeypatch.setattr(app_deploy, 'resolve_app_pins', pins)
    acct = Account.__new__(Account)
    acct._desktop_backend_instance = _Broken()
    apps = await acct._assemble_apps()
    assert apps == [{'id': 'rocketride.playground', 'appStatus': 'free', 'onDesktop': False}]


@pytest.mark.asyncio
async def test_oss_account_push_carries_the_decorated_list(monkeypatch):
    """The OSS push rebuilds the list through the account layer and sends it
    as decorated — it no longer forces every app onto the desktop.
    """

    class _Acct:
        _service = None

        async def get_apps_for_user(self, user_id, orgs):
            return [
                {'id': 'rocketride.playground', 'appStatus': 'free', 'onDesktop': False},
                {'id': 'rocketride.sql', 'appStatus': 'free', 'onDesktop': True},
                {'name': 'no id'},
            ]

        async def desktop_pipe_tiles(self, info):
            return [{'id': 'rocketride.supportBot', 'kind': 'pipe', 'appStatus': 'free', 'onDesktop': True}]

    # ``push_account`` reads the live account object off the package.
    monkeypatch.setattr('ai.account.account', _Acct())

    sent: List[Dict[str, Any]] = []

    class _Info:
        userId = 'local'
        apps: List[Dict[str, Any]] = []

        def to_push_result(self):
            return {'apps': list(self.apps)}

    class _Conn:
        _account_info = _Info()

        async def send_event(self, name, body=None):
            sent.append({'name': name, 'body': body})

    server = MagicMock()
    server._connections = {1: _Conn()}
    await manifest_push.push_account(server, 'local')
    assert [e['name'] for e in sent] == ['apaext_account']
    assert sent[0]['body']['apps'] == [
        {'id': 'rocketride.playground', 'appStatus': 'free', 'onDesktop': False},
        {'id': 'rocketride.sql', 'appStatus': 'free', 'onDesktop': True},
        # The desktop's agents follow the apps, as authenticate() appends them
        {'id': 'rocketride.supportBot', 'kind': 'pipe', 'appStatus': 'free', 'onDesktop': True},
    ]


# ---------------------------------------------------------------------------
# PR #3385 review threads: the lock, the seed source, the failed resolution
# ---------------------------------------------------------------------------


class _YieldingStore(MemoryStore):
    """A MemoryStore that yields to the loop around every read and write, so
    an unlocked read-modify-write interleaves the way a real backend does.
    """

    async def read_file(self, filename):
        await asyncio.sleep(0)
        return await super().read_file(filename)

    async def write_file(self, filename, data):
        await asyncio.sleep(0)
        await super().write_file(filename, data)


@pytest.mark.asyncio
async def test_two_concurrent_adds_of_different_apps_both_land(pushes):
    acct = _Account(inventory=[{'id': 'rocketride.playground'}, {'id': 'rocketride.sql'}, {'id': 'rocketride.monitor'}])
    acct._desktop_backend_instance = FileDesktopBackend(_YieldingStore())
    await acct._desktop_backend().write('local', 'local', ['rocketride.playground'])
    results = await asyncio.gather(
        acct.handle_app(_conn(), _req('desktop_add', appId='rocketride.sql')),
        acct.handle_app(_conn(), _req('desktop_add', appId='rocketride.monitor')),
    )
    assert all(r['success'] for r in results)
    assert set(await acct._desktop_backend().read('local', 'local')) == {
        'rocketride.playground',
        'rocketride.sql',
        'rocketride.monitor',
    }
    assert pushes == ['local', 'local']


@pytest.mark.asyncio
async def test_concurrent_first_reads_seed_once():
    acct = _Account()
    acct._desktop_backend_instance = FileDesktopBackend(_YieldingStore())
    seeded = await asyncio.gather(
        acct.desktop_app_ids('local', 'local', ['a', 'b']),
        acct.desktop_app_ids('local', 'local', ['c']),
    )
    # Whichever ran first seeded; the other read that seed, never its own.
    assert seeded[0] == seeded[1]
    assert await acct._desktop_backend().read('local', 'local') == seeded[0]


@pytest.mark.asyncio
async def test_desktop_mutate_is_atomic_and_writes_only_on_change():
    acct = _Account()
    acct._desktop_backend_instance = FileDesktopBackend(_YieldingStore())
    await asyncio.gather(
        acct.desktop_mutate('local', 'local', ['a'], lambda ids: [*ids, 'b']),
        acct.desktop_mutate('local', 'local', ['a'], lambda ids: [*ids, 'c']),
    )
    assert set(await acct._desktop_backend().read('local', 'local')) == {'a', 'b', 'c'}
    assert await acct.desktop_mutate('local', 'local', [], lambda ids: ids) == await acct._desktop_backend().read(
        'local', 'local'
    )


@pytest.mark.asyncio
async def test_handle_public_first_read_seeds_from_the_whole_reachable_inventory():
    """The public catalog is a subset of what the caller reaches: a first
    desktop seeded from it would leave the team-only app off.
    """

    class _TeamAccount(_Account):
        async def get_public_apps(self):
            return [{'id': 'rocketride.playground'}]

    acct = _TeamAccount(inventory=[{'id': 'rocketride.playground'}, {'id': 'team.only'}])
    result = await acct.handle_public(_conn(), {'command': 'rrext_public_catalog'})
    assert [(a['id'], a['onDesktop']) for a in result['body']['apps']] == [('rocketride.playground', True)]
    assert await acct._desktop_backend().read('local', 'local') == ['rocketride.playground', 'team.only']


@pytest.mark.asyncio
async def test_handle_public_never_changes_an_existing_list_even_an_empty_one():
    acct = _Account()
    await acct._desktop_backend().write('local', 'local', [])
    result = await acct.handle_public(_conn(), {'command': 'rrext_public_catalog'})
    assert all(a['onDesktop'] is False for a in result['body']['apps'])
    assert await acct._desktop_backend().read('local', 'local') == []


@pytest.mark.asyncio
async def test_oss_login_assembly_failed_resolution_writes_no_desktop_then_seeds(monkeypatch):
    from ai.account import app_deploy
    from ai.account.oss import Account

    state = {'fail': True}

    async def pins(org_id, team_id, teams, strict=False):
        if state['fail']:
            raise RuntimeError('registry down')
        return [{'id': 'rocketride.playground'}, {'id': 'rocketride.sql'}]

    monkeypatch.setattr(app_deploy, 'resolve_app_pins', pins)
    acct = Account.__new__(Account)
    acct._desktop_backend_instance = FileDesktopBackend(MemoryStore())
    with pytest.raises(InventoryUnavailableError):
        await acct._assemble_apps()
    assert await acct._desktop_backend().read('local', 'local') is None
    state['fail'] = False
    apps = await acct._assemble_apps()
    assert [(a['id'], a['onDesktop']) for a in apps] == [('rocketride.playground', True), ('rocketride.sql', True)]
    assert await acct._desktop_backend().read('local', 'local') == ['rocketride.playground', 'rocketride.sql']


@pytest.mark.asyncio
async def test_oss_login_assembly_empty_inventory_still_seeds(monkeypatch):
    from ai.account import app_deploy
    from ai.account.oss import Account

    async def pins(org_id, team_id, teams, strict=False):
        return []

    monkeypatch.setattr(app_deploy, 'resolve_app_pins', pins)
    acct = Account.__new__(Account)
    acct._desktop_backend_instance = FileDesktopBackend(MemoryStore())
    assert await acct._assemble_apps() == []
    assert await acct._desktop_backend().read('local', 'local') == []


# ---------------------------------------------------------------------------
# PR #3385 round 2: the REAL OSS account path (the _Account double bypasses
# decoration): no deadlock on the writes, no seed from a failed inventory
# ---------------------------------------------------------------------------


def _oss_account(monkeypatch, state: Dict[str, Any]):
    """The real OSS ``Account`` over a MemoryStore desktop, with the registry
    walk replaced by ``state``: ``fail`` raises, else ``pins`` resolve.
    """
    from ai.account import app_deploy
    from ai.account.oss import Account

    async def pins(org_id, team_id, teams, strict=False):
        if state.get('fail'):
            raise RuntimeError('registry down')
        return [dict(p) for p in state['pins']]

    monkeypatch.setattr(app_deploy, 'resolve_app_pins', pins)
    acct = Account.__new__(Account)
    acct._desktop_backend_instance = FileDesktopBackend(MemoryStore())
    # The registry the kind lookup reads: empty, in memory
    acct._deployments_backend = FileDeploymentBackend(MemoryStore())
    return acct


@pytest.mark.asyncio
async def test_oss_desktop_writes_do_not_deadlock_on_the_inventory_walk(monkeypatch, pushes):
    """desktop_add/remove gate on get_apps_for_user, which on OSS decorates
    through desktop_app_ids and takes the per-user lock itself: the walk
    must run outside the write's lock or both verbs hang.
    """
    acct = _oss_account(monkeypatch, {'pins': [{'id': 'rocketride.playground'}, {'id': 'rocketride.sql'}]})
    added = await asyncio.wait_for(acct.handle_app(_conn(), _req('desktop_add', appId='rocketride.sql')), timeout=2)
    assert added['body'] == {'added': True, 'appId': 'rocketride.sql'}
    removed = await asyncio.wait_for(
        acct.handle_app(_conn(), _req('desktop_remove', appId='rocketride.playground')), timeout=2
    )
    assert removed['body'] == {'removed': True, 'appId': 'rocketride.playground'}
    assert await acct._desktop_backend().read('local', 'local') == ['rocketride.sql']
    assert pushes == ['local', 'local']


@pytest.mark.asyncio
async def test_oss_list_get_public_on_a_failed_inventory_write_nothing_then_seed(monkeypatch, pushes):
    state: Dict[str, Any] = {'fail': True, 'pins': [{'id': 'rocketride.playground'}, {'id': 'rocketride.sql'}]}
    acct = _oss_account(monkeypatch, state)

    async def public_apps():
        return [{'id': 'rocketride.playground'}]

    acct.get_public_apps = public_apps  # type: ignore[method-assign]

    listed = await acct.handle_app(_conn(), _req('list'))
    assert listed == {'success': True, 'body': {'apps': []}}
    got = await acct.handle_app(_conn(), _req('get', appId='rocketride.playground'))
    assert got == {'success': False, 'message': 'App not found'}
    public = await acct.handle_public(_conn(), {'command': 'rrext_public_catalog'})
    assert [(a['id'], a['appStatus'], a['onDesktop']) for a in public['body']['apps']] == [
        ('rocketride.playground', 'free', False)
    ]
    write = await acct.handle_app(_conn(), _req('desktop_add', appId='rocketride.sql'))
    assert write == {'success': False, 'message': 'The app catalog is unavailable; try again.'}
    # authenticate() checks RR_APIKEY, and refuses a server holding only the
    # client's ROCKETRIDE_APIKEY: a developer with either set would get the 401
    # tuple here instead of the identity.
    monkeypatch.delenv('RR_APIKEY', raising=False)
    monkeypatch.delenv('ROCKETRIDE_APIKEY', raising=False)
    signed_in = await acct.authenticate('')
    assert signed_in.apps == []
    # Nothing was written by any door while the registry was down.
    assert await acct._desktop_backend().read('local', 'local') is None
    assert pushes == []

    # The registry recovers: the next read seeds the whole inventory.
    state['fail'] = False
    listed = await acct.handle_app(_conn(), _req('list'))
    assert [(a['id'], a['onDesktop']) for a in listed['body']['apps']] == [
        ('rocketride.playground', True),
        ('rocketride.sql', True),
    ]
    assert await acct._desktop_backend().read('local', 'local') == ['rocketride.playground', 'rocketride.sql']


@pytest.mark.asyncio
async def test_oss_public_catalog_on_a_failed_inventory_still_reads_the_stored_desktop(monkeypatch):
    acct = _oss_account(monkeypatch, {'fail': True, 'pins': []})
    await acct._desktop_backend().write('local', 'local', ['rocketride.playground'])

    async def public_apps():
        return [{'id': 'rocketride.playground'}, {'id': 'rocketride.sql'}]

    acct.get_public_apps = public_apps  # type: ignore[method-assign]
    public = await acct.handle_public(_conn(), {'command': 'rrext_public_catalog'})
    assert {a['id']: a['onDesktop'] for a in public['body']['apps']} == {
        'rocketride.playground': True,
        'rocketride.sql': False,
    }
    assert await acct._desktop_backend().read('local', 'local') == ['rocketride.playground']


# ---------------------------------------------------------------------------
# PR #3385 round 3: the failure signal comes from the RESOLVER (publish_list
# fails, resolve_app_pins is the real one), never seeds, and the next success
# seeds
# ---------------------------------------------------------------------------


def _publish_row(app_id: str, version: int) -> Dict[str, Any]:
    """One enabled public binding whose deployment serves (built, ready)."""
    return {
        'appId': app_id,
        'version': version,
        'orgId': 'local',
        'state': 'enabled',
        'audience': {'type': 'public', 'id': ''},
        'artifactState': 'ready',
        'artifactBuild': 'ok',
        'snapshot': {'name': app_id, 'mode': 'free'},
    }


@pytest.mark.asyncio
async def test_oss_publish_list_failure_reaches_the_assembly_and_never_seeds(monkeypatch):
    """The resolver used to swallow a publish_list failure into [] — the
    assembly then seeded an EMPTY desktop and recovery could never seed.
    The real resolve_app_pins runs here; only the registry verbs are faked.
    """
    from ai.account import account as live_account
    from ai.account.oss import Account

    state: Dict[str, Any] = {'fail': True}

    async def publish_list(org_id, kind, audiences):
        if state['fail']:
            raise RuntimeError('registry down')
        return [_publish_row('rocketride.playground', 1), _publish_row('rocketride.sql', 1)]

    async def deployments_artifact(org_id, app_id, version):
        return {'kind': 'app', 'name': app_id, 'appVersion': '1.0.0'}

    monkeypatch.setattr(live_account, 'publish_list', publish_list, raising=False)
    monkeypatch.setattr(live_account, 'deployments_artifact', deployments_artifact, raising=False)
    monkeypatch.setattr(live_account, 'review_ladder', False, raising=False)

    acct = Account.__new__(Account)
    acct._desktop_backend_instance = FileDesktopBackend(MemoryStore())

    with pytest.raises(InventoryUnavailableError):
        await acct._assemble_apps()
    listed = await acct.handle_app(_conn(), _req('list'))
    assert listed == {'success': True, 'body': {'apps': []}}
    assert await acct._desktop_backend().read('local', 'local') is None

    # The registry recovers: the next assembly seeds the whole inventory.
    state['fail'] = False
    listed = await acct.handle_app(_conn(), _req('list'))
    assert [(a['id'], a['onDesktop']) for a in listed['body']['apps']] == [
        ('rocketride.playground', True),
        ('rocketride.sql', True),
    ]
    assert await acct._desktop_backend().read('local', 'local') == ['rocketride.playground', 'rocketride.sql']


@pytest.mark.asyncio
async def test_resolver_default_still_degrades_to_an_empty_list(monkeypatch):
    """Every other caller (SaaS login/catalog, the OSS public walk, the
    probe) keeps the resolver's previous behaviour: [] on failure.
    """
    from ai.account import account as live_account
    from ai.account.app_deploy import resolve_app_pins

    async def publish_list(org_id, kind, audiences):
        raise RuntimeError('registry down')

    monkeypatch.setattr(live_account, 'publish_list', publish_list, raising=False)
    assert await resolve_app_pins('local', 'local', ['local']) == []
    with pytest.raises(InventoryUnavailableError, match='registry down'):
        await resolve_app_pins('local', 'local', ['local'], strict=True)


@pytest.mark.asyncio
async def test_resolver_empty_publish_list_is_an_empty_inventory_even_when_strict(monkeypatch):
    from ai.account import account as live_account
    from ai.account.app_deploy import resolve_app_pins

    async def publish_list(org_id, kind, audiences):
        return []

    monkeypatch.setattr(live_account, 'publish_list', publish_list, raising=False)
    assert await resolve_app_pins('local', 'local', ['local'], strict=True) == []


# ---------------------------------------------------------------------------
# Step 6b.4: agents (published pipes) in the Catalog and on the desktop. The
# address rides the one desktop list; the kind is the name row's (G2)
# ---------------------------------------------------------------------------

BOT = 'rocketride.supportBot'

#: One agent as the pipe walk lists it (pipe_deploy.pipe_catalog_entry's shape).
AGENT = {
    'kind': 'pipe',
    'id': BOT,
    'pipe': BOT,
    'hostAppId': 'rocketride.playground',
    'moduleId': 'rocketride_playground',
    'name': 'Support Bot',
    'mode': 'free',
    'appStatus': 'free',
    'onDesktop': False,
}


def _agent_account(**kwargs) -> _Account:
    """The two-app account whose registry also holds one listed pipe, BOT."""
    return _Account(kinds={BOT: 'pipe', 'rocketride.playground': 'app'}, agents=[AGENT], **kwargs)


@pytest.mark.asyncio
async def test_the_catalog_lists_the_agents_beside_the_apps_decorated_alike():
    acct = _agent_account()
    await acct._desktop_backend().write('local', 'local', ['rocketride.playground', BOT])
    result = await acct.handle_public(_conn(), {'command': 'rrext_public_catalog', 'arguments': {'shell': 'oss'}})
    assert result['body']['total'] == 3
    by_id = {a['id']: a for a in result['body']['apps']}
    # The shell filter keeps an agent (it names no shells); membership is the stored list's
    assert (by_id[BOT]['kind'], by_id[BOT]['hostAppId'], by_id[BOT]['appStatus'], by_id[BOT]['onDesktop']) == (
        'pipe',
        'rocketride.playground',
        'free',
        True,
    )
    assert by_id['rocketride.sql']['onDesktop'] is False


@pytest.mark.asyncio
async def test_an_anonymous_catalog_lists_no_agents():
    acct = _agent_account()
    result = await acct.handle_public(_conn(authenticated=False), {'command': 'rrext_public_catalog'})
    assert [a['id'] for a in result['body']['apps']] == ['rocketride.playground', 'rocketride.sql']


def test_catalog_order_is_by_name_then_id_and_leaves_its_input_alone():
    entries = [
        {'id': 'b.same', 'name': 'Same'},
        {'id': 'zeta.noName'},
        {'id': 'a.same', 'name': 'same'},
        {'id': 'acme.alpha', 'name': 'Alpha'},
    ]
    before = list(entries)
    # Case does not order; a nameless entry sorts by its id; one name is ordered by id
    assert [e['id'] for e in AccountBase.catalog_order(entries)] == ['acme.alpha', 'a.same', 'b.same', 'zeta.noName']
    assert entries == before


@pytest.mark.asyncio
async def test_the_catalog_is_answered_by_name_and_a_page_is_a_slice_of_the_sorted_list():
    """Apps and agents sort as one list; the inventory's own order does not show."""
    acct = _Account(
        inventory=[
            {'id': 'rocketride.sql', 'name': 'SQL Explorer', 'shells': None},
            {'id': 'rocketride.playground', 'name': 'playground', 'shells': None},
            {'id': 'acme.dropper', 'name': 'Dropper', 'shells': None},
        ],
        agents=[{**AGENT, 'name': 'Aparavi Bot'}],
    )
    whole = await acct.handle_public(_conn(), {'command': 'rrext_public_catalog'})
    assert [a['name'] for a in whole['body']['apps']] == ['Aparavi Bot', 'Dropper', 'playground', 'SQL Explorer']
    page = await acct.handle_public(
        _conn(), {'command': 'rrext_public_catalog', 'arguments': {'offset': 1, 'limit': 2}}
    )
    assert [a['name'] for a in page['body']['apps']] == ['Dropper', 'playground']
    assert page['body']['total'] == 4
    # The first desktop is still seeded in the inventory's order, not the catalog's
    assert await acct._desktop_backend().read('local', 'local') == [
        'rocketride.sql',
        'rocketride.playground',
        'acme.dropper',
    ]


@pytest.mark.asyncio
async def test_an_agent_never_seeds_a_first_desktop():
    """The first desktop is the app inventory; an agent goes on it only by an add."""
    acct = _agent_account()
    result = await acct.handle_public(_conn(), {'command': 'rrext_public_catalog'})
    assert {a['id']: a['onDesktop'] for a in result['body']['apps']}[BOT] is False
    assert await acct._desktop_backend().read('local', 'local') == ['rocketride.playground', 'rocketride.sql']


@pytest.mark.asyncio
async def test_a_catalog_whose_pipe_walk_fails_still_lists_the_apps(monkeypatch):
    """AccountBase.catalog_pipes logs a failed walk and lists no agents."""
    from ai.account import pipe_deploy

    monkeypatch.setattr(pipe_deploy, 'catalog_pipe_entries', AsyncMock(side_effect=RuntimeError('db down')))
    assert await AccountBase.catalog_pipes(_Account(), MagicMock()) == []


@pytest.mark.asyncio
async def test_desktop_add_takes_a_reachable_agents_address_and_pushes(monkeypatch, pushes):
    from ai.account import pipe_deploy

    reachable = AsyncMock(return_value=dict(AGENT))
    monkeypatch.setattr(pipe_deploy, 'reachable_pipe_entry', reachable)
    acct = _agent_account()
    conn = _conn()

    added = await acct.handle_app(conn, _req('desktop_add', appId=BOT))

    assert added['body'] == {'added': True, 'appId': BOT}
    reachable.assert_awaited_once_with(acct, conn._account_info, BOT)
    # The first write seeded the app inventory, then the address joined it
    assert await acct._desktop_backend().read('local', 'local') == ['rocketride.playground', 'rocketride.sql', BOT]
    assert pushes == ['local']


@pytest.mark.asyncio
async def test_desktop_add_refuses_an_agent_the_caller_does_not_reach(monkeypatch, pushes):
    from ai.account import pipe_deploy

    monkeypatch.setattr(pipe_deploy, 'reachable_pipe_entry', AsyncMock(return_value=None))
    acct = _agent_account()
    result = await acct.handle_app(_conn(), _req('desktop_add', appId=BOT))
    assert result == {'success': False, 'message': 'Agent not found'}
    assert await acct._desktop_backend().read('local', 'local') is None
    assert pushes == []


@pytest.mark.asyncio
async def test_desktop_add_of_a_name_without_a_pipe_row_takes_the_app_gate(monkeypatch, pushes):
    """An unknown name is an app: the app catalog decides, and the pipe resolver is never asked."""
    from ai.account import pipe_deploy

    reachable = AsyncMock(return_value=dict(AGENT))
    monkeypatch.setattr(pipe_deploy, 'reachable_pipe_entry', reachable)
    acct = _agent_account()
    result = await acct.handle_app(_conn(), _req('desktop_add', appId='acme.unknown'))
    assert result == {'success': False, 'message': 'App not found'}
    reachable.assert_not_awaited()
    assert pushes == []


@pytest.mark.asyncio
async def test_desktop_add_refuses_while_the_name_rows_do_not_answer(pushes):
    class _DownRows(_Account):
        async def deployments_kinds(self, org_id, project_ids):
            raise RuntimeError('registry down')

    acct = _DownRows()
    result = await acct.handle_app(_conn(), _req('desktop_add', appId=BOT))
    assert result == {'success': False, 'message': 'The app catalog is unavailable; try again.'}
    assert await acct._desktop_backend().read('local', 'local') is None
    assert pushes == []


@pytest.mark.asyncio
async def test_desktop_remove_takes_an_agents_address(pushes):
    acct = _agent_account()
    await acct._desktop_backend().write('local', 'local', ['rocketride.playground', BOT])
    removed = await acct.handle_app(_conn(), _req('desktop_remove', appId=BOT))
    assert removed['body'] == {'removed': True, 'appId': BOT}
    assert await acct._desktop_backend().read('local', 'local') == ['rocketride.playground']
    assert pushes == ['local']


@pytest.mark.asyncio
async def test_the_base_tiles_read_the_stored_list_and_never_fail_the_sign_in(monkeypatch):
    from ai.account import pipe_deploy

    seen: List[Any] = []

    async def tiles(account, info, ids):
        seen.append(list(ids))
        return [dict(AGENT, onDesktop=True)]

    monkeypatch.setattr(pipe_deploy, 'desktop_pipe_tiles', tiles)
    acct = _agent_account()
    await acct._desktop_backend().write('local', 'local', ['rocketride.playground', BOT])
    info = MagicMock(userId='local', organization={'id': 'local'})

    assert [t['id'] for t in await acct.desktop_pipe_tiles(info)] == [BOT]
    assert await acct.desktop_pipe_tiles(info, ['given']) == [dict(AGENT, onDesktop=True)]
    assert seen == [['rocketride.playground', BOT], ['given']]

    monkeypatch.setattr(pipe_deploy, 'desktop_pipe_tiles', AsyncMock(side_effect=RuntimeError('db down')))
    assert await acct.desktop_pipe_tiles(info) == []


@pytest.mark.asyncio
async def test_oss_sign_in_delivers_the_desktops_agents_through_the_payload(monkeypatch):
    """authenticate() appends the agent tiles; kind, pipe and hostAppId survive the identity's serialization."""
    from ai.account import pipe_deploy

    acct = _oss_account(
        monkeypatch,
        {'pins': [{'id': 'rocketride.playground', 'moduleId': 'rocketride_playground', 'name': 'Playground'}]},
    )
    await acct._desktop_backend().write('local', 'local', ['rocketride.playground', BOT])
    acct._deployments_backend = MagicMock()
    acct._deployments_backend.kinds_of = AsyncMock(return_value={BOT: 'pipe'})
    monkeypatch.setattr(pipe_deploy, 'reachable_pipe_entry', AsyncMock(return_value=dict(AGENT)))
    # An open server: authenticate() checks RR_APIKEY, and refuses a server
    # holding only the client's ROCKETRIDE_APIKEY
    monkeypatch.delenv('RR_APIKEY', raising=False)
    monkeypatch.delenv('ROCKETRIDE_APIKEY', raising=False)

    signed_in = await acct.authenticate('')

    assert [(a['id'], a['onDesktop']) for a in signed_in.apps] == [('rocketride.playground', True), (BOT, True)]
    pushed = {a['id']: a for a in signed_in.to_push_result()['apps']}
    assert (pushed[BOT]['kind'], pushed[BOT]['pipe'], pushed[BOT]['hostAppId'], pushed[BOT]['moduleId']) == (
        'pipe',
        BOT,
        'rocketride.playground',
        'rocketride_playground',
    )
    assert 'kind' not in pushed['rocketride.playground']
