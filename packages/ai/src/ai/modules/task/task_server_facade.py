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
from .task_control import Attribution, DeploymentRef, Listing

if TYPE_CHECKING:
    from .task_server import TaskServer


# =============================================================================
# PUBLIC
# =============================================================================


class ServerTaskAuthError(Exception):
    """Token authentication failed; distinct from transient execution errors."""


async def start_server_task(server: 'TaskServer', token: str, pipeline: Dict[str, Any]) -> str:
    """Authenticate ``token`` and execute ``pipeline`` on ``server``; return the task address.

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
    attribution: Attribution,
    deployment: DeploymentRef,
    trigger: str = 'schedule',
    ttl: Optional[int] = None,
    trace_level: Optional[str] = None,
    debug_out: bool = False,
    developer_id: str = '',
    version: Optional[int] = None,
    pinned: bool = False,
    caller_account: Any = None,
    deployment_epoch: Optional[float] = None,
    listing: Optional[Listing] = None,
) -> str:
    """Execute ``pipeline`` as a DEPLOYMENT run — no stored credential; return the control's KEY.

    The trusted dispatch path for published runs (a ``submit(name)`` start,
    a schedule fire, a run-now): instead of replaying a user token, the
    connection's identity is CONSTRUCTED server-side from the run's row of
    the rung table (``attribution``, plan 8.3), which rides the connection
    as a trusted attribute read by on_execute — never as DAP arguments, so
    remote clients cannot spoof a deploy run or pick who pays.

      - The OWNER (``attribution.owner_kind``/``owner_id``) is where the run
        lives: a user (``@me``, a caller's ``@public``), a team (``@team``,
        one control per caller) or the org (``@org``, an unattended
        ``@public``).
      - The payer, the ledger user and the ledger team are the row's: a run
        with no caller has no user but on ``@me``, and ``@org``/``@public``
        no team. The ORG mode (an org-owned run with no caller) carries no
        user and no team at all, only the org.
      - The environment is the row's: the caller's org, home team and user
        on every rung; a run with no caller takes org and the publication's
        team, with the publisher's own user layer on ``@me``.
      - The deployment the run resolved through (``deployment``) rides the
        same trusted channel: the publisher's disable/remove releases the
        run's hold.
      - ``developer_id`` is the address namespace when it is not the paying
        org's own: a ``@public`` run is billed to the caller's org while its
        address stays the publisher's.
      - ``version`` is the artifact version the run starts from; ``pinned``
        says the call named it and it is not the rung's published version
        (plan 3.2), so the control has an identity of its own.
      - ``caller_account`` is the caller's own session (a ``submit(name)``
        start): the pipeline's declared roots resolve through it (plan 2.5).
        None for a run with no caller.
      - ``listing`` is the store listing of that version (plan 8.4): what
        the control's store gate re-checks per request; default free.

    Returns:
        The started control's registry KEY (an in-process handle for the
        scheduler and the manual-run door) — never sent to a client; the
        client-facing name is the control's ``address``.

    Raises:
        RuntimeError: Execute request did not succeed.
        PermissionError: The org has no developer id.
    """
    from ai.account import account
    from ai.account.app_deploy import developer_id_required
    from ai.account.models import AccountInfo

    # The address namespace comes from the org, not from a session, unless
    # the run's address lives in the publisher's namespace (@public)
    developer_id = developer_id or await account.get_developer_id(attribution.org_id)
    if not developer_id:
        raise PermissionError(developer_id_required('Running a deployment'))

    # Trusted entry point, but still validate the owner: a run with no owner
    # id would have no storage anchor and no run-log tree, so it would run
    # with storage tools refused and no log, both SILENTLY. Fail loud.
    if not attribution.owner_id:
        raise ValueError(f'A {attribution.owner_kind}-owned run requires its owner id')

    conn = _InProcessConn(server)

    # Server-constructed identity: the ledger user (none for a run with no
    # caller but an unattended @me) and full task permissions on the ledger
    # team, if any, nothing else. No userToken — deploy runs hold no
    # credential. The org mode carries no team and the org-level grant.
    team_id = attribution.team_id
    conn._account_info = AccountInfo(
        userId=attribution.user_id,
        displayName='',
        email='',
        devTeam=team_id,
        teamOrder=[team_id] if team_id else [],
        organization={
            'id': attribution.org_id,
            'name': '',
            'permissions': ['org.admin'] if attribution.owner_kind == 'org' else [],
            'teams': (
                [
                    {
                        'id': team_id,
                        'name': '',
                        'permissions': ['task.control', 'task.monitor', 'task.data', 'task.store'],
                    }
                ]
                if team_id
                else []
            ),
            'developerId': developer_id,
        },
        capabilities=list(account.capabilities),
    )
    conn._authenticated = True

    # The trusted, non-wire channel for the run's classification
    conn._trusted_attribution = attribution
    conn._trusted_trigger = trigger
    conn._trusted_deployment = deployment
    conn._trusted_version = version
    conn._trusted_pinned = pinned
    conn._trusted_caller_account = caller_account
    conn._trusted_deployment_epoch = deployment_epoch
    conn._trusted_listing = listing

    # The schedule's run window rides the execute arguments: start_task
    # reads 'ttl', and a deploy run ALWAYS sends it. 0 means no window
    # (run until the pipeline exits); N means seconds until shutdown (the
    # 'fixed window' schedule option). Omitting it would silently apply
    # the server's DEFAULT idle timeout, which is a dev-task policy.
    # The per-source execution settings ride the same way as a dev run:
    # 'pipelineTraceLevel' plus '--trace=debugOut' in the task args.
    arguments: Dict[str, Any] = {'pipeline': pipeline, 'ttl': int(ttl) if ttl else 0}
    if trace_level:
        arguments['pipelineTraceLevel'] = trace_level
    if debug_out:
        arguments['args'] = ['--trace=debugOut']
    exec_response = await conn.request('execute', arguments=arguments)

    # The response carries the control id in the token slot (plan section
    # 1): the registry key the in-process callers hold. Nothing is resolved
    # through the caller rungs: for a @me deploy the synthetic account IS the
    # owning user, so a name walk would try @spec first and hand back that
    # user's Play'd run of the same pipeline (same address) instead of this
    # deploy run.
    return server.control_by_key(exec_response['body']['token']).key


# =============================================================================
# PRIVATE
# =============================================================================


class _InProcessConn(TaskConn):
    """TaskConn wired to an _InProcessTransport instead of a real socket."""

    def __init__(self, server: 'TaskServer'):
        super().__init__(server._next_connection_id(), server, _InProcessTransport())
        # The exception behind the last error response, so the in-process
        # caller gets it itself: a TaskError keeps its code and fields
        # (engine_start_failed, not_found ...) instead of a flattened message
        self._last_exception: Optional[BaseException] = None

    def build_exception(self, message: Dict[str, Any], exc: BaseException) -> Dict[str, Any]:
        """Record the handler's exception beside the error response it becomes."""
        self._last_exception = exc
        return super().build_exception(message, exc)

    async def request(
        self,
        command: str,
        *,
        token: Optional[str] = None,
        arguments: Optional[Dict[str, Any]] = None,
        data: Union[bytes, str] = None,
    ) -> Dict[str, Any]:
        request = self.build_request(command, token=token, arguments=arguments, data=data)
        self._last_exception = None
        await self.on_receive(request)
        response = self._transport.get_response()
        if not response or not response.get('success'):
            if self._last_exception is not None:
                raise self._last_exception
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
