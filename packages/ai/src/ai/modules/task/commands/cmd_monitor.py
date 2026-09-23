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
MonitorCommands: DAP Event Monitoring and Subscription System.

This module implements a real-time event monitoring system for computational tasks
within a distributed debugging and execution environment. It manages event subscriptions
and forwards task-related events to interested DAP clients based on their monitoring
preferences and access permissions.

Primary Responsibilities:
--------------------------
1. Manages event subscriptions for task monitoring clients
2. Routes task events to subscribed monitors based on event types and access controls
3. Provides selective event filtering (passive, active, debug-only, or none)
4. Maintains monitor registrations with apikey-based access control
5. Handles real-time status updates and task state changes
6. Integrates with the DAP protocol for standardized event communication

Event Types Supported:
----------------------
- PASSIVE: General task status and lifecycle events
- ACTIVE: Interactive events requiring client response
- DEBUG: Debugging-specific events (breakpoints, variable changes, etc.)
- ALL: Subscribe to all event types
- NONE: Unsubscribe from all events

Architecture:
-------------
This system enables multiple clients to monitor the same task simultaneously
with different event subscription levels. It acts as an event distribution
hub that respects access permissions and client preferences.
"""

import time
from typing import TYPE_CHECKING, Dict, Any, List
from ai.common.dap import DAPConn, TransportBase
from ai.account.models import resolve_run_permissions, resolve_task_permissions
from rocketride import EVENT_TYPE, TASK_STATE, TASK_STATUS


# Only import for type checking to avoid circular import errors
if TYPE_CHECKING:
    from ..task_server import TaskServer, TASK_CONTROL


def owner_key(run_kind: str, owner_id: str, project_id: str, source: str) -> str:
    """
    Build the owner-scoped monitor subscription key for a run.

    Monitor keys are ALWAYS owner-scoped — there is no unscoped project
    key: a deploy run's owner is its team OR its user (@me), a dev run's
    owner is its user, so two teams' deploys, two users' dev runs, and a
    dev-vs-deploy pair of the same pipeline all land on distinct keys and
    never alias. The run_kind SEGMENT is what separates a user's dev run
    from that same user's personal (@me) deploy of the same pipeline —
    both are user-owned, so owner_id alone would alias them.

    run_kind is a REQUIRED leading argument (mirroring the key layout) so
    a call site can never silently omit it and collapse the continua.

    Args:
        run_kind (str): 'dev' | 'deploy' — the run's continuum
        owner_id (str): The run's owner — teamId for @team deploys, userId
            for dev runs and @me deploys
        project_id (str): Project identity of the run
        source (str): Source component id of the run

    Returns:
        str: The subscription key ``p.{runKind}.{ownerId}.{projectId}.{source}``
    """
    return f'p.{run_kind}.{owner_id}.{project_id}.{source}'


def owner_wildcard_key(run_kind: str, owner_id: str, project_id: str) -> str:
    """The project-wildcard subscription key (all sources of one project).

    ``owner_key(run_kind, owner_id, project_id, '*')`` in spirit; kept as its
    own helper so every site that builds ``p.{runKind}.{ownerId}.{projectId}.*``
    shares ONE layout definition and cannot drift from ``owner_key``.
    """
    return f'p.{run_kind}.{owner_id}.{project_id}.*'


class MonitorCommands(DAPConn):
    """
    DAP-based event monitoring and subscription manager for task events.

    This class handles event subscriptions from DAP clients and manages the
    real-time distribution of task-related events. It maintains a registry
    of active monitors and their subscription preferences, ensuring that
    events are routed only to authorized and interested clients.

    Key Features:
    - Multi-client event subscription management
    - Selective event filtering based on subscription type
    - Access control using apikey-based authentication
    - Real-time event forwarding with DAP protocol compliance
    - Dynamic subscription management (subscribe/unsubscribe)

    Attributes:
        _monitors: Dictionary mapping "apikey:token" to EVENT_TYPE subscriptions
                  Controls which events each client receives for specific tasks
        _server: Reference to TaskServer for task access and status queries
    """

    def __init__(
        self,
        connection_id: int,
        server: 'TaskServer',
        transport: TransportBase,
        **kwargs,
    ) -> None:
        """
        Initialize a new MonitorCommands instance for event subscription management.

        Sets up the monitoring system with an empty subscription registry
        and establishes connection to the task management server.

        Args:
            connection_id (int): Unique identifier for this monitoring connection
            server (TaskServer): The server managing task instances and lifecycle
            transport (TransportBase): Communication transport layer for DAP messages
            **kwargs: Additional arguments passed to parent DAPConn constructor
        """
        # Initialize the monitor subscription registry
        # Format: "apikey:token" -> EVENT_TYPE mapping
        self._monitors: Dict[str, EVENT_TYPE] = {}

    async def send_server_event(
        self,
        event_type: EVENT_TYPE,
        event: Dict[str, Any],
        user_id: str = None,
        org_id: str = None,
    ) -> None:
        """
        Send a server-level event if this connection is subscribed via the '*' wildcard.

        Filtering order (each check short-circuits if it fails):
        1. Connection must have '*' in its monitor subscriptions
        2. The event_type bitmask must match the subscription
        3. If org_id is specified, connection's primary org must match
        4. If user_id is specified, connection's userId must match

        Args:
            event_type: Event type bitmask (e.g. EVENT_TYPE.DASHBOARD, EVENT_TYPE.BILLING).
            event: DAP event payload with 'event' and 'body' keys.
            user_id: Optional user scope -- only deliver to this user.
            org_id: Optional org scope -- only deliver to connections in this org.
        """
        # Step 1: must be subscribed to wildcard
        if '*' not in self._monitors:
            return
        # Step 2: bitmask must match
        if not (event_type & self._monitors['*']):
            return
        # Step 3: org scoping
        if org_id is not None and hasattr(self, '_account_info') and self._account_info:
            conn_org = ''
            if hasattr(self._account_info, 'organization') and self._account_info.organization:
                org = self._account_info.organization
                conn_org = org.get('id', '') if isinstance(org, dict) else getattr(org, 'id', '')
            if conn_org != org_id:
                return
        # Step 4: user scoping
        if user_id is not None and hasattr(self, '_account_info') and self._account_info:
            if self._account_info.userId != user_id:
                return
        await self.send_event(event.get('event', 'unknown'), body=event.get('body'))

    async def send_task_event(
        self,
        event_type: EVENT_TYPE,
        token: str,
        event: Dict[str, Any] = None,
    ) -> None:
        """
        Forward a task event to subscribed monitors based on their subscription preferences.

        This method implements the core event routing logic, checking if any
        monitors are subscribed to events for the specified task and whether
        the event type matches their subscription level.

        Args:
            type (EVENT_TYPE): The type/category of the event being forwarded
            id (str): Unique identifier for the specific task instance
            token (str): Unique task identifier associated with the event
            event (Dict[str, Any]): The event payload containing:
                - event: String identifier for the event type
                - body: Event-specific data payload

        Event Routing Logic:
        - Events are only sent to monitors with matching apikey:token subscriptions
        - No forwarding occurs if no monitors are subscribed to the task
        """

        async def _send_event(pref: EVENT_TYPE) -> None:
            """
            Conditionally forward a single event to this connection.

            Checks whether the event_type bits are set in the caller's subscription
            preference (pref). If so, extracts the event name and body from the outer
            event dict and sends it over the DAP transport using the task's short id.

            Args:
                pref (EVENT_TYPE): The merged subscription bitmask for this connection.
                    The event is only forwarded when (event_type & pref) is non-zero.
            """
            # If this is not being listened for, skip the forwarding
            if not (event_type & pref):
                return

            # Extract event details for DAP-compliant forwarding
            evt_name = event.get('event', 'unknown')
            body = event.get('body', None)

            # Send the event to the subscribed client using plain DAP. The
            # continuum stamps (eventTime + logSeq) ride INSIDE the shared
            # body, stamped once by the task — every monitor sees the SAME
            # stamps the run log recorded, and the DAP envelope stays pure
            # protocol (each connection mints its own header seq).
            await self.send_event(evt_name, id=control.id, body=body)

        # Get the task by token
        control = self._server.get_task_control(token)

        # Verify we are allowed to receive events for this task - for SSE events, it requires data
        # access, for all others, it's monitor access
        if event_type == EVENT_TYPE.SSE:
            self.verify_permission('task.data')
        else:
            self.verify_permission('task.monitor')

        # Verify the caller may see this run (run-scoped: a user-owned run
        # delivers only to its owner; a team-owned run to team members)
        if not resolve_run_permissions(self._account_info, control):
            return

        # Build the base owner-scoped key: events land on the key of the
        # run's OWNER (team for @team deploys, user for dev and @me), so a
        # dev run, an @me deploy, and a @team deploy of the same pipeline
        # never alias in the keyspace.
        project_key = owner_key(control.run_kind, control.owner_id, control.project_id, control.source)

        # Gather all matching subscription keys and merge their preferences
        # so each subscriber receives the event at most once.
        merged_preference = EVENT_TYPE(0)

        # Pipe-scoped check (most specific) — SSE events embed pipe_id in body
        pipe_id = (event or {}).get('body', {}).get('pipe_id')
        if pipe_id is not None:
            pipe_key = f'{project_key}.{pipe_id}'
            if pipe_key in self._monitors:
                merged_preference |= self._monitors[pipe_key]

        # Project-scoped check (exact source match)
        if project_key in self._monitors:
            merged_preference |= self._monitors[project_key]

        # Project-wildcard check (all sources of the owner's project:
        # p.{runKind}.{ownerId}.{projectId}.*)
        project_wildcard_key = owner_wildcard_key(control.run_kind, control.owner_id, control.project_id)
        if project_wildcard_key != project_key and project_wildcard_key in self._monitors:
            merged_preference |= self._monitors[project_wildcard_key]

        # Global wildcard check (all tasks)
        if '*' in self._monitors:
            merged_preference |= self._monitors['*']

        # Send once with the merged preference
        if merged_preference:
            await _send_event(merged_preference)

        return

    async def _send_updates(
        self,
        control: 'TASK_CONTROL | None',
        prev: EVENT_TYPE,
        curr: EVENT_TYPE,
        project_id: str = None,
        source: str = None,
    ) -> None:
        """
        Send immediate catch-up events for newly enabled subscription bits.

        When a client subscribes to new event types (i.e. bits that were not
        previously set), this method sends the current state for those types
        so the client does not have to wait for the next natural event. This
        keeps clients in sync with the task even if they connect mid-run.

        Currently handled catch-up types:
        - SUMMARY: If the task is running, sends its current status snapshot.
          If the task is not running, sends an empty TASK_STATE.NONE status
          so the client can display a "not running" indicator.
        - TASK: Sends the list of all currently active tasks owned by this user,
          so the client knows which tasks are already in-progress.

        Args:
            control (TASK_CONTROL | None): The task control for the subscription,
                or None if the task is not currently running.
            prev (EVENT_TYPE): The bitmask of event types that were subscribed
                before this call (used to compute which bits are newly set).
            curr (EVENT_TYPE): The new bitmask of event types after the update.
            project_id (str, optional): Project identifier used to build an empty
                status payload when control is None.
            source (str, optional): Source component identifier used alongside
                project_id when control is None.
        """
        # Figure out what was just turned on
        new = curr & ~prev  # Bits that are in curr but NOT in prev

        # If we just turned on summary
        if new & EVENT_TYPE.SUMMARY:
            try:
                if control:
                    # Task is running: send current status
                    await self.send_event(
                        event='apaevt_status_update',
                        id=control.id,
                        body=control.task.get_status().model_dump(),
                    )
                elif project_id is not None and source is not None:
                    # Task is not running: send empty state so client shows "not running"
                    empty_status = TASK_STATUS(
                        state=TASK_STATE.NONE.value,
                        project_id=project_id,
                        source=source,
                        status='Not running',
                    )
                    await self.send_event(
                        event='apaevt_status_update',
                        id=f'{project_id}.{source}',
                        body=empty_status.model_dump(),
                    )
            except Exception:
                pass

        # If we just turned on task
        if new & EVENT_TYPE.TASK:
            try:
                # Loop through all active tasks the caller has access to
                tasks: List[Dict[str, Any]] = []
                for token, target in self._server._task_control.items():
                    # Skip runs the caller may not see (run-scoped: user-owned
                    # runs are owner-only; team runs need team membership)
                    if not resolve_run_permissions(self._account_info, target):
                        continue

                    # Get the task status once
                    status = target.task.get_status()

                    # Only include tasks that are "active" (not idle, not completed)
                    # Active states: STARTING(1), INITIALIZING(2), RUNNING(3), STOPPING(4)
                    # Exclude: NONE(0), COMPLETED(5), CANCELLED(6)
                    if status.state in [
                        TASK_STATE.STARTING.value,
                        TASK_STATE.INITIALIZING.value,
                        TASK_STATE.RUNNING.value,
                        TASK_STATE.STOPPING.value,
                    ]:
                        tasks.append(
                            {
                                'id': target.id,
                                'name': status.name,
                                'projectId': target.project_id,
                                'source': target.source,
                                # Identity stamps (parity with the per-event
                                # _forward_task_event stamp): clients attribute
                                # deploy runs to DEPLOYMENTS, never ad-hoc.
                                # Read from the CONTROL — the previous getattr
                                # fallbacks targeted fields that never existed
                                # on TASK_CONTROL, so every row reported a dev
                                # run with no team.
                                'runKind': target.run_kind,
                                'teamId': target.teamId if target.run_kind == 'deploy' else '',
                            }
                        )

                # We use the standard send event since we may not have a control
                await self.send_event(
                    event='apaevt_task',
                    body={
                        'action': 'running',
                        'tasks': tasks,
                    },
                )
            except Exception:
                pass

        # And done
        return

    async def set_monitor(
        self,
        token: str = None,
        project_id: str = None,
        source: str = None,
        pipe_id: int = None,
        type: EVENT_TYPE = EVENT_TYPE.NONE,
        team_id: str = '',
        run_kind: str = '',
    ) -> Dict[str, Any]:
        """
        Configure event monitoring subscription for a specific task.

        Updates the monitor registry to add, modify, or remove event subscriptions
        for a given task. This allows clients to dynamically control which events
        they receive from specific tasks.

        Subscription keys are owner-scoped (see :func:`owner_key`).
        ``team_id`` set addresses the team's deploy run; absent, the
        caller's OWN runs — the dev continuum by default, or the caller's
        personal (@me) deploy continuum when ``run_kind='deploy'``. A
        project/source subscription therefore only ever receives the
        caller's own events — a teammate's dev run is watchable only via
        its task token.

        Args:
            token (str): Unique identifier for the task to monitor
            project_id (str): Project scope (with source, instead of token)
            source (str): Source scope; '*' subscribes all sources
            pipe_id (int): Optional pipe narrowing
            type (EVENT_TYPE): Subscription bits
            team_id (str): Owner team — subscribe to that team's deploy run;
                empty subscribes the caller's own runs
            run_kind (str): Teamless scope selector: '' / 'dev' = the
                caller's dev runs; 'deploy' = the caller's personal @me
                deploy runs. Ignored when team_id is set (a team scope is
                always the deploy continuum).

        Returns:
            Dict[str, Any]: Status information about the subscription change

        Side Effects:
        - Updates internal _monitors registry
        - Logs subscription changes for debugging purposes
        - NONE type removes the subscription entirely from registry
        """
        control = None

        # If we are supposed to monitor all tasks...
        if token == '*':
            # Only token can be specified
            if project_id or source:
                raise ValueError('You must specifiy either token or project_id/source, not both')

            event_key = '*'
            event_id = None
            filter_name = '<all>'

        # If a token is specified, resolve it to project_id/source
        elif token:
            # Only token can be specified
            if project_id or source:
                raise ValueError('You must specifiy either token or project_id/source, not both')

            # Resolve the token to a project key
            control = self._server.get_task_control(token)

            # Verify the caller may reach this run (run-scoped: a user-owned
            # run is subscribable only by its owner; a team-owned run by
            # anyone with permissions on the run's team)
            if not resolve_run_permissions(self._account_info, control):
                raise PermissionError('Access denied: no permissions for this task')

            # Build the key from the resolved run's OWNER so subscribe and
            # delivery agree regardless of how the subscription was addressed
            event_key = owner_key(control.run_kind, control.owner_id, control.project_id, control.source)
            event_id = control.id
            filter_name = control.id

        # If project/source we specified
        elif project_id and source:
            # A team-scoped (deploy-run) subscription requires task.monitor on
            # THAT team, checked HERE. Subscribe-before-launch must not register
            # under a foreign team's key: the get_task_control_by_project check
            # below only fires when a run is LIVE; for a not-running foreign
            # scope it raises RuntimeError, which the except-Exception swallow
            # would let through, leaving the subscription registered under the
            # foreign key. (OSS-safe: the synthetic 'local' team grants monitor.)
            if team_id and 'task.monitor' not in resolve_task_permissions(self._account_info, team_id):
                raise PermissionError('Access denied: no permissions for this team')

            # run_kind, when supplied, must name a real continuum — but ONLY on
            # the teamless path. A team scope is always the deploy continuum
            # (teamId wins below), so run_kind is ignored there and must not
            # reject an otherwise valid team subscription. On the teamless path
            # a bogus run_kind would key under a 'p.<garbage>.' slot no run ever
            # matches, and invalid casing ('Deploy', 'DEV') silently forks a
            # dead subscription instead of aliasing the intended one. Absent =
            # the caller's dev continuum.
            if not team_id and run_kind and run_kind not in ('dev', 'deploy'):
                raise ValueError(f"invalid runKind {run_kind!r} — expected 'dev' or 'deploy'")

            # Resolve the requested scope's owner: the named team's deploy
            # run, or (no team) the CALLER's own runs — dev by default, or
            # the caller's personal @me deploy when runKind says so. teamId
            # WINS over runKind (a team scope is always the deploy
            # continuum) so an existing team subscription can never be
            # accidentally re-keyed into the dev continuum. The key is
            # derivable without the control so subscribe-before-launch works.
            owner_id = team_id if team_id else self._account_info.userId
            key_kind = 'deploy' if team_id else (run_kind or 'dev')
            event_key = owner_key(key_kind, owner_id, project_id, source)

            # If is ok if the task doesn't exist at this point in time...
            try:
                # Get the task (owner scoping + permission check inside)
                control = self._server.get_task_control_by_project(
                    project_id, source, self._account_info, require='task.monitor', team_id=team_id, run_kind=run_kind
                )

                # The task is running, we can fill it in
                event_id = control.id
                filter_name = control.id

            except PermissionError:
                raise

            except Exception:
                event_id = None
                filter_name = f'<Project:{project_id[:8]}.{source}>'

        else:
            # Invalid
            raise ValueError('You must specifiy either token or project_id/source')

        # If a pipe_id is specified, narrow the key to that specific pipe
        if pipe_id is not None and event_key != '*':
            event_key = f'{event_key}.{pipe_id}'
            filter_name = f'{filter_name}.pipe{pipe_id}'

        try:
            if type == EVENT_TYPE.NONE:
                # Unsubscribe: remove from monitor registry
                self._monitors.pop(event_key, None)
                self.debug_message(f'Removed monitoring for "{filter_name}"')

                await self._server.broadcast_server_event(
                    EVENT_TYPE.DASHBOARD,
                    {
                        'event': 'apaevt_dashboard',
                        'body': {
                            'action': 'monitor_changed',
                            'timestamp': time.time(),
                            'connectionId': self.get_connection_id(),
                            'clientName': self._client_info.get('name'),
                            'clientVersion': self._client_info.get('version'),
                            'key': filter_name,
                            'change': 'unsubscribed',
                        },
                    },
                    user_id=self._account_info.userId,
                )
            else:
                # Get the current type so we know what to update
                prev = self._monitors.get(event_key, EVENT_TYPE.NONE)

                # Subscribe or update: add/modify registry entry
                self._monitors[event_key] = type
                self.debug_message(f'Set "{filter_name}" monitoring to {type}')

                await self._server.broadcast_server_event(
                    EVENT_TYPE.DASHBOARD,
                    {
                        'event': 'apaevt_dashboard',
                        'body': {
                            'action': 'monitor_changed',
                            'timestamp': time.time(),
                            'connectionId': self.get_connection_id(),
                            'clientName': self._client_info.get('name'),
                            'clientVersion': self._client_info.get('version'),
                            'key': filter_name,
                            'change': 'subscribed',
                        },
                    },
                    user_id=self._account_info.userId,
                )

                # Send updates for what was missed (or empty state if task not running)
                await self._send_updates(control, prev, type, project_id=project_id, source=source)

            # Return the event id to put into the response
            return event_id

        except Exception as e:
            # Log subscription management errors
            self.debug_message(f'Error configuring monitoring: {str(e)}')
            raise

    async def on_rrext_monitor(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """
        Handle DAP 'rrext_monitor' command to establish or modify event subscriptions.

        This is the main entry point for clients to configure their event monitoring
        preferences. It processes the monitoring request, updates subscriptions,
        and optionally sends an immediate status update for active tasks.

        Args:
            request (Dict[str, Any]): DAP monitor request containing:
                - apikey: Authentication key for task access
                - token: Task identifier to monitor
                - arguments: Configuration options including:
                    - listenType: int with EVENT_TYPE bit flags

        Returns:
            Dict[str, Any]: DAP-compliant response acknowledging subscription change

        Workflow:
        1. Extract authentication and task identification from request
        2. Parse subscription preferences from request arguments
        3. Update monitor registry with new subscription settings
        4. Attempt to send immediate status update if task is active
        5. Return confirmation response to client

        Raises:
            Exception: If subscription setup or status update fails
        """

        def strings_to_bitmask(event_strings: List[str]) -> int:
            """
            Convert an array of event type name strings into a combined integer bitmask.

            Each string is matched case-insensitively against the EVENT_TYPE enum.
            Unrecognised strings are silently ignored (with a console warning) so that
            clients sending unknown type names do not cause a hard failure.

            Args:
                event_strings (List[str]): List of EVENT_TYPE member names, e.g.
                    ['SUMMARY', 'TASK', 'SSE'].

            Returns:
                int: OR-combination of the matching EVENT_TYPE values.
                    Returns 0 if the list is empty or all names are unrecognised.
            """
            bitmask = 0
            for event_str in event_strings:
                try:
                    # Convert string to enum and OR it into the bitmask
                    event_type = EVENT_TYPE[event_str.upper()]
                    bitmask |= event_type.value
                except KeyError:
                    print(f"Warning: Unknown event type '{event_str}' ignored")
            return bitmask

        # Verify permission
        token = self.get_task_token(request, 'task.monitor')

        # Parse monitoring configuration from request arguments
        args = request.get('arguments', {})

        # Get the project_id/source/pipeId if specified. Optional teamId
        # selects the team scope (that team's deploy run). Absent teamId is
        # the caller's OWN runs, where optional runKind picks the continuum:
        # absent/'dev' = dev runs (today's behavior), 'deploy' = the
        # caller's personal @me deploy runs — the ONE case teamId-presence
        # cannot express.
        project_id = args.get('projectId', None)
        source = args.get('source', None)
        pipe_id = args.get('pipeId', None)
        team_id = args.get('teamId') or ''
        run_kind = args.get('runKind') or ''

        # Determine the desired event subscription level
        types = args.get('types', None)

        # Handle string array, integer bitmask, and legacy listenType formats
        if isinstance(types, list):
            bitmask_value = strings_to_bitmask(types)
        elif isinstance(types, int):
            bitmask_value = types
        elif isinstance(types, str) and types.isdigit():
            bitmask_value = int(types)
        else:
            # Fallback to legacy listenType or no events
            listen_type = args.get('listenType', 0)
            bitmask_value = int(listen_type) if isinstance(listen_type, (int, float)) else 0

        # Create EVENT_TYPE enum from the bitmask
        event_type = EVENT_TYPE(bitmask_value)

        # Update the subscription registry
        await self.set_monitor(
            token=token,
            project_id=project_id,
            source=source,
            pipe_id=pipe_id,
            type=event_type,
            team_id=team_id,
            run_kind=run_kind,
        )

        # Acknowledge successful subscription setup
        return self.build_response(request)
