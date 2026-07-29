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
    actor: Dict[str, Any],
    trigger: str = 'schedule',
    ttl: Optional[int] = None,
    trace_level: Optional[str] = None,
    debug_out: bool = False,
) -> str:
    """Execute ``pipeline`` as a TEAM deployment run — no stored credential.

    The trusted dispatch path for scheduled/deployed runs: instead of
    replaying a user token, the connection's identity is CONSTRUCTED
    server-side as the team — a synthetic AccountInfo whose only grant is
    the task permission set on ``team_id``. Consequences, all deliberate:

      - The env merge uses org+team layers only (no user layer) — a deploy
        run's configuration never depends on which human deployed it.
      - ``actor`` (the deploying user, from the deployment record) rides as
        billing/attribution identity, not as authentication.
      - ``run_kind='deploy'`` and ``trigger`` travel as TRUSTED connection
        attributes read by on_execute — never as DAP arguments, so remote
        clients cannot spoof a deploy run.

    Raises:
        RuntimeError: Execute request did not succeed.
    """
    from ai.account import account
    from ai.account.models import AccountInfo

    conn = _InProcessConn(server)

    # Server-constructed team identity: full task permissions on the ONE
    # team, nothing else. No userToken — deploy runs hold no credential.
    conn._account_info = AccountInfo(
        userId=str(actor.get('userId') or ''),
        displayName=str(actor.get('display') or ''),
        email=str(actor.get('email') or ''),
        defaultTeam=team_id,
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
    conn._trusted_trigger = trigger

    # The schedule's run window rides the execute arguments: start_task
    # reads 'ttl', and a deploy run ALWAYS sends it — 0 means no window.
    # The per-source execution settings ride the same way as a dev run:
    # 'pipelineTraceLevel' plus '--trace=debugOut' in the task args.
    # (run until the pipeline exits), N means seconds until shutdown (the
    # 'fixed window' schedule option). Omitting it would silently apply
    # the server's DEFAULT idle timeout, which is a dev-task policy.
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
