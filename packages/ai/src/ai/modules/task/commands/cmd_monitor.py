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

from typing import TYPE_CHECKING, Dict, Any, List
from ai.common.dap import DAPConn, TransportBase
from rocketride import EVENT_TYPE, TASK_STATE, TASK_STATUS

# Only import for type checking to avoid circular import errors
if TYPE_CHECKING:
    from ..task_server import TaskServer, TASK_CONTROL


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

    async def forward_event(
        self,
        type: EVENT_TYPE,
        token: str,
        event: Dict[str, Any],
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
            # If this is not being listened for, skip the forwarding
            if not (type & pref):
                return

            # Extract event details for DAP-compliant forwarding
            event_type = event.get('event', 'unknown')
            body = event.get('body', None)

            # Send the event to the subscribed client using DAP protocol
            await self.send_event(
                event_type,
                id=control.id,
                body=body,
            )

        # Get the task by token
        control = self._server.get_task_control(token)

        # Verify we are allowed to receive events for this task
        self.verify_permission('task.monitor')

        # Verify that this notification is going to the correct apikey
        if control.apikey != self._account_info.apikey:
            return

        # Check if any monitor is subscribed to this project/source
        project_key = f'p.{control.project_id}.{control.source}'
        if project_key in self._monitors:
            # Get the subscriber's event type for this specific token
            subscriber_preference = self._monitors[project_key]
            await _send_event(subscriber_preference)

        if '*' in self._monitors:
            # Get the subscriber preference for all tokens
            subscriber_preference = self._monitors['*']
            await _send_event(subscriber_preference)

        return

    async def _send_updates(
        self,
        control: 'TASK_CONTROL | None',
        prev: EVENT_TYPE,
        curr: EVENT_TYPE,
        project_id: str = None,
        source: str = None,
    ) -> None:
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
                # Get our api key
                apikey = self._account_info.apikey

                # Loop through all the active tasks and, for matching apikeys,
                # send an event that they are running
                tasks: List[Dict[str, Any]] = []
                for token, target in self._server._task_control.items():
                    # If this is not ours, skip it
                    if target.apikey != apikey:
                        continue

                    # Get the task state
                    state = target.task.get_status().state

                    # Only include tasks that are "active" (not idle, not completed)
                    # Active states: STARTING(1), INITIALIZING(2), RUNNING(3), STOPPING(4)
                    # Exclude: NONE(0), COMPLETED(5), CANCELLED(6)
                    if state in [TASK_STATE.STARTING.value, TASK_STATE.INITIALIZING.value, TASK_STATE.RUNNING.value, TASK_STATE.STOPPING.value]:
                        # Now, append it
                        tasks.append(
                            {
                                'id': target.id,
                                'projectId': target.project_id,
                                'source': target.source,
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
        type: EVENT_TYPE = EVENT_TYPE.NONE,
    ) -> Dict[str, Any]:
        """
        Configure event monitoring subscription for a specific task.

        Updates the monitor registry to add, modify, or remove event subscriptions
        for a given task. This allows clients to dynamically control which events
        they receive from specific tasks.

        Args:
            token (str): Unique identifier for the task to monitor
            type (EVENT_TYPE): Subscription bits

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

            # Use the project key so subscribe/unsubscribe by token or project_id/source use the same key
            event_key = f'p.{control.project_id}.{control.source}'
            event_id = control.id
            filter_name = control.id

        # If project/source we specified
        elif project_id and source:
            # Get the project key
            event_key = f'p.{project_id}.{source}'

            # If is ok if the task doesn't exist at this point in time...
            try:
                # Get the task
                control = self._server.get_task_control_by_project(project_id, source)

                # The task is running, we can fill it in
                event_id = control.id
                filter_name = control.id

            except Exception:
                event_id = None
                filter_name = f'<Project:{project_id[:8]}.{source}>'

        else:
            # Invalid
            raise ValueError('You must specifiy either token or project_id/source')

        try:
            if type == EVENT_TYPE.NONE:
                # Unsubscribe: remove from monitor registry
                self._monitors.pop(event_key, None)
                self.debug_message(f'Removed monitoring for "{filter_name}"')
            else:
                # Get the current type so we know what to update
                prev = self._monitors.get(event_key, EVENT_TYPE.NONE)

                # Subscribe or update: add/modify registry entry
                self._monitors[event_key] = type
                self.debug_message(f'Set "{filter_name}" monitoring to {type}')

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
            """Convert array of event type strings to bitmask."""
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

        # Get the project_id/source if specified
        args = request.get('arguments', {})
        project_id = args.get('projectId', None)
        source = args.get('source', None)

        # Parse monitoring configuration from request arguments
        args = request.get('arguments', {})

        # Determine the desired event subscription level
        types = args.get('types', None)

        # Handle both integer bitmask and string array formats
        if types and isinstance(types, list):
            # Client sent array of strings - convert to bitmask
            bitmask_value = strings_to_bitmask(types)

        else:
            # Fallback to no events
            bitmask_value = 0

        # Create EVENT_TYPE enum from the bitmask
        event_type = EVENT_TYPE(bitmask_value)

        # Update the subscription registry
        await self.set_monitor(
            token=token,
            project_id=project_id,
            source=source,
            type=event_type,
        )

        # Acknowledge successful subscription setup
        return self.build_response(request)
