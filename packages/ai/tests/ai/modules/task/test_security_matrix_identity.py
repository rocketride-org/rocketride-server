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

"""Named-pipes security matrix, identity rows (plan section 14, Step 3).

Rows S1, S4, S6, S10 and S13: task tokens are gone, every lookup runs with
the request's account, the address grammar is enforced at execute and
publish, the HTTP door takes header credentials only, and the task-file
identity names the authenticated user. Every test here was RED before the
identity work landed and is GREEN after it.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from rocketride import EVENT_TYPE

from ai.account.base import AccountBase
from ai.account.models import AccountInfo
from ai.modules.task.address import (
    build_address,
    check_endpoint_scope,
    parse_address,
    validate_component_ids,
    validate_identity,
)
from ai.modules.task.commands.cmd_misc import MiscCommands
from ai.modules.task.commands.cmd_monitor import MonitorCommands, owner_key
from ai.modules.task.task_server import TASK_CONTROL, TaskServer
from ai.modules.task.types import TaskError


# =============================================================================
# HELPERS
# =============================================================================


def _server() -> TaskServer:
    """A TaskServer shell holding only the registries the resolver reads."""
    ts = TaskServer.__new__(TaskServer)
    ts._task_control = {}
    ts._connections = {}
    ts._connection_id = 0
    ts._unauthed_by_ip = {}
    ts._allocated_ports = []
    ts._reserved_ports = set()
    ts._store_instance = None
    ts._config = {}
    ts._server = MagicMock()
    ts.debug_message = MagicMock()
    ts.broadcast_server_event = AsyncMock()
    return ts


def _account(*, user_id='user-a', team_id='team-1', developer_id='acme', endpoints=None):
    """An AccountInfo with one team membership carrying the task permissions."""
    return AccountInfo(
        auth='rr_key',
        userId=user_id,
        devTeam=team_id,
        organization={
            'id': 'org-1',
            'name': 'Acme',
            'permissions': [],
            'teams': [{'id': team_id, 'name': 'Dev', 'permissions': ['task.control', 'task.data', 'task.monitor']}],
            'developerId': developer_id,
        },
        endpoints=endpoints,
    )


def _control(
    ts: TaskServer,
    *,
    run_kind='dev',
    owner_kind='',
    user_id='user-a',
    team_id='team-1',
    developer_id='acme',
    project_id='docBrain',
    source='parsePDF',
) -> TASK_CONTROL:
    """Register a live control on ``ts`` the way start_task stamps one."""
    control = TASK_CONTROL()
    control.run_kind = run_kind
    control.owner_kind = owner_kind or ('team' if run_kind == 'deploy' else 'user')
    control.userId = user_id
    control.teamId = team_id
    control.orgId = 'org-1'
    control.developer_id = developer_id
    control.project_id = project_id
    control.source = source
    control.address = build_address(developer_id, project_id, source)
    control.id = control.address
    control.key = f'{control.run_kind}.{control.owner_id}.{control.address}'
    control.task = MagicMock()
    control.task.is_task_complete.return_value = False
    control.task.stop_task = AsyncMock()
    ts._task_control[control.key] = control
    return control


def _pipeline(*components: str, source='parsePDF', project_id='docBrain'):
    """A minimal pipeline whose components carry the given ids."""
    return {
        'project_id': project_id,
        'source': source,
        'components': [{'id': cid, 'provider': 'webhook', 'config': {}} for cid in components],
    }


def _launch_request(pipeline, **extra):
    return {'command': 'launch', 'arguments': {'pipeline': pipeline, **extra}}


# =============================================================================
# S1 — tokens are gone: nothing mints one, nothing accepts one
# =============================================================================


def test_s1_account_base_has_no_token_minter():
    """No code path mints a task token: the digest helper is deleted."""
    assert not hasattr(AccountBase, 'generate_token')


def test_s1_task_server_registers_no_token_authenticator():
    """The task server no longer answers credentials at all."""
    assert not hasattr(TaskServer, 'authenticate')
    assert not hasattr(TaskServer, 'get_task_control_by_public_key')
    assert not hasattr(TaskServer, 'get_task_control')
    assert not hasattr(TaskServer, 'get_task')


@pytest.mark.asyncio
@pytest.mark.parametrize('credential', ['tk_0123456789abcdef', 'pk_0123456789abcdef'])
async def test_s1_legacy_token_strings_are_an_auth_error(credential):
    """A tk_/pk_ string fails the credential chain outright (hard break, no flag)."""
    from ai.web.server import WebServer

    web = WebServer.__new__(WebServer)
    web._authenticators = []
    web.account = SimpleNamespace(authenticate=AsyncMock(return_value=None))

    result = await web.authenticate_credential(credential)

    assert result == (401, 'Invalid authorization provided')


def test_s1_control_carries_no_token_fields():
    """The control is addressed, never tokened."""
    fields = set(TASK_CONTROL.__dataclass_fields__)
    assert 'token' not in fields
    assert 'public_auth' not in fields
    assert {'address', 'key', 'developer_id'} <= fields


# =============================================================================
# S4 — every lookup runs with the request's account; no owner qualifier exists
# =============================================================================


def test_s4_unscoped_lookup_no_longer_exists():
    """get_task_control_by_project has no account-less branch: the account is required."""
    ts = _server()
    _control(ts)
    with pytest.raises(TypeError):
        ts.get_task_control_by_project('docBrain', 'parsePDF')  # type: ignore[call-arg]


def test_s4_user_b_never_resolves_user_a_dev_control():
    """B's resolution of A's @dev address walks B's rungs and finds nothing."""
    ts = _server()
    a_control = _control(ts, user_id='user-a')

    resolved = ts.resolve_control(a_control.address, _account(user_id='user-a'), 'task.data')
    assert resolved is a_control

    with pytest.raises(TaskError) as denied:
        ts.resolve_control(a_control.address, _account(user_id='user-b'), 'task.data')
    assert denied.value.code == TaskError.NOT_REGISTERED


def test_s4_resolution_requires_the_permission_on_every_call():
    """A caller without the required permission is refused even on their own run."""
    ts = _server()
    control = _control(ts)
    viewer = AccountInfo(
        auth='rr_key',
        userId='user-a',
        organization={'id': 'org-1', 'name': '', 'permissions': [], 'teams': [], 'developerId': 'acme'},
    )
    # A user-owned run grants its owner everything by identity ...
    assert ts.resolve_control(control.address, viewer, 'task.control') is control
    # ... but a TEAM-owned run resolves through membership, and the viewer has
    # none: the run is simply not on any rung they can reach (no existence leak).
    team_run = _control(ts, run_kind='deploy', owner_kind='team', user_id='', project_id='nightly')
    with pytest.raises(TaskError) as denied:
        ts.resolve_control(team_run.address, viewer, 'task.monitor')
    assert denied.value.code == TaskError.NOT_REGISTERED
    # A member holding task.monitor on that team reaches it, and only with the
    # permission the request names.
    member = _account(team_id='team-1', developer_id='acme')
    assert ts.resolve_control(team_run.address, member, 'task.monitor') is team_run
    with pytest.raises(PermissionError):
        ts.resolve_control(team_run.address, member, 'task.store')


def test_s4_a_foreign_developer_prefix_is_not_the_callers_dev_rung():
    """The @dev rung matches only when the address prefix is the caller's developer id."""
    ts = _server()
    control = _control(ts, developer_id='acme')
    with pytest.raises(TaskError):
        ts.resolve_control('globex.docBrain.parsePDF', _account(developer_id='globex'), 'task.data')
    assert ts.resolve_control(control.address, _account(developer_id='acme'), 'task.data') is control


def test_s4_two_teams_deploying_one_address_resolve_to_the_active_team():
    """The address carries no owner, so two teams can each run it. A member of both
    reaches the run of their development team; with neither on it, the lookup is
    ambiguous and names the teams instead of asking for a source already given.
    """
    ts = _server()
    run_1 = _control(ts, run_kind='deploy', owner_kind='team', user_id='', team_id='team-1')
    run_2 = _control(ts, run_kind='deploy', owner_kind='team', user_id='', team_id='team-2')
    perms = ['task.control', 'task.data', 'task.monitor']

    def member(dev_team: str) -> AccountInfo:
        return AccountInfo(
            auth='rr_key',
            userId='user-a',
            devTeam=dev_team,
            organization={
                'id': 'org-1',
                'name': 'Acme',
                'permissions': [],
                'teams': [
                    {'id': 'team-1', 'name': 'One', 'permissions': perms},
                    {'id': 'team-2', 'name': 'Two', 'permissions': perms},
                    {'id': 'team-3', 'name': 'Three', 'permissions': perms},
                ],
                'developerId': 'acme',
            },
        )

    assert ts.resolve_control(run_1.address, member('team-1'), 'task.monitor') is run_1
    assert ts.resolve_control(run_2.address, member('team-2'), 'task.monitor') is run_2
    with pytest.raises(TaskError) as err:
        ts.resolve_control(run_1.address, member('team-3'), 'task.monitor')
    assert err.value.code == TaskError.AMBIGUOUS
    assert err.value.teams == ['team-1', 'team-2']


# =============================================================================
# S6 — address grammar: dot-free segments, validated at execute AND publish
# =============================================================================


@pytest.mark.parametrize('bad', ['a.b', 'with space', 'slash/id', '', 'tilde~id', 'unié'])
def test_s6_component_ids_are_dot_free_segments(bad):
    """A component id outside [A-Za-z0-9_-]+ is an invalid-argument error."""
    with pytest.raises(TaskError) as err:
        validate_component_ids(_pipeline('ok_1', bad))
    assert err.value.code == TaskError.INVALID_ARGUMENT


@pytest.mark.asyncio
async def test_s6_execute_rejects_a_dotted_component_id():
    """start_task refuses the pipeline before any task is created."""
    ts = _server()
    with pytest.raises(TaskError) as err:
        await ts.start_task(
            _launch_request(_pipeline('parsePDF', 'llm.gpt')),
            conn=MagicMock(),
            client_id='user-a',
            user_id='user-a',
            team_id='team-1',
            org_id='org-1',
            developer_id='acme',
        )
    assert err.value.code == TaskError.INVALID_ARGUMENT
    assert ts._task_control == {}


@pytest.mark.asyncio
async def test_s6_execute_rejects_a_dotted_project_id():
    """The .pipe carries the SHORT id; a dotted project id never becomes an address."""
    ts = _server()
    with pytest.raises(TaskError) as err:
        await ts.start_task(
            _launch_request(_pipeline('parsePDF', project_id='acme.docBrain')),
            conn=MagicMock(),
            client_id='user-a',
            user_id='user-a',
            team_id='team-1',
            org_id='org-1',
            developer_id='acme',
        )
    assert err.value.code == TaskError.INVALID_ARGUMENT


@pytest.mark.asyncio
async def test_s6_publish_rejects_a_dotted_component_id():
    """The registry refuses a pipe artifact whose ids break the grammar."""
    from ai.account.deployment_backend import FileDeploymentBackend

    backend = FileDeploymentBackend(MagicMock())
    with pytest.raises(TaskError):
        await backend.publish('org-1', 'docBrain', _pipeline('parsePDF', 'llm.gpt'), {'userId': 'user-a'})
    with pytest.raises(TaskError):
        await backend.publish('org-1', 'acme.docBrain', _pipeline('parsePDF', project_id='acme.docBrain'), {})


def test_s6_two_sources_are_two_controls():
    """acme.docBrain.parsePDF and acme.docBrain.webhook_1 are distinct controls."""
    ts = _server()
    parse_pdf = _control(ts, source='parsePDF')
    webhook = _control(ts, source='webhook_1')
    account = _account()

    assert ts.resolve_control('acme.docBrain.parsePDF', account, 'task.data') is parse_pdf
    assert ts.resolve_control('acme.docBrain.webhook_1', account, 'task.data') is webhook
    # Two live sources and no source given: the caller must name one.
    with pytest.raises(TaskError) as err:
        ts.resolve_control('acme.docBrain', account, 'task.data')
    assert err.value.code == TaskError.SOURCE_REQUIRED
    assert sorted(err.value.sources) == ['parsePDF', 'webhook_1']


@pytest.mark.asyncio
async def test_s6_terminating_one_source_leaves_the_others_monitors():
    """Monitor-key removal is address-equality: the sibling source keeps its subscriptions."""
    ts = _server()
    parse_pdf = _control(ts, source='parsePDF')
    webhook = _control(ts, source='webhook_1')
    conn = SimpleNamespace(
        _monitors={
            owner_key('dev', 'user-a', 'docBrain', 'parsePDF'): 1,
            owner_key('dev', 'user-a', 'docBrain', 'parsePDF') + '.3': 1,
            owner_key('dev', 'user-a', 'docBrain', 'webhook_1'): 1,
            owner_key('dev', 'user-a', 'docBrain', 'webhook_1') + '.7': 1,
        }
    )
    ts._connections = {1: conn}

    await ts.remove_task(parse_pdf.key)

    assert set(conn._monitors) == {
        owner_key('dev', 'user-a', 'docBrain', 'webhook_1'),
        owner_key('dev', 'user-a', 'docBrain', 'webhook_1') + '.7',
    }
    assert webhook.key in ts._task_control


def test_s6_address_parses_on_exact_segments():
    """Only 2 or 3 dot-free segments parse; anything else is an invalid argument."""
    assert parse_address('acme.docBrain') == ('acme', 'docBrain', None)
    assert parse_address('acme.docBrain.parsePDF') == ('acme', 'docBrain', 'parsePDF')
    for bad in ('acme', 'acme.docBrain.a.b', 'acme..x', '.acme.x', 'acme.doc Brain', 'tk_abc'):
        with pytest.raises(TaskError) as err:
            parse_address(bad)
        assert err.value.code == TaskError.INVALID_ARGUMENT


@pytest.mark.parametrize('bad', ['acme.docBrain.parsePDF\n', 'acme\n.docBrain', 'acme.docBrain\n'])
def test_s6_a_trailing_newline_is_not_a_segment(bad):
    """Segments match in full: a `$` anchor would let a trailing newline
    through to registry keys and run-log paths.
    """
    with pytest.raises(TaskError) as err:
        parse_address(bad)
    assert err.value.code == TaskError.INVALID_ARGUMENT
    with pytest.raises(TaskError):
        build_address('acme', 'docBrain', 'parsePDF\n')


@pytest.mark.parametrize('bad', ['a/b', 'a b', 'user~1', ' lead', 'tab\tid', ''])
def test_s6_identity_boundary_rejects_path_and_scope_characters(bad):
    """userId/teamId ingestion rejects '/', whitespace and '~'."""
    with pytest.raises(TaskError):
        validate_identity(bad, 'userId')


@pytest.mark.asyncio
async def test_s6_start_task_returns_the_address_in_the_token_slot():
    """use() hands back the address where the token used to be."""
    ts = _server()
    with patch('ai.modules.task.task_server.Task') as task_cls:
        task = task_cls.return_value
        task.start_task = AsyncMock()
        task.wait_for_running = AsyncMock()
        task._stop_requested = False
        result = await ts.start_task(
            _launch_request(_pipeline('parsePDF')),
            conn=MagicMock(),
            client_id='user-a',
            user_id='user-a',
            team_id='team-1',
            org_id='org-1',
            developer_id='acme',
        )
    assert result['token'] == 'acme.docBrain.parsePDF'
    assert 'publicToken' not in result
    assert result['id'] == 'acme.docBrain.parsePDF'
    assert list(ts._task_control) == ['dev.user-a.acme.docBrain.parsePDF']


@pytest.mark.asyncio
async def test_s6_a_client_supplied_token_is_refused_at_execute():
    """Nothing mints a token: a caller cannot name the registry key either."""
    ts = _server()
    with pytest.raises(TaskError) as err:
        await ts.start_task(
            _launch_request(_pipeline('parsePDF'), token='tk_mine'),
            conn=MagicMock(),
            client_id='user-a',
            user_id='user-a',
            team_id='team-1',
            org_id='org-1',
            developer_id='acme',
        )
    assert err.value.code == TaskError.INVALID_ARGUMENT


# =============================================================================
# S10 — the HTTP door: header credentials only, scoped keys, no reserved params
# =============================================================================


@pytest.mark.asyncio
async def test_s10_query_string_credential_is_refused():
    """?auth= is retired on every HTTP door: a credential only in the query is 'none'."""
    from ai.web.server import WebServer

    web = WebServer.__new__(WebServer)
    web._authenticators = []
    web.account = SimpleNamespace(authenticate=AsyncMock(return_value=_account()))
    request = MagicMock()
    request.headers = {}
    request.query_params = {'auth': 'rr_real_key'}
    request.url.path = '/task/data/acme.docBrain.parsePDF'

    result = await web.authenticate_request(request, return_tuple=True)

    assert result == (401, 'No authorization provided')
    web.account.authenticate.assert_not_awaited()


def test_s10_scoped_key_is_bound_to_its_addresses():
    """endpoints=['acme.docBrain.chat'] allows exactly that address; '*' allows any source."""
    check_endpoint_scope(['acme.docBrain.chat'], 'acme.docBrain.chat')
    check_endpoint_scope(['acme.docBrain.*'], 'acme.docBrain.parsePDF')
    check_endpoint_scope(None, 'anyone.anything.anywhere')
    for address in ('acme.docBrain.parsePDF', 'acme.other.chat', 'globex.docBrain.chat'):
        with pytest.raises(PermissionError):
            check_endpoint_scope(['acme.docBrain.chat'], address)
    with pytest.raises(PermissionError):
        check_endpoint_scope([], 'acme.docBrain.chat')


def test_s10_scoped_key_skips_the_dev_rung_and_is_refused_elsewhere():
    """A production webhook key never lands on the owner's Play'd run, and
    cannot reach any address outside its scope.
    """
    ts = _server()
    dev_run = _control(ts, source='chat')
    me_run = _control(ts, run_kind='deploy', owner_kind='user', source='chat', project_id='docBrain')
    scoped = _account(endpoints=['acme.docBrain.chat'])

    assert ts.resolve_control('acme.docBrain.chat', scoped, 'task.data') is me_run
    assert ts.resolve_control('acme.docBrain.chat', _account(), 'task.data') is dev_run
    _control(ts, run_kind='deploy', owner_kind='user', source='parsePDF')
    with pytest.raises(PermissionError):
        ts.resolve_control('acme.docBrain.parsePDF', scoped, 'task.data')


def test_s10_scoped_key_lists_only_the_runs_inside_its_scope():
    """The dashboard/list snapshot walks every run: a scoped key sees only its addresses."""
    ts = _server()
    inside = _control(ts, run_kind='deploy', owner_kind='user', source='chat')
    _control(ts, run_kind='deploy', owner_kind='user', source='parsePDF')
    _control(ts, run_kind='deploy', owner_kind='user', project_id='other', source='chat')

    scoped = SimpleNamespace(_server=ts, _account_info=_account(endpoints=['acme.docBrain.chat']))
    assert MiscCommands._scoped_state(scoped)[0] == [inside]

    unscoped = SimpleNamespace(_server=ts, _account_info=_account())
    assert len(MiscCommands._scoped_state(unscoped)[0]) == 3


@pytest.mark.asyncio
async def test_s10_scoped_key_receives_no_events_from_runs_outside_its_scope():
    """A '*' monitor on a scoped key is still bound to its addresses at delivery."""
    ts = _server()
    inside = _control(ts, run_kind='deploy', owner_kind='user', source='chat')
    outside = _control(ts, run_kind='deploy', owner_kind='user', source='parsePDF')
    conn = SimpleNamespace(
        _server=ts,
        _account_info=_account(endpoints=['acme.docBrain.chat']),
        _monitors={'*': EVENT_TYPE.TASK},
        verify_permission=MagicMock(),
        send_event=AsyncMock(),
    )
    event = {'event': 'apaevt_task', 'body': {}}

    await MonitorCommands.send_task_event(conn, EVENT_TYPE.TASK, outside.key, event)
    conn.send_event.assert_not_awaited()

    await MonitorCommands.send_task_event(conn, EVENT_TYPE.TASK, inside.key, event)
    conn.send_event.assert_awaited_once()


@pytest.mark.asyncio
@pytest.mark.parametrize('reserved', ['teamId', 'runKind', 'auth', 'token'])
async def test_s10_reserved_query_names_never_reach_the_door(reserved):
    """teamId/runKind/auth/token are not parameters: the door refuses the request."""
    from ai.modules.task_http.task_data import task_Data

    request = MagicMock()
    request.path_params = {'address': 'acme.docBrain.parsePDF'}
    request.query_params = {reserved: 'x', 'question': 'hi'}
    request.state.account = _account()
    request.app.state.server.get_port = MagicMock(return_value=9999)
    request.headers = {'Content-Type': 'application/octet-stream'}

    with patch('ai.modules.task_http.task_data.RocketRideClient') as client_cls:
        result = await task_Data(request, authorization='Bearer rr_x')

    client_cls.assert_not_called()
    body = result.body.decode()
    assert reserved in body
    assert 'Error' in body


@pytest.mark.asyncio
async def test_s10_bare_door_needs_a_single_endpoint_key():
    """/webhook with no address works only for a key scoped to exactly one address."""
    from ai.modules.task_http.task_data import task_Data

    def _request(account):
        request = MagicMock()
        request.path_params = {}
        request.query_params = {}
        request.state.account = account
        request.app.state.server.get_port = MagicMock(return_value=9999)
        request.headers = {'Content-Type': 'application/octet-stream'}
        return request

    with patch('ai.modules.task_http.task_data.RocketRideClient') as client_cls:
        client = client_cls.return_value
        client.connect = AsyncMock()
        client.disconnect = AsyncMock()
        client.debug_message = MagicMock()
        with patch('ai.modules.task_http.task_data.RequestProcessing') as proc_cls:
            proc_cls.return_value.process = AsyncMock(return_value='ok')
            await task_Data(_request(_account(endpoints=['acme.docBrain.chat'])), authorization='Bearer rr_x')
            assert proc_cls.call_args.args[1] == 'acme.docBrain.chat'

    with patch('ai.modules.task_http.task_data.RocketRideClient') as client_cls:
        result = await task_Data(_request(_account()), authorization='Bearer rr_x')
        client_cls.assert_not_called()
        assert 'address' in result.body.decode()

    with patch('ai.modules.task_http.task_data.RocketRideClient') as client_cls:
        result = await task_Data(_request(_account(endpoints=['acme.docBrain.*'])), authorization='Bearer rr_x')
        client_cls.assert_not_called()
        assert 'address' in result.body.decode()


# =============================================================================
# S13 — identity: the launch path names the authenticated user
# =============================================================================


@pytest.mark.asyncio
async def test_s13_dev_launch_asserts_client_id_is_the_user():
    """The identity block is filled from client_id; a dev launch must pass the authenticated user."""
    ts = _server()
    with pytest.raises(TaskError) as err:
        await ts.start_task(
            _launch_request(_pipeline('parsePDF')),
            conn=MagicMock(),
            client_id='user-z',
            user_id='user-a',
            team_id='team-1',
            org_id='org-1',
            developer_id='acme',
        )
    assert err.value.code == TaskError.INVALID_ARGUMENT


@pytest.mark.asyncio
async def test_s13_dev_launch_requires_a_developer_id():
    """The address exists from the first run: no developer id, no run.

    The refusal is the same one the app doors give (develop #3077): it names
    the ways an org admin actually registers, never a raw DAP verb.
    """
    ts = _server()
    with pytest.raises(TaskError) as err:
        await ts.start_task(
            _launch_request(_pipeline('parsePDF')),
            conn=MagicMock(),
            client_id='user-a',
            user_id='user-a',
            team_id='team-1',
            org_id='org-1',
            developer_id='',
        )
    assert err.value.code == TaskError.INVALID_ARGUMENT
    assert err.value.field == 'developerId'
    message = str(err.value)
    assert message.startswith('Running a pipeline requires a registered developer id')
    assert 'Deploy tab' in message
    assert 'rocketride app developer register <id>' in message
    assert 'register_developer(id)' in message
    assert 'rrext_' not in message


# =============================================================================
# AccountInfo — the endpoints scope rides the session
# =============================================================================


def test_endpoints_scope_is_part_of_account_info_and_never_echoed_as_auth():
    """A scoped key hydrates its endpoints onto the session; the connect result carries them."""
    info = _account(endpoints=['acme.docBrain.chat'])
    assert info.endpoints == ['acme.docBrain.chat']
    assert info.to_connect_result()['endpoints'] == ['acme.docBrain.chat']
    assert _account().endpoints is None
