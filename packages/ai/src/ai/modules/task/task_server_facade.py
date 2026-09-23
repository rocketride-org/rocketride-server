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

"""Launch a task on a TaskServer via an in-process DAP connection."""

import asyncio
from typing import TYPE_CHECKING, Any, Dict, Optional, Union

from ai.common.dap import TransportBase

from .task_conn import TaskConn

if TYPE_CHECKING:
    from .task_server import TaskServer


# =============================================================================
# PUBLIC
# =============================================================================


class ServerTaskAuthError(Exception):
    """Token authentication failed; distinct from transient execution errors."""


async def start_server_task(server: 'TaskServer', token: str, pipeline: Dict[str, Any]) -> str:
    """Authenticate ``token`` and execute ``pipeline`` on ``server``; return the task token (``tk_…``).

    Raises:
        ServerTaskAuthError: Authentication failed.
        RuntimeError: Execute request did not succeed.
    """
    conn = _InProcessConn(server)

    try:
        await conn.request('auth', arguments={'auth': token})
    except RuntimeError as exc:
        raise ServerTaskAuthError(str(exc)) from exc

    exec_response = await conn.request('execute', arguments={'pipeline': pipeline})

    return exec_response['body']['token']


async def start_server_task_as_team(
    server: 'TaskServer',
    pipeline: Dict[str, Any],
    *,
    org_id: str,
    team_id: str,
    trigger: str = 'schedule',
    ttl: Optional[int] = None,
    trace_level: Optional[str] = None,
    debug_out: bool = False,
    owner_kind: str = 'team',
    owner_user_id: str = '',
) -> str:
    """Execute ``pipeline`` as a DEPLOYMENT run — no stored credential.

    The trusted dispatch path for scheduled/deployed runs: instead of
    replaying a user token, the connection's identity is CONSTRUCTED
    server-side — a synthetic AccountInfo whose only grant is the task
    permission set on ``team_id``. Two owner modes:

      - ``owner_kind='team'`` (default): the TEAM owns the run. It carries
        NO human identity; the env merge uses org+team layers only (a
        deployment's configuration never depends on which human deployed
        it); billing attributes to org+team; who deployed or fired lives
        exclusively in the audit log and deployment history.
      - ``owner_kind='user'``: a PERSONAL (@me) deployment run. The run is
        OWNED by ``owner_user_id`` — private visibility, user-tree storage
        and logs, the owner's user secret layer applies, and billing
        attributes to the owner (``team_id`` is the deployment's ABSOLUTE
        billing stamp, written at pointer time and read by the caller).
      - ``run_kind='deploy'``, the owner scope, and ``trigger`` travel as
        TRUSTED connection attributes read by on_execute — never as DAP
        arguments, so remote clients cannot spoof a deploy run.

    Raises:
        RuntimeError: Execute request did not succeed.
    """
    from ai.account import account
    from ai.account.models import AccountInfo

    # Trusted entry point, but still validate the owner pair: owner_kind='user'
    # with an empty owner_user_id would build an identity with userId='' — a
    # user-owned run with no owner. Downstream that yields no storage anchor
    # (Task._storage_root) and an empty run-log anchor (raises), so the run
    # executes with storage tools disabled and no log, both SILENTLY. Fail loud.
    if owner_kind == 'user' and not owner_user_id:
        raise ValueError("owner_kind='user' requires a non-empty owner_user_id")

    conn = _InProcessConn(server)

    # Server-constructed team identity: full task permissions on the ONE
    # team, nothing else. No userToken — deploy runs hold no credential,
    # and no user identity: the team is the owner.
    conn._account_info = AccountInfo(
        # A @team deploy carries NO human identity (the team owns it). A @me
        # deploy is owned by a specific user, so it carries that user's id —
        # billing attributes to the owner and the owner's user secret layer
        # resolves. The billing team still rides devTeam below either way.
        userId=owner_user_id if owner_kind == 'user' else '',
        displayName='',
        email='',
        devTeam=team_id,
        organization={
            'id': org_id,
            'name': '',
            'permissions': [],
            'teams': [
                {
                    'id': team_id,
                    'name': '',
                    'permissions': ['task.control', 'task.monitor', 'task.data', 'task.store'],
                }
            ],
        },
        capabilities=list(account.capabilities),
    )
    conn._authenticated = True

    # The trusted, non-wire channel for run classification.
    conn._trusted_run_kind = 'deploy'
    conn._trusted_owner_kind = owner_kind
    conn._trusted_trigger = trigger

    # The schedule's run window rides the execute arguments: start_task
    # reads 'ttl', and a deploy run ALWAYS sends it. 0 means no window
    # (run until the pipeline exits); N means seconds until shutdown (the
    # 'fixed window' schedule option). Omitting it would silently apply
    # the server's DEFAULT idle timeout, which is a dev-task policy.
    # The per-source execution settings ride the same way as a dev run:
    # 'pipelineTraceLevel' plus '--trace=debugOut' in the task args.
    arguments: Dict[str, Any] = {'pipeline': pipeline, 'teamId': team_id, 'ttl': int(ttl) if ttl else 0}
    if trace_level:
        arguments['pipelineTraceLevel'] = trace_level
    if debug_out:
        arguments['args'] = ['--trace=debugOut']
    exec_response = await conn.request('execute', arguments=arguments)

    return exec_response['body']['token']


# =============================================================================
# PRIVATE
# =============================================================================


class _InProcessConn(TaskConn):
    """TaskConn wired to an _InProcessTransport instead of a real socket."""

    def __init__(self, server: 'TaskServer'):
        super().__init__(server._next_connection_id(), server, _InProcessTransport())

    async def request(
        self,
        command: str,
        *,
        token: Optional[str] = None,
        arguments: Optional[Dict[str, Any]] = None,
        data: Union[bytes, str] = None,
    ) -> Dict[str, Any]:
        request = self.build_request(command, token=token, arguments=arguments, data=data)
        await self.on_receive(request)
        response = self._transport.get_response()
        if not response or not response.get('success'):
            reason = (response.get('message') or 'no reason') if response else 'no response'
            raise RuntimeError(f'{command} failed: {reason}')
        return response


class _InProcessTransport(TransportBase):
    """DAP transport that keeps the last sent response."""

    def __init__(self) -> None:
        super().__init__()
        self._connected = True
        self._last_response: Optional[Dict[str, Any]] = None

    async def send(self, message: Dict[str, Any]) -> None:
        # Currently, other types of messages are not processed in the in-process context
        if message.get('type') == 'response':
            self._last_response = message

    def disconnect(self) -> 'asyncio.Task':
        self._connected = False

        async def _noop() -> None:
            return None

        return asyncio.ensure_future(_noop())

    def get_response(self) -> Optional[Dict[str, Any]]:
        return self._last_response
