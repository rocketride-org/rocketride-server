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

Every request carries only the binding (``traceId``) and the node's own key or
path. These tests drive the registered channel commands through the real
channel dispatch with an engine double whose ``binding_control`` names the
owning control, and ``TaskEngine.binding_control`` itself on its records.
"""

import shutil
import tempfile
from types import SimpleNamespace

import pytest

from ai.account.state_store import MemoryStateStore, install_state_store, state_key
from ai.account.store import Store
from ai.account.store_providers.filesystem import FilesystemStore
from ai.modules.task import node_doors
from ai.modules.task.task_channel import ChannelStreams, handle
from ai.modules.task.task_engine import TaskEngine
from ai.modules.task.trace_owner import TraceOwners
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

    def binding_control(self, trace_id):
        return self._bindings.get(trace_id)


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

# ==== state.* ====================================================================


async def test_the_key_is_built_from_the_control_never_from_the_request(state):
    engine = _Engine({1: ALICE})
    # Identity fields smuggled into the request change nothing
    await _ask(engine, 'state.put', traceId=1, key='series:cpu', value=[1, 2], userId='user-2', orgId='org-2')
    assert await state.get(state_key('org-1', 'user-1', 'acme.monitor.webhook', 'series:cpu')) == '[1,2]'
    assert await state.get(state_key('org-2', 'user-2', 'acme.monitor.webhook', 'series:cpu')) is None


async def test_two_owners_naming_one_key_never_meet(state):
    engine = _Engine({1: ALICE, 2: BOB})
    await _ask(engine, 'state.put', traceId=1, key='k', value='alice')
    await _ask(engine, 'state.put', traceId=2, key='k', value='bob')
    assert (await _ask(engine, 'state.get', traceId=1, key='k'))[0] == {'found': True, 'value': 'alice'}
    assert (await _ask(engine, 'state.get', traceId=2, key='k'))[0] == {'found': True, 'value': 'bob'}


async def test_a_team_owned_control_keys_by_its_team(state):
    engine = _Engine({1: _control(owner_type='team')})
    await _ask(engine, 'state.put', traceId=1, key='k', value=1)
    assert await state.get(state_key('org-1', 'team-1', 'acme.monitor.webhook', 'k')) == '1'


async def test_an_unowned_binding_is_refused(state):
    engine = _Engine({1: ALICE})
    with pytest.raises(RuntimeError, match='belongs to no control'):
        await _ask(engine, 'state.get', traceId=2, key='k')
    with pytest.raises(RuntimeError, match='belongs to no control'):
        await _ask(engine, 'state.get', key='k')


async def test_get_delete_incr_and_absent_values(state):
    engine = _Engine({1: ALICE})
    assert (await _ask(engine, 'state.get', traceId=1, key='k'))[0] == {'found': False}
    await _ask(engine, 'state.put', traceId=1, key='k', value=None)
    assert (await _ask(engine, 'state.get', traceId=1, key='k'))[0] == {'found': True, 'value': None}
    assert (await _ask(engine, 'state.delete', traceId=1, key='k'))[0] == {'deleted': True}
    assert (await _ask(engine, 'state.incr', traceId=1, key='n', amount=3))[0] == {'value': 3}
    with pytest.raises(RuntimeError, match='amount is an integer'):
        await _ask(engine, 'state.incr', traceId=1, key='n', amount=1.5)


async def test_the_ttl_defaults_to_the_controls_idle_policy(state, monkeypatch):
    seen = []
    real = state.put

    async def put(key, text, ttl):
        seen.append(ttl)
        await real(key, text, ttl)

    monkeypatch.setattr(state, 'put', put)
    await _ask(_Engine({1: _control(ttl=900)}), 'state.put', traceId=1, key='k', value=1)
    await _ask(_Engine({1: _control(ttl=0)}), 'state.put', traceId=1, key='k', value=1)
    await _ask(_Engine({1: _control(ttl=900)}), 'state.put', traceId=1, key='k', value=1, ttl=5)
    assert seen == [900.0, None, 5.0]
    with pytest.raises(RuntimeError, match='ttl'):
        await _ask(_Engine({1: ALICE}), 'state.put', traceId=1, key='k', value=1, ttl=-1)


async def test_values_are_capped_and_keys_validated(state):
    engine = _Engine({1: ALICE})
    with pytest.raises(RuntimeError, match='at most'):
        await _ask(engine, 'state.put', traceId=1, key='k', value='x' * (1024 * 1024))
    with pytest.raises(RuntimeError, match='non-empty string'):
        await _ask(engine, 'state.get', traceId=1, key='')


async def test_a_lock_never_waits_here_and_only_its_token_releases_it(state):
    engine = _Engine({1: ALICE, 2: ALICE})
    first = (await _ask(engine, 'state.lock', traceId=1, key='k'))[0]
    assert first['acquired'] and first['token']
    assert (await _ask(engine, 'state.lock', traceId=2, key='k'))[0] == {'acquired': False, 'token': None}
    assert (await _ask(engine, 'state.unlock', traceId=2, key='k', token='guess'))[0] == {'released': False}
    assert (await _ask(engine, 'state.unlock', traceId=1, key='k', token=first['token']))[0] == {'released': True}
    assert (await _ask(engine, 'state.lock', traceId=2, key='k'))[0]['acquired'] is True


# ==== fs_* =======================================================================


async def test_files_are_rooted_at_the_owners_tree(files):
    engine = _Engine({1: ALICE, 2: _control(owner_type='team')})
    handle_id = (await _ask(engine, 'fs_open', traceId=1, path='out/a.txt', mode='w'))[0]['handle']
    await _ask(engine, 'fs_write', b'hello', traceId=1, handle=handle_id)
    await _ask(engine, 'fs_close', traceId=1, handle=handle_id, mode='w')
    assert await files._file_store(_engine_ctx(), client_id='user-1').read('out/a.txt') == b'hello'

    await _ask(engine, 'fs_put_json', traceId=2, path='run.json', value={'n': 1})
    team = files._file_store(_engine_ctx(), client_id='user-1', root='teams/team-1/files/tasks/monitor')
    assert await team.get_json('run.json') == {'n': 1}


async def test_reads_come_back_in_chunks_with_the_handle_protocol(files):
    engine = _Engine({1: ALICE})
    written = (await _ask(engine, 'fs_open', traceId=1, path='doc.bin', mode='w'))[0]['handle']
    await _ask(engine, 'fs_write', b'abcdefgh', traceId=1, handle=written)
    await _ask(engine, 'fs_close', traceId=1, handle=written, mode='w')
    opened = (await _ask(engine, 'fs_open', traceId=1, path='doc.bin', mode='r'))[0]
    assert opened['size'] == 8
    body, chunk = await _ask(engine, 'fs_read', traceId=1, handle=opened['handle'], offset=2, length=3)
    assert (body, chunk) == ({'size': 3}, b'cde')
    await _ask(engine, 'fs_close', traceId=1, handle=opened['handle'], mode='r')


async def test_scoped_paths_and_system_trees_are_refused(files):
    engine = _Engine({1: ALICE})
    with pytest.raises(RuntimeError, match='engine context'):
        await _ask(engine, 'fs_get_json', traceId=1, path='@/Team/=team-1/x.json')
    with pytest.raises(RuntimeError, match='engine context'):
        await _ask(engine, 'fs_put_json', traceId=1, path='.logs/x.json', value=1)


async def test_the_root_listing_hides_the_system_trees(files):
    engine = _Engine({1: ALICE})
    await _ask(engine, 'fs_put_json', traceId=1, path='a.json', value=1)
    internal = files._file_store(_internal_ctx(), client_id='user-1')
    await internal.write('.logs/x', b'log')
    names = [e['name'] for e in (await _ask(engine, 'fs_list_dir', traceId=1, path=''))[0]['entries']]
    assert names == ['a.json']


async def test_another_owners_handle_cannot_be_used(files):
    engine = _Engine({1: ALICE, 2: BOB})
    handle_id = (await _ask(engine, 'fs_open', traceId=1, path='a.txt', mode='w'))[0]['handle']
    with pytest.raises(RuntimeError, match='another connection'):
        await _ask(engine, 'fs_write', b'x', traceId=2, handle=handle_id)
    await _ask(engine, 'fs_close', traceId=1, handle=handle_id, mode='w')


async def test_handles_close_with_the_engine(files):
    engine = _Engine({1: ALICE})
    await _ask(engine, 'fs_open', traceId=1, path='left-open.txt', mode='w')
    assert files._shared_write_locks
    await node_doors.release_engine(engine)
    assert not files._shared_write_locks and not files._shared_handles


async def test_an_owner_with_no_tree_is_refused(files):
    engine = _Engine({1: _control(userId='')})
    with pytest.raises(RuntimeError, match='no owner'):
        await _ask(engine, 'fs_stat', traceId=1, path='x')


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
    engine._server = SimpleNamespace(node_id='n1', trace_owners=TraceOwners(), control_by_key=control_by_key)
    engine.engine_id = 3
    engine.shared = shared
    engine._holds = {key: 0 for key in holds}
    return engine


def test_a_claimed_tree_is_its_owners():
    engine = _task_engine(['c-alice', 'c-bob'], shared=True)
    engine._server.trace_owners.claim(engine.trace_ref(5), 'c-bob', 1)
    assert engine.binding_control(5) is BOB
    assert engine.binding_control(6) is None


def test_unclaimed_work_is_the_one_holders_on_a_private_engine_only():
    assert _task_engine(['c-alice']).binding_control(9) is ALICE
    assert _task_engine(['c-alice']).binding_control(0) is ALICE
    assert _task_engine(['c-alice', 'c-bob']).binding_control(9) is None
    assert _task_engine(['c-alice'], shared=True).binding_control(9) is None
    assert _task_engine([]).binding_control(9) is None


def test_a_tree_whose_control_is_gone_has_no_owner():
    engine = _task_engine(['c-alice'], shared=True)
    engine._server.trace_owners.claim(engine.trace_ref(5), 'c-gone', 1)
    assert engine.binding_control(5) is None
