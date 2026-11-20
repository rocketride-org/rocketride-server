"""
The OSS per-user desktop list (plan 9.1, B41): ``ai/account/desktop.py``
and the account-layer behaviour built on it.

- ``FileDesktopBackend`` — one JSON document per user in the raw store:
  round trip, missing/corrupt reads as "never written", id validation.
- ``AccountBase.desktop_app_ids`` / ``decorate_desktop`` — the first read
  seeds the inventory; later reads keep what the user chose.
- ``handle_app`` desktop writes — change the list, push the account.
- ``handle_public`` — the public catalog carries the same decoration.
- The OSS login assembly and the OSS account push decorate with the real
  membership (no forced ``onDesktop: True`` anywhere).
- Concurrency: the per-user lock keeps two adds from losing one another.
- Seeding: the public catalog seeds from the whole reachable inventory; a
  failed registry resolution never writes a desktop.
"""

from __future__ import annotations

import asyncio
from typing import Any, Dict, List
from unittest.mock import MagicMock

import pytest

from ai.account import manifest_push
from ai.account.base import AccountBase, InventoryUnavailableError
from ai.account.desktop import DESKTOP_FORMAT_VERSION, FileDesktopBackend
from ai.account.store_providers.memory import MemoryStore


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


class _Account(AccountBase):
    """AccountBase made instantiable, with a MemoryStore-backed desktop and a
    fixed reachable inventory (two apps).
    """

    def __init__(self, inventory: List[Dict[str, Any]] | None = None):
        self._desktop_backend_instance = FileDesktopBackend(MemoryStore())
        self._inventory = (
            inventory
            if inventory is not None
            else [
                {'id': 'rocketride.chat', 'name': 'Chat', 'shells': None},
                {'id': 'rocketride.sql', 'name': 'SQL', 'shells': ['oss']},
            ]
        )

    async def authenticate(self, credential: str):
        return None

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
    await backend.write('local', 'local', ['rocketride.chat'])
    assert FileDesktopBackend.path('local', 'local') == 'orgs/local/files/.desktop/local.json'
    import json

    assert json.loads(await store.read_file('orgs/local/files/.desktop/local.json')) == {
        'version': DESKTOP_FORMAT_VERSION,
        'apps': ['rocketride.chat'],
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
    apps = [{'id': 'rocketride.chat'}, {'id': 'rocketride.sql'}]
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
        ('rocketride.chat', 'free', True),
        ('rocketride.sql', 'free', True),
    ]


@pytest.mark.asyncio
async def test_handle_app_desktop_remove_then_add_round_trips_and_pushes(pushes):
    acct = _Account()
    removed = await acct.handle_app(_conn(), _req('desktop_remove', appId='rocketride.sql'))
    assert removed['body'] == {'removed': True, 'appId': 'rocketride.sql'}
    assert await acct._desktop_backend().read('local', 'local') == ['rocketride.chat']
    listed = await acct.handle_app(_conn(), _req('list'))
    assert {a['id']: a['onDesktop'] for a in listed['body']['apps']} == {
        'rocketride.chat': True,
        'rocketride.sql': False,
    }
    got = await acct.handle_app(_conn(), _req('get', appId='rocketride.sql'))
    assert got['body']['app']['onDesktop'] is False and got['body']['prices'] == []

    added = await acct.handle_app(_conn(), _req('desktop_add', appId='rocketride.sql'))
    assert added['body'] == {'added': True, 'appId': 'rocketride.sql'}
    assert await acct._desktop_backend().read('local', 'local') == ['rocketride.chat', 'rocketride.sql']
    # Every write pushed the refreshed identity to the user's connections.
    assert pushes == ['local', 'local']


@pytest.mark.asyncio
async def test_handle_app_desktop_add_is_idempotent(pushes):
    acct = _Account()
    await acct.handle_app(_conn(), _req('desktop_add', appId='rocketride.chat'))
    await acct.handle_app(_conn(), _req('desktop_add', appId='rocketride.chat'))
    assert await acct._desktop_backend().read('local', 'local') == ['rocketride.chat', 'rocketride.sql']
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
    assert [a['id'] for a in result['body']['apps']] == ['rocketride.chat']


# ---------------------------------------------------------------------------
# handle_public: the catalog carries the same decoration
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_handle_public_decorates_for_the_signed_in_caller():
    acct = _Account()
    await acct._desktop_backend().write('local', 'local', ['rocketride.chat'])
    req = {'command': 'rrext_public_catalog', 'arguments': {'shell': 'oss'}}
    result = await acct.handle_public(_conn(), req)
    assert result['body']['total'] == 2
    assert {a['id']: (a['appStatus'], a['onDesktop']) for a in result['body']['apps']} == {
        'rocketride.chat': ('free', True),
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
        return [{'id': 'rocketride.chat'}, {'id': 'rocketride.sql'}, {'name': 'malformed, no id'}]

    monkeypatch.setattr(app_deploy, 'resolve_app_pins', pins)
    acct = Account.__new__(Account)
    acct._desktop_backend_instance = FileDesktopBackend(MemoryStore())
    await acct._desktop_backend().write('local', 'local', ['rocketride.sql'])
    apps = await acct._assemble_apps()
    assert [(a['id'], a['appStatus'], a['onDesktop']) for a in apps] == [
        ('rocketride.chat', 'free', False),
        ('rocketride.sql', 'free', True),
    ]


@pytest.mark.asyncio
async def test_oss_login_assembly_survives_a_broken_desktop_store(monkeypatch):
    from ai.account import app_deploy
    from ai.account.oss import Account

    async def pins(org_id, team_id, teams, strict=False):
        return [{'id': 'rocketride.chat'}]

    class _Broken:
        async def read(self, org_id, user_id):
            raise RuntimeError('store down')

    monkeypatch.setattr(app_deploy, 'resolve_app_pins', pins)
    acct = Account.__new__(Account)
    acct._desktop_backend_instance = _Broken()
    apps = await acct._assemble_apps()
    assert apps == [{'id': 'rocketride.chat', 'appStatus': 'free', 'onDesktop': False}]


@pytest.mark.asyncio
async def test_oss_account_push_carries_the_decorated_list(monkeypatch):
    """The OSS push rebuilds the list through the account layer and sends it
    as decorated — it no longer forces every app onto the desktop.
    """

    class _Acct:
        _service = None

        async def get_apps_for_user(self, user_id, orgs):
            return [
                {'id': 'rocketride.chat', 'appStatus': 'free', 'onDesktop': False},
                {'id': 'rocketride.sql', 'appStatus': 'free', 'onDesktop': True},
                {'name': 'no id'},
            ]

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
        {'id': 'rocketride.chat', 'appStatus': 'free', 'onDesktop': False},
        {'id': 'rocketride.sql', 'appStatus': 'free', 'onDesktop': True},
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
    acct = _Account(inventory=[{'id': 'rocketride.chat'}, {'id': 'rocketride.sql'}, {'id': 'rocketride.dropper'}])
    acct._desktop_backend_instance = FileDesktopBackend(_YieldingStore())
    await acct._desktop_backend().write('local', 'local', ['rocketride.chat'])
    results = await asyncio.gather(
        acct.handle_app(_conn(), _req('desktop_add', appId='rocketride.sql')),
        acct.handle_app(_conn(), _req('desktop_add', appId='rocketride.dropper')),
    )
    assert all(r['success'] for r in results)
    assert set(await acct._desktop_backend().read('local', 'local')) == {
        'rocketride.chat',
        'rocketride.sql',
        'rocketride.dropper',
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
            return [{'id': 'rocketride.chat'}]

    acct = _TeamAccount(inventory=[{'id': 'rocketride.chat'}, {'id': 'team.only'}])
    result = await acct.handle_public(_conn(), {'command': 'rrext_public_catalog'})
    assert [(a['id'], a['onDesktop']) for a in result['body']['apps']] == [('rocketride.chat', True)]
    assert await acct._desktop_backend().read('local', 'local') == ['rocketride.chat', 'team.only']


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
        return [{'id': 'rocketride.chat'}, {'id': 'rocketride.sql'}]

    monkeypatch.setattr(app_deploy, 'resolve_app_pins', pins)
    acct = Account.__new__(Account)
    acct._desktop_backend_instance = FileDesktopBackend(MemoryStore())
    with pytest.raises(InventoryUnavailableError):
        await acct._assemble_apps()
    assert await acct._desktop_backend().read('local', 'local') is None
    state['fail'] = False
    apps = await acct._assemble_apps()
    assert [(a['id'], a['onDesktop']) for a in apps] == [('rocketride.chat', True), ('rocketride.sql', True)]
    assert await acct._desktop_backend().read('local', 'local') == ['rocketride.chat', 'rocketride.sql']


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
    return acct


@pytest.mark.asyncio
async def test_oss_desktop_writes_do_not_deadlock_on_the_inventory_walk(monkeypatch, pushes):
    """desktop_add/remove gate on get_apps_for_user, which on OSS decorates
    through desktop_app_ids and takes the per-user lock itself: the walk
    must run outside the write's lock or both verbs hang.
    """
    acct = _oss_account(monkeypatch, {'pins': [{'id': 'rocketride.chat'}, {'id': 'rocketride.sql'}]})
    added = await asyncio.wait_for(acct.handle_app(_conn(), _req('desktop_add', appId='rocketride.sql')), timeout=2)
    assert added['body'] == {'added': True, 'appId': 'rocketride.sql'}
    removed = await asyncio.wait_for(
        acct.handle_app(_conn(), _req('desktop_remove', appId='rocketride.chat')), timeout=2
    )
    assert removed['body'] == {'removed': True, 'appId': 'rocketride.chat'}
    assert await acct._desktop_backend().read('local', 'local') == ['rocketride.sql']
    assert pushes == ['local', 'local']


@pytest.mark.asyncio
async def test_oss_list_get_public_on_a_failed_inventory_write_nothing_then_seed(monkeypatch, pushes):
    state: Dict[str, Any] = {'fail': True, 'pins': [{'id': 'rocketride.chat'}, {'id': 'rocketride.sql'}]}
    acct = _oss_account(monkeypatch, state)

    async def public_apps():
        return [{'id': 'rocketride.chat'}]

    acct.get_public_apps = public_apps  # type: ignore[method-assign]

    listed = await acct.handle_app(_conn(), _req('list'))
    assert listed == {'success': True, 'body': {'apps': []}}
    got = await acct.handle_app(_conn(), _req('get', appId='rocketride.chat'))
    assert got == {'success': False, 'message': 'App not found'}
    public = await acct.handle_public(_conn(), {'command': 'rrext_public_catalog'})
    assert [(a['id'], a['appStatus'], a['onDesktop']) for a in public['body']['apps']] == [
        ('rocketride.chat', 'free', False)
    ]
    write = await acct.handle_app(_conn(), _req('desktop_add', appId='rocketride.sql'))
    assert write == {'success': False, 'message': 'The app catalog is unavailable; try again.'}
    # authenticate() checks ROCKETRIDE_APIKEY: a developer with one set would
    # get the 401 tuple here instead of the identity.
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
        ('rocketride.chat', True),
        ('rocketride.sql', True),
    ]
    assert await acct._desktop_backend().read('local', 'local') == ['rocketride.chat', 'rocketride.sql']


@pytest.mark.asyncio
async def test_oss_public_catalog_on_a_failed_inventory_still_reads_the_stored_desktop(monkeypatch):
    acct = _oss_account(monkeypatch, {'fail': True, 'pins': []})
    await acct._desktop_backend().write('local', 'local', ['rocketride.chat'])

    async def public_apps():
        return [{'id': 'rocketride.chat'}, {'id': 'rocketride.sql'}]

    acct.get_public_apps = public_apps  # type: ignore[method-assign]
    public = await acct.handle_public(_conn(), {'command': 'rrext_public_catalog'})
    assert {a['id']: a['onDesktop'] for a in public['body']['apps']} == {
        'rocketride.chat': True,
        'rocketride.sql': False,
    }
    assert await acct._desktop_backend().read('local', 'local') == ['rocketride.chat']


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
        return [_publish_row('rocketride.chat', 1), _publish_row('rocketride.sql', 1)]

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
        ('rocketride.chat', True),
        ('rocketride.sql', True),
    ]
    assert await acct._desktop_backend().read('local', 'local') == ['rocketride.chat', 'rocketride.sql']


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
