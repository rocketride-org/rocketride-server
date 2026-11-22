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
The server side of ``self.state`` / ``self.files`` (plan 5.7): identity is decided here.

Every request carries only the binding (``correlationId``), the node's id and its own key or
path. These tests drive the registered channel commands through the real
channel dispatch with an engine double whose ``binding_control`` names the
owning control, and ``TaskEngine.binding_control`` itself on its records.
"""

import shutil
import tempfile
import time
import uuid
from types import SimpleNamespace

import pytest

from ai.account.state_store import MemoryStateStore, install_state_store, state_key, state_scope
from ai.account.store import Store
from ai.account.store_providers.filesystem import FilesystemStore
from ai.constants import CONST_STATE_MAX_KEYS_PER_NODE, CONST_STATE_MAX_TTL_SECONDS
from ai.modules.task import node_doors
from ai.modules.task.task_channel import ChannelStreams, handle
from ai.modules.task.task_engine import TaskEngine
from ai.modules.task.types import TaskError

# ==== Fixtures ===================================================================


def _control(**overrides):
    """A control's record as the server holds it."""
    fields = {
        'orgId': 'org-1',
        'userId': 'user-1',
        'teamId': 'team-1',
        'address': 'acme.monitor.webhook',
        'project_id': 'monitor',
        'ttl': 0,
        'owner_type': 'user',
        'roots': (),
        # Each control its own key, as the registry mints one per control
        'key': '=control/' + uuid.uuid4().hex,
    }
    fields.update(overrides)
    control = SimpleNamespace(**fields)
    control.owner_id = control.teamId if control.owner_type == 'team' else control.userId
    return control


class _Engine:
    """The engine a request came from: its id, its streams, and the server's record of its bindings."""

    def __init__(self, bindings, engine_id=7):
        self.engine_id = engine_id
        self.streams = ChannelStreams()
        self._bindings = bindings

    def binding_control(self, correlation_id):
        return self._bindings.get(correlation_id)


class _Client:
    @staticmethod
    def build_response(message, body=None):
        return {'success': True, 'body': body or {}}

    @staticmethod
    def build_error(message, text):
        return {'success': False, 'message': text}


async def _ask(engine, command, data=None, **arguments):
    """One channel request; returns (body, data) or raises with the refusal."""
    if data is not None:
        arguments['data'] = data
    response = await handle(
        engine, _Client(), engine.streams, {'command': command, 'arguments': arguments}, startup_open=False
    )
    if not response['success']:
        raise RuntimeError(response['message'])
    return response['body'], (response.get('arguments') or {}).get('data')


@pytest.fixture
def state():
    store = MemoryStateStore()
    install_state_store(store)
    yield store
    install_state_store(None)


@pytest.fixture
def files(monkeypatch):
    """The server's file store over a throwaway directory."""
    root = tempfile.mkdtemp()
    store = Store(FilesystemStore(f'filesystem://{root}'))
    monkeypatch.setattr(Store, 'instance', classmethod(lambda cls: store))
    yield store
    shutil.rmtree(root, ignore_errors=True)


ALICE = _control()
BOB = _control(orgId='org-2', userId='user-2', teamId='team-2')

#: The component id the state requests below name unless a test is about it.
NODE = 'node_1'

# ==== state.* ====================================================================


async def test_the_key_is_built_from_the_control_never_from_the_request(state):
    engine = _Engine({'c1': ALICE})
    # Identity fields smuggled into the request change nothing
    await _ask(
        engine,
        'state.put',
        correlationId='c1',
        nodeId=NODE,
        key='series:cpu',
        value=[1, 2],
        userId='user-2',
        orgId='org-2',
    )
    assert await state.get(state_key('org-1', 'user-1', 'acme.monitor.webhook', NODE, 'series:cpu')) == '[1,2]'
    assert await state.get(state_key('org-2', 'user-2', 'acme.monitor.webhook', NODE, 'series:cpu')) is None


async def test_two_owners_naming_one_key_never_meet(state):
    engine = _Engine({'c1': ALICE, 'c2': BOB})
    await _ask(engine, 'state.put', correlationId='c1', nodeId=NODE, key='k', value='alice')
    await _ask(engine, 'state.put', correlationId='c2', nodeId=NODE, key='k', value='bob')
    assert (await _ask(engine, 'state.get', correlationId='c1', nodeId=NODE, key='k'))[0] == {
        'found': True,
        'value': 'alice',
    }
    assert (await _ask(engine, 'state.get', correlationId='c2', nodeId=NODE, key='k'))[0] == {
        'found': True,
        'value': 'bob',
    }


async def test_a_team_owned_control_keys_by_its_team(state):
    engine = _Engine({'c1': _control(owner_type='team')})
    await _ask(engine, 'state.put', correlationId='c1', nodeId=NODE, key='k', value=1)
    assert await state.get(state_key('org-1', 'team-1', 'acme.monitor.webhook', NODE, 'k')) == '1'


async def test_an_unowned_binding_is_refused(state):
    engine = _Engine({'c1': ALICE})
    with pytest.raises(RuntimeError, match='belongs to no control'):
        await _ask(engine, 'state.get', correlationId='c2', nodeId=NODE, key='k')
    with pytest.raises(RuntimeError, match='belongs to no control'):
        await _ask(engine, 'state.get', nodeId=NODE, key='k')


async def test_get_delete_incr_and_absent_values(state):
    engine = _Engine({'c1': ALICE})
    assert (await _ask(engine, 'state.get', correlationId='c1', nodeId=NODE, key='k'))[0] == {'found': False}
    await _ask(engine, 'state.put', correlationId='c1', nodeId=NODE, key='k', value=None)
    assert (await _ask(engine, 'state.get', correlationId='c1', nodeId=NODE, key='k'))[0] == {
        'found': True,
        'value': None,
    }
    assert (await _ask(engine, 'state.delete', correlationId='c1', nodeId=NODE, key='k'))[0] == {'deleted': True}
    assert (await _ask(engine, 'state.incr', correlationId='c1', nodeId=NODE, key='n', amount=3))[0] == {'value': 3}
    with pytest.raises(RuntimeError, match='amount is an integer'):
        await _ask(engine, 'state.incr', correlationId='c1', nodeId=NODE, key='n', amount=1.5)


@pytest.fixture
def writes(state, monkeypatch):
    """The (ttl, max_keys) of every put and incr that reaches the store."""
    seen = []
    real_put, real_incr = state.put, state.incr

    async def put(scope, key, text, ttl, max_keys, token=None):
        seen.append((ttl, max_keys))
        await real_put(scope, key, text, ttl, max_keys, token)

    async def incr(scope, key, amount, ttl, max_keys, token=None):
        seen.append((ttl, max_keys))
        return await real_incr(scope, key, amount, ttl, max_keys, token)

    monkeypatch.setattr(state, 'put', put)
    monkeypatch.setattr(state, 'incr', incr)
    return seen


async def test_the_ttl_defaults_to_the_controls_idle_policy(writes):
    await _ask(_Engine({'c1': _control(ttl=900)}), 'state.put', correlationId='c1', nodeId=NODE, key='k', value=1)
    await _ask(
        _Engine({'c1': _control(ttl=900)}), 'state.put', correlationId='c1', nodeId=NODE, key='k', value=1, ttl=5
    )
    await _ask(_Engine({'c1': _control(ttl=900)}), 'state.incr', correlationId='c1', nodeId=NODE, key='n')
    assert [ttl for ttl, _ in writes] == [900.0, 5.0, 900.0]
    with pytest.raises(RuntimeError, match='ttl'):
        await _ask(_Engine({'c1': ALICE}), 'state.put', correlationId='c1', nodeId=NODE, key='k', value=1, ttl=-1)


@pytest.mark.parametrize('policy', [0, None])
async def test_a_control_with_no_idle_policy_gives_the_longest_ttl(writes, policy):
    engine = _Engine({'c1': _control(ttl=policy)})
    await _ask(engine, 'state.put', correlationId='c1', nodeId=NODE, key='k', value=1)
    await _ask(engine, 'state.incr', correlationId='c1', nodeId=NODE, key='n')
    assert [ttl for ttl, _ in writes] == [float(CONST_STATE_MAX_TTL_SECONDS)] * 2


async def test_an_idle_policy_above_the_longest_ttl_is_capped(writes):
    engine = _Engine({'c1': _control(ttl=CONST_STATE_MAX_TTL_SECONDS * 4)})
    await _ask(engine, 'state.put', correlationId='c1', nodeId=NODE, key='k', value=1)
    await _ask(engine, 'state.incr', correlationId='c1', nodeId=NODE, key='n')
    assert [ttl for ttl, _ in writes] == [float(CONST_STATE_MAX_TTL_SECONDS)] * 2


async def test_a_node_ttl_above_the_longest_is_refused(writes):
    assert CONST_STATE_MAX_TTL_SECONDS == 7 * 24 * 3600
    engine = _Engine({'c1': _control(ttl=900)})
    longest = CONST_STATE_MAX_TTL_SECONDS
    await _ask(engine, 'state.put', correlationId='c1', nodeId=NODE, key='k', value=1, ttl=longest)
    for command, extra in (('state.put', {'value': 1}), ('state.incr', {})):
        for ttl in (longest + 1, 0, True, 'soon'):
            with pytest.raises(RuntimeError, match=f'{command}: ttl is a number of seconds'):
                await _ask(engine, command, correlationId='c1', nodeId=NODE, key='k', ttl=ttl, **extra)
    assert writes == [(float(longest), CONST_STATE_MAX_KEYS_PER_NODE)]


async def test_every_stored_value_has_an_expiry(state):
    # Whatever the control's policy and whether or not the node names a ttl
    for index, policy in enumerate((0, 900, CONST_STATE_MAX_TTL_SECONDS * 4)):
        engine = _Engine({'c1': _control(ttl=policy, address=f'acme.monitor.source{index}')})
        await _ask(engine, 'state.put', correlationId='c1', nodeId=NODE, key='k', value=1)
        await _ask(engine, 'state.incr', correlationId='c1', nodeId=NODE, key='n')
    now = time.monotonic()
    assert len(state._values) == 6
    assert all(now < deadline <= now + CONST_STATE_MAX_TTL_SECONDS for _, deadline, _ in state._values.values())


# ==== state.*: one node's keys ====================================================


async def test_two_nodes_of_one_control_naming_one_key_never_meet(state):
    engine = _Engine({'c1': ALICE})
    await _ask(engine, 'state.put', correlationId='c1', nodeId='anomaly_1', key='series:cpu', value=[1])
    await _ask(engine, 'state.put', correlationId='c1', nodeId='anomaly_2', key='series:cpu', value=[2])
    first = (await _ask(engine, 'state.get', correlationId='c1', nodeId='anomaly_1', key='series:cpu'))[0]
    second = (await _ask(engine, 'state.get', correlationId='c1', nodeId='anomaly_2', key='series:cpu'))[0]
    assert (first, second) == ({'found': True, 'value': [1]}, {'found': True, 'value': [2]})
    # Counters, deletes and locks are per node too
    assert (await _ask(engine, 'state.incr', correlationId='c1', nodeId='anomaly_1', key='n'))[0] == {'value': 1}
    assert (await _ask(engine, 'state.incr', correlationId='c1', nodeId='anomaly_2', key='n'))[0] == {'value': 1}
    assert (await _ask(engine, 'state.delete', correlationId='c1', nodeId='anomaly_1', key='series:cpu'))[0] == {
        'deleted': True
    }
    assert (await _ask(engine, 'state.get', correlationId='c1', nodeId='anomaly_2', key='series:cpu'))[0] == second
    assert (await _ask(engine, 'state.lock', correlationId='c1', nodeId='anomaly_1', key='k'))[0]['acquired'] is True
    assert (await _ask(engine, 'state.lock', correlationId='c1', nodeId='anomaly_2', key='k'))[0]['acquired'] is True


async def test_the_node_id_joins_the_key_after_the_address(state):
    engine = _Engine({'c1': ALICE})
    await _ask(engine, 'state.put', correlationId='c1', nodeId='anomaly/1', key='k', value=1)
    assert await state.get(state_key('org-1', 'user-1', 'acme.monitor.webhook', 'anomaly/1', 'k')) == '1'
    assert list(state._scopes) == [state_scope('org-1', 'user-1', 'acme.monitor.webhook', 'anomaly/1')]


async def test_a_node_id_never_reaches_another_owner(state):
    engine = _Engine({'c1': ALICE, 'c2': BOB})
    await _ask(engine, 'state.put', correlationId='c2', nodeId=NODE, key='k', value='bob')
    # The node id is one escaped segment under the caller's own owner and address
    forged = '../../../org-2/user-2/acme.monitor.webhook/' + NODE
    assert (await _ask(engine, 'state.get', correlationId='c1', nodeId=forged, key='k'))[0] == {'found': False}
    assert (await _ask(engine, 'state.get', correlationId='c1', nodeId=NODE, key='k'))[0] == {'found': False}


@pytest.mark.parametrize(
    'command', ['state.get', 'state.put', 'state.delete', 'state.incr', 'state.lock', 'state.unlock']
)
@pytest.mark.parametrize('node_id', [None, '', 7, ['n']])
async def test_a_request_without_a_node_id_is_refused(state, command, node_id):
    engine = _Engine({'c1': ALICE})
    arguments = {'correlationId': 'c1', 'key': 'k', 'value': 1, 'token': 't'}
    if node_id is not None:
        arguments['nodeId'] = node_id
    with pytest.raises(RuntimeError, match=f'{command}: "nodeId" is a non-empty string'):
        await _ask(engine, command, **arguments)
    assert not state._values and not state._locks


async def test_a_node_holds_sixteen_keys_and_the_next_is_refused(state, writes):
    assert CONST_STATE_MAX_KEYS_PER_NODE == 16
    engine = _Engine({'c1': ALICE})
    for index in range(16):
        await _ask(engine, 'state.put', correlationId='c1', nodeId=NODE, key=f'k{index}', value=index)
    assert {max_keys for _, max_keys in writes} == {16}
    with pytest.raises(RuntimeError, match='state.put: a node keeps at most 16 state keys'):
        await _ask(engine, 'state.put', correlationId='c1', nodeId=NODE, key='k16', value=16)
    with pytest.raises(RuntimeError, match='state.incr: a node keeps at most 16 state keys'):
        await _ask(engine, 'state.incr', correlationId='c1', nodeId=NODE, key='n')
    # A key the node holds is still written; nothing was evicted
    await _ask(engine, 'state.put', correlationId='c1', nodeId=NODE, key='k0', value='again')
    values = [(await _ask(engine, 'state.get', correlationId='c1', nodeId=NODE, key=f'k{i}'))[0] for i in range(16)]
    assert [v['value'] for v in values] == ['again', *range(1, 16)]
    # Another node of the pipeline, and the same node for another owner, have their own sixteen
    await _ask(engine, 'state.put', correlationId='c1', nodeId='node_2', key='k16', value=1)
    await _ask(_Engine({'c2': BOB}), 'state.put', correlationId='c2', nodeId=NODE, key='k16', value=1)
    # A deleted key frees its slot
    await _ask(engine, 'state.delete', correlationId='c1', nodeId=NODE, key='k5')
    assert (await _ask(engine, 'state.incr', correlationId='c1', nodeId=NODE, key='n'))[0] == {'value': 1}


async def test_values_are_capped_and_keys_validated(state):
    engine = _Engine({'c1': ALICE})
    with pytest.raises(RuntimeError, match='at most'):
        await _ask(engine, 'state.put', correlationId='c1', nodeId=NODE, key='k', value='x' * (1024 * 1024))
    with pytest.raises(RuntimeError, match='non-empty string'):
        await _ask(engine, 'state.get', correlationId='c1', nodeId=NODE, key='')


async def test_a_lock_never_waits_here_and_only_its_token_releases_it(state):
    engine = _Engine({'c1': ALICE, 'c2': ALICE})
    first = (await _ask(engine, 'state.lock', correlationId='c1', nodeId=NODE, key='k'))[0]
    assert first['acquired'] and first['token']
    assert (await _ask(engine, 'state.lock', correlationId='c2', nodeId=NODE, key='k'))[0] == {
        'acquired': False,
        'token': None,
    }
    assert (await _ask(engine, 'state.unlock', correlationId='c2', nodeId=NODE, key='k', token='guess'))[0] == {
        'released': False
    }
    assert (await _ask(engine, 'state.unlock', correlationId='c1', nodeId=NODE, key='k', token=first['token']))[0] == {
        'released': True
    }
    assert (await _ask(engine, 'state.lock', correlationId='c2', nodeId=NODE, key='k'))[0]['acquired'] is True


async def test_a_write_naming_a_lost_lease_is_refused(state):
    engine = _Engine({'c1': ALICE, 'c2': ALICE})
    first = (await _ask(engine, 'state.lock', correlationId='c1', nodeId=NODE, key='k'))[0]
    await _ask(engine, 'state.put', correlationId='c1', nodeId=NODE, key='k', value=1, token=first['token'])
    await _ask(engine, 'state.unlock', correlationId='c1', nodeId=NODE, key='k', token=first['token'])
    second = (await _ask(engine, 'state.lock', correlationId='c2', nodeId=NODE, key='k'))[0]
    await _ask(engine, 'state.put', correlationId='c2', nodeId=NODE, key='k', value=2, token=second['token'])
    with pytest.raises(RuntimeError, match='lock on this key was lost'):
        await _ask(engine, 'state.put', correlationId='c1', nodeId=NODE, key='k', value=9, token=first['token'])
    with pytest.raises(RuntimeError, match='token is the string'):
        await _ask(engine, 'state.incr', correlationId='c1', nodeId=NODE, key='k', token=7)
    assert (await _ask(engine, 'state.get', correlationId='c2', nodeId=NODE, key='k'))[0] == {'found': True, 'value': 2}


# ==== fs_* =======================================================================


async def test_files_are_rooted_at_the_owners_tree(files):
    engine = _Engine({'c1': ALICE, 'c2': _control(owner_type='team')})
    handle_id = (await _ask(engine, 'fs_open', correlationId='c1', path='out/a.txt', mode='w'))[0]['handle']
    await _ask(engine, 'fs_write', b'hello', correlationId='c1', handle=handle_id)
    await _ask(engine, 'fs_close', correlationId='c1', handle=handle_id, mode='w')
    assert await files._file_store(_engine_ctx(), client_id='user-1').read('out/a.txt') == b'hello'

    await _ask(engine, 'fs_put_json', correlationId='c2', path='run.json', value={'n': 1})
    team = files._file_store(_engine_ctx(), client_id='user-1', root='teams/team-1/files/tasks/monitor')
    assert await team.get_json('run.json') == {'n': 1}


async def test_reads_come_back_in_chunks_with_the_handle_protocol(files):
    engine = _Engine({'c1': ALICE})
    written = (await _ask(engine, 'fs_open', correlationId='c1', path='doc.bin', mode='w'))[0]['handle']
    await _ask(engine, 'fs_write', b'abcdefgh', correlationId='c1', handle=written)
    await _ask(engine, 'fs_close', correlationId='c1', handle=written, mode='w')
    opened = (await _ask(engine, 'fs_open', correlationId='c1', path='doc.bin', mode='r'))[0]
    assert opened['size'] == 8
    body, chunk = await _ask(engine, 'fs_read', correlationId='c1', handle=opened['handle'], offset=2, length=3)
    assert (body, chunk) == ({'size': 3}, b'cde')
    await _ask(engine, 'fs_close', correlationId='c1', handle=opened['handle'], mode='r')


async def test_scoped_paths_and_system_trees_are_refused(files):
    engine = _Engine({'c1': ALICE})
    for rooted in ('=team/team-1/x.json', '@Development/x.json', '@me/x.json', '=user/user-1/x.json'):
        with pytest.raises(RuntimeError, match='not a root this pipeline declares'):
            await _ask(engine, 'fs_get_json', correlationId='c1', path=rooted)
    with pytest.raises(RuntimeError, match='engine context'):
        await _ask(engine, 'fs_put_json', correlationId='c1', path='.logs/x.json', value=1)


def _declaring(*roots, owner_kind='user', owner_id='user-1', account=None):
    """ALICE's control with the roots its pipeline declares, resolved through its owner as start_task does."""
    from ai.account.file_store import declared_roots

    member = account or SimpleNamespace(
        userId='user-1',
        sysPermissions=[],
        organization={
            'id': 'org-1',
            'permissions': [],
            'teams': [{'id': 'team-1', 'name': 'Development', 'permissions': ['task.store']}],
        },
    )
    resolved = declared_roots(
        list(roots), owner_kind=owner_kind, owner_id=owner_id, org_id='org-1', account_info=member
    )
    return _control(roots=resolved)


async def test_a_declared_root_is_reached_and_an_undeclared_one_refused(files):
    """Plan 2.5: self.files reaches a path under a declared root, as it was declared, and nothing else."""
    engine = _Engine({'c1': _declaring('@Development/kb')})

    # Under the declared root: by its name in any case, and its own subtree
    await _ask(engine, 'fs_put_json', correlationId='c1', path='@Development/kb/doc.json', value={'a': 1})
    body, _ = await _ask(engine, 'fs_get_json', correlationId='c1', path='@development/kb/doc.json')
    assert body['value'] == {'a': 1}
    internal = files._file_store(_internal_ctx(), client_id='user-1')
    assert await internal.get_json('=team/team-1/kb/doc.json') == {'a': 1}

    # The same root by the team's id is the same tree; outside it: another
    # path of the same team, the org, a user root
    body, _ = await _ask(engine, 'fs_get_json', correlationId='c1', path='=team/team-1/kb/doc.json')
    assert body['value'] == {'a': 1}
    for rooted in ('@Development/other.json', '=team/team-1/other.json', '@org/x.json', '@me/x.json'):
        with pytest.raises(RuntimeError, match='not a root this pipeline declares'):
            await _ask(engine, 'fs_get_json', correlationId='c1', path=rooted)
    # A system tree under a declared team stays refused
    with pytest.raises(RuntimeError, match='engine context'):
        await _ask(engine, 'fs_get_json', correlationId='c1', path='@Development/.logs/x.json')


def test_a_root_outside_the_owners_reach_refuses_the_start():
    """The owner must reach every declared root in a session (plan 2.5); otherwise the control never starts."""
    from ai.account.file_store import declared_roots

    no_store = SimpleNamespace(
        userId='user-1',
        sysPermissions=[],
        organization={
            'id': 'org-1',
            'permissions': [],
            'teams': [{'id': 'team-1', 'name': 'Development', 'permissions': ['task.data']}],
        },
    )
    # A user owner without task.store on the team, or without org.admin on the org
    with pytest.raises(PermissionError, match='outside'):
        declared_roots(['@Development/kb'], owner_kind='user', owner_id='user-1', org_id='org-1', account_info=no_store)
    with pytest.raises(PermissionError, match='outside'):
        declared_roots(['@org/shared'], owner_kind='user', owner_id='user-1', org_id='org-1', account_info=no_store)
    # A team owner reaches its own tree only; the org owner the org tree only
    with pytest.raises(PermissionError, match='outside'):
        declared_roots(['=team/team-2/kb'], owner_kind='team', owner_id='team-1', org_id='org-1')
    assert declared_roots(['=team/team-1/kb'], owner_kind='team', owner_id='team-1', org_id='org-1')[0].physical == (
        'teams/team-1/files'
    )
    assert declared_roots(['@org/shared'], owner_kind='org', owner_id='org-1', org_id='org-1')[0].rest == 'shared'
    with pytest.raises(PermissionError, match='outside'):
        declared_roots(['=org/org-2/x'], owner_kind='org', owner_id='org-1', org_id='org-1')
    # A name with no session to resolve it, and the roots no pipeline may declare
    with pytest.raises(PermissionError, match='outside'):
        declared_roots(['@Development/kb'], owner_kind='team', owner_id='team-1', org_id='org-1')
    for bad in (['@me/x'], ['=user/user-1/x'], ['plain/path'], ['@public/x'], 'not-a-list', [3]):
        with pytest.raises(ValueError):
            declared_roots(bad, owner_kind='user', owner_id='user-1', org_id='org-1', account_info=no_store)
    assert declared_roots(None, owner_kind='user', owner_id='user-1', org_id='org-1') == ()


async def test_the_root_listing_hides_the_system_trees(files):
    engine = _Engine({'c1': ALICE})
    await _ask(engine, 'fs_put_json', correlationId='c1', path='a.json', value=1)
    internal = files._file_store(_internal_ctx(), client_id='user-1')
    await internal.write('.logs/x', b'log')
    names = [e['name'] for e in (await _ask(engine, 'fs_list_dir', correlationId='c1', path=''))[0]['entries']]
    assert names == ['a.json']


async def test_another_owners_handle_cannot_be_used(files):
    engine = _Engine({'c1': ALICE, 'c2': BOB})
    handle_id = (await _ask(engine, 'fs_open', correlationId='c1', path='a.txt', mode='w'))[0]['handle']
    with pytest.raises(RuntimeError, match='another connection'):
        await _ask(engine, 'fs_write', b'x', correlationId='c2', handle=handle_id)
    await _ask(engine, 'fs_close', correlationId='c1', handle=handle_id, mode='w')


async def test_one_teams_projects_never_share_a_handle(files):
    # One team, one engine, two projects: two roots, so two handle owners
    alpha = _control(owner_type='team', project_id='alpha')
    beta = _control(owner_type='team', project_id='beta')
    engine = _Engine({'c1': alpha, 'c2': beta})
    handle_id = (await _ask(engine, 'fs_open', correlationId='c1', path='a.txt', mode='w'))[0]['handle']
    with pytest.raises(RuntimeError, match='another connection'):
        await _ask(engine, 'fs_write', b'x', correlationId='c2', handle=handle_id)
    await _ask(engine, 'fs_close', correlationId='c1', handle=handle_id, mode='w')


async def test_two_controls_of_one_project_never_share_a_handle(files):
    # One owner, one project, one engine, one storage root: two controls (two
    # configurations, which may declare different roots) own their handles apart
    first = _control(owner_type='team', project_id='alpha')
    second = _control(owner_type='team', project_id='alpha')
    engine = _Engine({'c1': first, 'c2': second})
    handle_id = (await _ask(engine, 'fs_open', correlationId='c1', path='a.txt', mode='w'))[0]['handle']
    with pytest.raises(RuntimeError, match='another connection'):
        await _ask(engine, 'fs_write', b'x', correlationId='c2', handle=handle_id)
    await _ask(engine, 'fs_close', correlationId='c1', handle=handle_id, mode='w')


async def test_handles_close_with_the_engine(files):
    engine = _Engine({'c1': ALICE})
    await _ask(engine, 'fs_open', correlationId='c1', path='left-open.txt', mode='w')
    assert files._shared_write_locks
    await node_doors.release_engine(engine)
    assert not files._shared_write_locks and not files._shared_handles


async def test_an_owner_with_no_tree_is_refused(files):
    engine = _Engine({'c1': _control(userId='')})
    with pytest.raises(RuntimeError, match='no owner'):
        await _ask(engine, 'fs_stat', correlationId='c1', path='x')


def _engine_ctx():
    from ai.account.models import RequestContext

    return RequestContext.engine('user-1')


def _internal_ctx():
    from ai.account.models import RequestContext

    return RequestContext.internal('test')


# ==== TaskEngine.binding_control ==================================================


def _task_engine(holds, shared=False):
    """A TaskEngine with only what binding_control reads, ``__init__`` bypassed."""
    controls = {'c-alice': ALICE, 'c-bob': BOB}

    def control_by_key(key):
        if key not in controls:
            raise TaskError(TaskError.NOT_REGISTERED, 'gone')
        return controls[key]

    engine = TaskEngine.__new__(TaskEngine)
    engine._server = SimpleNamespace(node_id='n1', control_by_key=control_by_key)
    engine.engine_id = 3
    engine.shared = shared
    engine._holds = {key: 0 for key in holds}
    engine._bindings = {}
    return engine


def test_an_admitted_binding_is_its_controls_from_before_its_first_frame():
    # Recorded before the open is forwarded: nothing about the engine's own
    # answer is needed, so an open's callbacks and a standalone tool call reach
    # their owner on a shared engine with several holders
    engine = _task_engine(['c-alice', 'c-bob'], shared=True)
    engine.admit_binding('cid-bob', 'c-bob')
    assert engine.binding_control('cid-bob') is BOB


def test_an_ended_or_unknown_binding_is_nobodys():
    # Even on a private engine one control holds: a named binding the server
    # never admitted, or one that ended, never falls back to the holder
    engine = _task_engine(['c-alice'])
    engine.admit_binding('cid-alice', 'c-alice')
    engine.end_binding('cid-alice')
    assert engine.binding_control('cid-alice') is None
    assert engine.binding_control('guessed') is None
    assert engine.binding_control(5) is None


def test_engine_level_work_is_the_one_holders_on_a_private_engine_only():
    assert _task_engine(['c-alice']).binding_control('') is ALICE
    assert _task_engine(['c-alice']).binding_control(None) is ALICE
    assert _task_engine(['c-alice', 'c-bob']).binding_control('') is None
    assert _task_engine(['c-alice'], shared=True).binding_control('') is None
    assert _task_engine([]).binding_control('') is None


def test_a_binding_whose_control_is_gone_has_no_owner():
    engine = _task_engine(['c-alice'], shared=True)
    engine.admit_binding('cid', 'c-gone')
    assert engine.binding_control('cid') is None
