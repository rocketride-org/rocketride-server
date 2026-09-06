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
MiscCommands: DAP Command Handler for Miscellaneous Operations.

This module implements a Debug Adapter Protocol (DAP) command handler for
miscellaneous utility operations that don't fit into the core task, data,
monitoring, or debugging categories. It provides access to system-level
information and metadata services.

Primary Responsibilities:
--------------------------
1. Handles DAP 'rrext_services' command for service definition retrieval
2. Provides access to connector schemas, UI schemas, and metadata
3. Returns service information for pipeline configuration and validation
4. Handles DAP 'rrext_dashboard' for the full monitoring snapshot, plus
   'rrext_list_connections' / 'rrext_list_tasks' — paginated views of the
   same caller-scoped rows following the platform list-API convention

Architecture:
-------------
- Inherits from DAPConn to leverage DAP protocol handling
- Works in conjunction with TaskServer for server context
- Provides read-only access to service metadata
"""

import os
import time
from typing import TYPE_CHECKING, Dict, Any, List, Tuple
from rocketride import EVENT_TYPE
from rocketlib import getServiceDefinition, validatePipeline
from ai.common.config import Config
from ai.common.dap import DAPConn, TransportBase
from ai.common.list_rows import paginate_rows
from ai.account.models import resolve_task_permissions
from ..pipeline import resolve_implied_source, resolve_pipeline_env
from .. import services_catalog
from .cmd_monitor import owner_key

# Only import for type checking to avoid circular import errors
if TYPE_CHECKING:
    from ..task_server import TaskServer


# Component-level keys that are not node configuration. The engine validates and
# consumes these itself, so a profile does not discard them and an author must not be
# told to move them inside one.
_STRUCTURAL_CONFIG_KEYS = frozenset({'profile', 'parameters', 'secureParameters', 'name'})


def _service_profile_names(provider: str) -> frozenset:
    """Return every profile name the service declares, or an empty set.

    A config saved by an editor carries one sub-object per profile, so an unselected
    profile's own block would otherwise read as a key the resolver threw away.

    Args:
        provider: Component provider, e.g. 'llm_openai'.

    Returns:
        The declared profile names. Empty when the service or its preconfig is
        unavailable, which leaves the caller reporting the key rather than hiding it.
    """
    try:
        service = getServiceDefinition(provider)
        return frozenset((service or {}).get('preconfig', {}).get('profiles', {}) or {})
    except Exception:
        return frozenset()


class MiscCommands(DAPConn):
    """
    DAP command handler for miscellaneous utility commands.

    This class processes DAP commands for system-level utilities and metadata
    access. It provides a clean interface for clients to query service
    definitions, schemas, and other configuration information.

    Key Features:
    - Service definition retrieval (single or all services)
    - DAP-compliant request/response handling
    - Access to connector schemas and UI configuration

    Attributes:
        _server: Reference to the TaskServer for context
        connection_id: Unique identifier for this DAP connection
        transport: Underlying transport mechanism for DAP communication
    """

    def __init__(
        self,
        connection_id: int,
        server: 'TaskServer',
        transport: TransportBase,
        **kwargs,
    ) -> None:
        """
        Initialize a new MiscCommands instance.

        Sets up the miscellaneous command handler with a connection to the task
        management server and establishes the communication transport layer.

        Args:
            connection_id (int): Unique identifier for this DAP connection session
            server (TaskServer): The server instance for context and utilities
            transport (TransportBase): Communication transport layer for DAP messages
            **kwargs: Additional arguments passed to parent DAPConn constructor
        """
        pass

    async def on_rrext_services(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """
        Handle DAP 'rrext_services' command to retrieve service definitions.

        Serves the cached service catalog (see ``services_catalog``): the
        bulk call returns each service's SUMMARY — display fields plus the
        deduplicated ``icons`` table (each summary's ``icon`` field is an
        id into it) — which is everything a client needs to render the
        canvas. The single-service call returns the FULL entry with the
        configuration schema, fetched by the configure panel on demand.

        Args:
            request (Dict[str, Any]): DAP request containing:
                - arguments (Dict[str, Any], optional):
                    - service (str, optional): Name of specific service to retrieve

        Returns:
            Dict[str, Any]: DAP response containing:
                - body: If service specified, that service's full entry
                  (config schema included); otherwise
                  ``{'services': {name: summary}, 'icons': {id: svg}, 'version': N}``.

        Raises:
            Exception: If the specified service is not found

        Usage Examples:
        - Get all summaries: { "command": "rrext_services" }
        - Get one full entry: { "command": "rrext_services", "arguments": { "service": "ocr" } }
        """
        try:
            # Extract optional service name from request arguments
            args = request.get('arguments', {})
            service = args.get('service', None)

            # Installed node capsules the caller owns, read live from the store so a
            # node just installed appears in the palette with no reconnect. Best-effort:
            # a store failure never blocks the built-in catalog.
            from ai.account import Store
            from ai.account.node_install import installed_node_catalog, installed_node_definition

            if service:
                # Retrieve the full cached entry (config schema included)
                schema = await services_catalog.get_service(service)

                # Fall back to an installed capsule before declaring not-found.
                if not schema:
                    try:
                        schema = await installed_node_definition(Store.file_store(self.request_context()), service)
                    except Exception as e:
                        self.debug_message(f'node overlay lookup failed for {service!r}: {e}')

                # Validate the service exists
                if not schema:
                    raise ValueError(f"Service '{service}' not found. Please check the service name and try again.")
            else:
                # The cached summary view: display fields + inline icons
                schema = await services_catalog.get_summary()

                # Overlay the caller's installed nodes (built-ins win on collision).
                try:
                    overlay_services, overlay_icons = await installed_node_catalog(
                        Store.file_store(self.request_context())
                    )
                    if overlay_services:
                        schema = {
                            'services': {**overlay_services, **schema.get('services', {})},
                            'icons': {**schema.get('icons', {}), **overlay_icons},
                            'version': schema.get('version'),
                        }
                except Exception as e:
                    self.debug_message(f'node overlay failed (built-in catalog stands): {e}')

            # Return successful response with service definition(s)
            return self.build_response(request, body=schema)

        except Exception as e:
            # Log service retrieval failure with context
            self.debug_message(f'Failed to retrieve service definitions: {str(e)}')

            # Re-raise to let DAP error handling create proper error response
            raise

    async def on_rrext_validate(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """
        Handle DAP 'rrext_validate' command to validate a pipeline configuration.

        Validates pipeline structure using rocketlib's validatePipeline function.

        Before validation, ``${ROCKETRIDE_*}`` environment variable references
        are resolved using the same merged environment as pipeline execution,
        so that fields containing variable references validate correctly.

        Source resolution follows the same logic as execute:
        1. Explicit ``source`` argument (if provided)
        2. ``source`` field inside the pipeline config
        3. Implied source: the single component whose config.mode == 'Source'

        Args:
            request (Dict[str, Any]): DAP request containing:
                - arguments (Dict[str, Any]):
                    - pipeline (Dict[str, Any]): Pipeline configuration to validate
                    - source (str, optional): Override source component ID

        Returns:
            Dict[str, Any]: DAP response containing:
                - body: Validation result with errors, warnings, resolved
                  component, and execution chain

        Usage Example:
        { "command": "rrext_validate", "arguments": { "pipeline": { "components": [], ... }, "source": "chat_1" } }
        """
        try:
            from ai.account import account

            args = request.get('arguments', {})
            pipeline = args.get('pipeline', {})

            # Build merged environment for variable resolution (same as execute)
            merged_env: Dict[str, str] = {}
            if hasattr(self, '_account_info') and self._account_info:
                # Determine org and team IDs from account info
                org_id = ''
                team_id = getattr(self._account_info, 'defaultTeam', '') or ''
                org = getattr(self._account_info, 'organization', None)
                if org:
                    org_id = org.get('id', '') if isinstance(org, dict) else getattr(org, 'id', '')

                # sys.admin: seed with server RR_* keys mapped to ROCKETRIDE_*
                if 'sys.admin' in (self._account_info.sysPermissions or []):
                    merged_env = {'ROCKETRIDE_' + k[3:]: v for k, v in os.environ.items() if k.startswith('RR_')}

                # Layer org → team → user secrets on top
                merged_env.update(
                    await account.get_merged_env(
                        user_id=self._account_info.userId,
                        org_id=org_id,
                        team_id=team_id,
                    )
                )

            # Resolve ${ROCKETRIDE_*} variables before validation
            pipeline = resolve_pipeline_env(pipeline, merged_env)

            # Resolve source: explicit arg > pipeline field > implied from components
            source = args.get('source', None) or pipeline.get('source', None)
            if not source:
                source = resolve_implied_source(pipeline)

            # Build the C++ payload with resolved source and default version
            inner = {**pipeline, 'version': pipeline.get('version', 1)}
            if source:
                inner['source'] = source

            # Validate it
            data = validatePipeline(inner)

            # Return the results
            return self.build_response(request, body=data)

        except Exception as e:
            self.debug_message(f'Pipeline validation failed: {str(e)}')
            raise

    async def on_rrext_resolve_config(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """
        Handle DAP 'rrext_resolve_config' to resolve a component config as a node sees it.

        Runs the config through the same ``Config.getNodeConfig`` a node calls at
        load, so an author can see what the node actually receives rather than
        what the .pipe appears to say. This has to happen engine-side: the
        service catalog does not carry ``preconfig``, so profile resolution
        cannot be reproduced from ``rrext_services``.

        Args:
            request (Dict[str, Any]): DAP request containing:
                - arguments (Dict[str, Any]):
                    - provider (str): Component provider, e.g. 'llm_openai'.
                    - config (Dict[str, Any], optional): The component's config block.

        Returns:
            Dict[str, Any]: DAP response whose body carries:
                - provider (str): The provider that was resolved.
                - profile (str): The profile that applied, named or default.
                - resolved (Dict[str, Any]): What the node receives.
                - dropped (List[str]): Top-level config keys the resolver discarded.

        Raises:
            ValueError: If provider is missing or config is not an object.
            Exception: If the service is unknown or has no preconfig section.
        """
        try:
            args = request.get('arguments', {})
            provider = args.get('provider')
            if not provider:
                raise ValueError('provider is required')

            # Default only a genuinely absent config: `or {}` would coerce a
            # falsy non-object such as [] and skip the type check below.
            config = args.get('config')
            if config is None:
                config = {}
            if not isinstance(config, dict):
                raise ValueError('config must be an object')

            resolved = Config.getNodeConfig(provider, config)
            profile = config.get('profile')

            # Report the keys the resolver discarded rather than leaving the author
            # to infer it from an absence. With a profile set, getNodeConfig reads
            # the user layer only from the sub-object named after that profile, so
            # sibling top-level keys never reach the node (#1839).
            dropped = []
            if profile:
                # Every sibling of the selected profile is discarded, so the value is
                # not worth comparing: one that happens to match the profile's own is
                # still a line the resolver never read.
                #
                # Two kinds of sibling are not user config and must not be reported.
                # The structural keys below belong to the component, not the node, and
                # the engine consumes them on its own path (pipeline_config.cpp Rule 5
                # and Rule 6); telling an author to move them inside the profile would
                # break the component. An unselected profile's own sub-object is the
                # other: an editor-saved config keeps one per profile.
                profiles = _service_profile_names(provider)
                dropped = [k for k in config if k != profile and k not in _STRUCTURAL_CONFIG_KEYS and k not in profiles]

            body = {
                'provider': provider,
                'profile': profile or 'default',
                'resolved': resolved,
                'dropped': dropped,
            }
            return self.build_response(request, body=body)

        except Exception as e:
            self.debug_message(f'Config resolution failed for {request.get("arguments", {}).get("provider")}: {str(e)}')
            raise

    async def on_rrext_dashboard(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """
        Handle DAP 'rrext_dashboard' command to retrieve server dashboard data.

        Returns a snapshot of the server's current state including overview
        metrics, active connections, and task information for administrative
        monitoring dashboards.

        Args:
            request (Dict[str, Any]): DAP request (no arguments required)

        Returns:
            Dict[str, Any]: DAP response containing:
                - body.overview: Server-level aggregate metrics
                - body.connections: List of active connection details
                - body.tasks: List of task details with status and metrics
        """
        try:
            # Require monitor permission
            self.verify_permission('task.monitor')

            current_time = time.time()

            # Snapshot the caller-visible server state (permission + tk_ scoping)
            task_controls, conn_items = self._scoped_state()

            # Materialize the connection and task row lists via the shared builders
            connections = self._build_connection_rows(task_controls, conn_items, current_time)
            tasks = self._build_task_rows(task_controls, current_time)

            # Build overview — derive from sanitized tasks list to avoid
            # re-calling get_status() on potentially torn-down controls
            active_count = sum(1 for task in tasks if not task['completed'])
            start_time = getattr(self._server._server, '_startTime', None) or current_time
            overview = {
                'totalConnections': len(conn_items),
                'activeTasks': active_count,
                'serverUptime': current_time - start_time,
            }

            return self.build_response(
                request,
                body={
                    'overview': overview,
                    'connections': connections,
                    'tasks': tasks,
                },
            )

        except Exception as e:
            self.debug_message(f'Failed to retrieve dashboard data: {str(e)}')
            raise

    async def on_rrext_list_connections(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """
        Handle DAP 'rrext_list_connections' command: a paginated view of the
        caller's active connections following the platform list-API
        convention. Same permission gate and caller scoping as
        on_rrext_dashboard — connections are filtered to the caller's userId
        (and to the single owning connection under tk_ task-token auth).

        Args:
            request (Dict[str, Any]): DAP request containing:
                - arguments (Dict[str, Any], optional):
                    - page (int): 1-based page number (default 1)
                    - page_size (int): Rows per page (clamped 1..100, default 50)
                    - search (str): Free text over clientId / clientInfo /
                      attachedTasks / userName / orgName
                    - sort (List[Dict]): [{'field': <row key>, 'dir': 'asc'|'desc'}]
                    - filters (Dict): Flat {key: value} record — string means
                      contains/equality by the row value's type, array means
                      set membership, __gte/__lte suffixes carry range bounds

        Returns:
            Dict[str, Any]: DAP response containing:
                - body: { rows, total, page, pageSize } — rows carry the same
                  shape as the dashboard's connections list
        """
        try:
            # Require monitor permission (same gate as the dashboard snapshot)
            self.verify_permission('task.monitor')

            # Extract the list-convention arguments
            args = request.get('arguments', {}) or {}
            current_time = time.time()

            # Snapshot the caller-visible server state (permission + tk_ scoping)
            task_controls, conn_items = self._scoped_state()

            # Materialize the full row set, then apply search / filters /
            # sort / paging via the shared in-memory paginator
            rows = self._build_connection_rows(task_controls, conn_items, current_time)
            body = paginate_rows(
                rows,
                args,
                # Name-ish/text fields of a connection row (identity names
                # included so the grid search finds users and organizations)
                searchable_keys=('clientId', 'clientInfo', 'attachedTasks', 'userName', 'orgName'),
                # Default sort mirrors the dashboard's display order: the
                # connection registry iterates in registration order (oldest
                # first), i.e. ascending 'connectedAt'; the monotonic 'id'
                # row key is the deterministic tiebreak.
                default_sort=('connectedAt', 'asc'),
                tiebreak_key='id',
            )
            return self.build_response(request, body=body)

        except Exception as e:
            self.debug_message(f'Failed to list connections: {str(e)}')
            raise

    async def on_rrext_list_tasks(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """
        Handle DAP 'rrext_list_tasks' command: a paginated view of the
        caller's tasks following the platform list-API convention. Same
        permission gate and caller scoping as on_rrext_dashboard — tasks are
        limited to those resolve_task_permissions grants the caller (own,
        teammate, org admin; only the owning task under tk_ token auth).

        Args:
            request (Dict[str, Any]): DAP request containing:
                - arguments (Dict[str, Any], optional):
                    - page (int): 1-based page number (default 1)
                    - page_size (int): Rows per page (clamped 1..100, default 50)
                    - search (str): Free text over id / name / source /
                      provider / projectId
                    - sort (List[Dict]): [{'field': <row key>, 'dir': 'asc'|'desc'}]
                    - filters (Dict): Flat {key: value} record — string means
                      contains/equality by the row value's type, array means
                      set membership, __gte/__lte suffixes carry range bounds

        Returns:
            Dict[str, Any]: DAP response containing:
                - body: { rows, total, page, pageSize } — rows carry the same
                  shape as the dashboard's tasks list
        """
        try:
            # Require monitor permission (same gate as the dashboard snapshot)
            self.verify_permission('task.monitor')

            # Extract the list-convention arguments
            args = request.get('arguments', {}) or {}
            current_time = time.time()

            # Snapshot the caller-visible server state (permission + tk_ scoping)
            task_controls, _conn_items = self._scoped_state()

            # Materialize the full row set, then apply search / filters /
            # sort / paging via the shared in-memory paginator
            rows = self._build_task_rows(task_controls, current_time)
            body = paginate_rows(
                rows,
                args,
                # Name-ish/text fields of a task row
                searchable_keys=('id', 'name', 'source', 'provider', 'projectId'),
                # Default sort mirrors the dashboard's display order: the
                # task registry iterates in creation order (oldest first),
                # i.e. ascending 'startTime' (the row's launch timestamp);
                # the 'id' row key is the deterministic tiebreak.
                default_sort=('startTime', 'asc'),
                tiebreak_key='id',
            )
            return self.build_response(request, body=body)

        except Exception as e:
            self.debug_message(f'Failed to list tasks: {str(e)}')
            raise

    # =========================================================================
    # CALLER SCOPING + ROW BUILDERS (shared by dashboard and list commands)
    # =========================================================================

    def _scoped_state(self) -> Tuple[List[Any], List[Tuple[int, Any]]]:
        """
        Snapshot the server state visible to the calling account.

        Applies the shared caller scoping used by on_rrext_dashboard and the
        rrext_list_* commands: tasks the caller may monitor (own, teammate,
        org admin — via resolve_task_permissions) and connections owned by
        the caller's userId. Task-scoped tokens (tk_) narrow both lists to
        the single owning task/connection.

        Returns:
            Tuple[List[Any], List[Tuple[int, Any]]]:
                (task controls, [(connection id, connection), ...]).
        """
        server = self._server
        caller_user_id = self._account_info.userId

        # Snapshot tasks the caller has access to (own, teammate, org admin)
        task_controls = [
            c for c in server._task_control.values() if resolve_task_permissions(self._account_info, c.teamId)
        ]
        # Connections are user-scoped (not task-scoped), so filter by userId
        conn_items = [
            (cid, conn)
            for cid, conn in server._connections.items()
            if hasattr(conn, '_account_info') and conn._account_info and conn._account_info.userId == caller_user_id
        ]

        # Task-scoped tokens (tk_) can only see their own task
        caller_auth = self._account_info.auth if hasattr(self._account_info, 'auth') else ''
        if caller_auth.startswith('tk_'):
            task_controls = [c for c in task_controls if c.token == caller_auth]
            conn_items = [(cid, conn) for cid, conn in conn_items if cid == self._connection_id]

        return task_controls, conn_items

    def _build_connection_rows(
        self,
        task_controls: List[Any],
        conn_items: List[Tuple[int, Any]],
        current_time: float,
    ) -> List[Dict[str, Any]]:
        """
        Build the wire row dicts for a list of active connections.

        Each row carries the connection's identity, traffic counters, active
        monitor subscriptions (with human-friendly labels), and the display
        names of the tasks it is attached to. Identity is resolved
        server-side from the connection's AccountInfo: the stable userId, a
        human userName (displayName falling back to email), and the org
        membership (orgId/orgName). All four are None until the connection
        authenticates (and org keys stay None without an org membership).

        Args:
            task_controls (List[Any]): Caller-visible task controls (used to
                resolve monitor labels and attached-task names).
            conn_items (List[Tuple[int, Any]]): Caller-visible (id, conn) pairs.
            current_time (float): Timestamp used for fallback values.

        Returns:
            List[Dict[str, Any]]: One wire row per connection.
        """
        # Build connection-to-task mapping by scanning task controls
        conn_tasks: Dict[int, List[str]] = {}
        for control in task_controls:
            if control.task is None:
                continue
            try:
                status = control.task.get_status()
            except Exception as e:
                # Control torn down between snapshot and row build — skip it, the
                # same defensive stance _build_task_rows takes, so one dead task
                # never fails the whole connections/dashboard response.
                self.debug_message(f'Error reading task status for connection map "{control.id}": {e}')
                continue
            task_name = getattr(status, 'name', None) or control.source
            # Monitor keys are owner-scoped — build from the control's owner
            # (once per control; they do not vary per connection).
            project_key = owner_key(control.owner_id, control.project_id, control.source)
            project_wildcard_key = f'p.{control.owner_id}.{control.project_id}.*'
            pipe_prefix = f'{project_key}.'
            for cid, conn in conn_items:
                if not hasattr(conn, '_monitors'):
                    continue
                if (
                    project_key in conn._monitors
                    or project_wildcard_key in conn._monitors
                    or '*' in conn._monitors
                    or any(k.startswith(pipe_prefix) for k in conn._monitors)
                ):
                    conn_tasks.setdefault(cid, []).append(task_name)

        # Build project ID → friendly name map from task controls
        # so monitor keys like p.{uuid}.{source} can be displayed readably
        project_names: Dict[str, str] = {}
        source_names: Dict[str, str] = {}
        for control in task_controls:
            if control.task is None:
                continue
            try:
                status = control.task.get_status()
            except Exception as e:
                # Control torn down mid-snapshot — skip it (matches _build_task_rows).
                self.debug_message(f'Error reading task status for project map "{control.id}": {e}')
                continue
            task_name = getattr(status, 'name', None) or control.source
            # Use the task_name prefix (before the dot) as project label
            name_parts = task_name.split('.', 1)
            project_names.setdefault(control.project_id, name_parts[0])
            source_names.setdefault(
                f'{control.project_id}.{control.source}', name_parts[-1] if len(name_parts) > 1 else control.source
            )

        # Build connections list
        connections = []
        for conn_id, conn in conn_items:
            conn_info: Dict[str, Any] = {
                'id': conn_id,
                'connectedAt': getattr(conn, '_connected_at', current_time),
                'lastActivity': getattr(conn, '_last_activity', current_time),
                'messagesIn': getattr(conn, '_messages_in', 0),
                'messagesOut': getattr(conn, '_messages_out', 0),
                'authenticated': getattr(conn, '_authenticated', False),
                'clientId': None,
                # Resolved caller identity — all None until the connection
                # authenticates (unauthenticated connections carry no account).
                'userId': None,
                'userName': None,
                'orgId': None,
                'orgName': None,
                'clientInfo': getattr(conn, '_client_info', {}),
                'monitors': self._build_monitors_list(conn._monitors, project_names, source_names)
                if hasattr(conn, '_monitors')
                else [],
                'attachedTasks': conn_tasks.get(conn_id, []),
            }
            if hasattr(conn, '_account_info') and conn._account_info:
                account = conn._account_info
                conn_info['clientId'] = account.userId
                # Server-side identity resolution from AccountInfo: the stable
                # user id plus a human display name, preferring displayName and
                # falling back to the account email (None when both are empty).
                conn_info['userId'] = account.userId
                conn_info['userName'] = getattr(account, 'displayName', '') or getattr(account, 'email', '') or None
                # Org membership — AccountInfo.organization is an OrgInfo dict
                # (None when the user has no org); mirror on_rrext_validate's
                # dict/object dual handling for test doubles.
                org = getattr(account, 'organization', None)
                if org:
                    conn_info['orgId'] = org.get('id') if isinstance(org, dict) else getattr(org, 'id', None)
                    conn_info['orgName'] = org.get('name') if isinstance(org, dict) else getattr(org, 'name', None)
            connections.append(conn_info)

        return connections

    def _build_task_rows(
        self,
        task_controls: List[Any],
        current_time: float,
    ) -> List[Dict[str, Any]]:
        """
        Build the wire row dicts for a list of task controls.

        Each row carries the task's identity, launch info, timing (startTime
        plus a live elapsedTime for running tasks), completion state, and
        processing metrics. Controls whose status cannot be read (torn down
        mid-snapshot) are logged and skipped.

        Args:
            task_controls (List[Any]): Caller-visible task controls.
            current_time (float): Timestamp used to compute running elapsed time.

        Returns:
            List[Dict[str, Any]]: One wire row per readable task control.
        """
        # Build tasks list
        tasks = []
        for control in task_controls:
            try:
                task_status = control.task.get_status()
                start = getattr(task_status, 'startTime', 0) or 0
                end = getattr(task_status, 'endTime', 0) or 0
                completed = getattr(task_status, 'completed', False)
                if completed and start > 0 and end > 0:
                    elapsed = end - start
                elif start > 0:
                    elapsed = current_time - start
                else:
                    elapsed = 0

                # Convert Pydantic metrics model to plain dict for JSON serialization
                metrics_raw = getattr(task_status, 'metrics', None)
                metrics_dict = metrics_raw.model_dump() if hasattr(metrics_raw, 'model_dump') else metrics_raw

                tasks.append(
                    {
                        'id': control.id,
                        'name': getattr(task_status, 'name', control.source),
                        'projectId': control.project_id,
                        'source': control.source,
                        # Run classification stamp: dashboards and sidebars
                        # filter deploy runs out of dev views by this field.
                        'runKind': control.run_kind,
                        'provider': control.provider,
                        'launchType': control.launch_type.value,
                        'startTime': start,
                        'elapsedTime': elapsed,
                        'completed': completed,
                        'status': getattr(task_status, 'status', None) if not completed else None,
                        'exitCode': getattr(task_status, 'exitCode', None) if completed else None,
                        'endTime': end if completed else None,
                        'connections': control.task.get_connection_count(),
                        'state': getattr(task_status, 'state', 0),
                        'idleTime': getattr(control.task, '_idle_time', 0),
                        'ttl': getattr(control.task, '_ttl', 0),
                        'metrics': metrics_dict,
                        'totalCount': getattr(task_status, 'totalCount', 0),
                        'completedCount': getattr(task_status, 'completedCount', 0),
                        'rateCount': getattr(task_status, 'rateCount', 0),
                        'rateSize': getattr(task_status, 'rateSize', 0),
                    }
                )
            except Exception as e:
                self.debug_message(f'Error building task info for "{control.id}": {e}')
                continue

        return tasks

    @staticmethod
    def _mask_apikey(apikey: str) -> str:
        """Mask an API key for display, showing only first 4 and last 4 characters."""
        if not apikey or len(apikey) <= 8:
            return '****'
        return f'{apikey[:4]}****{apikey[-4:]}'

    @staticmethod
    def _build_monitors_list(
        monitors: Dict[str, 'EVENT_TYPE'],
        project_names: Dict[str, str],
        source_names: Dict[str, str],
    ) -> List[Dict[str, Any]]:
        """Convert the _monitors dict into a list of {key, flags} objects for the dashboard."""
        result = []
        for key, flags in monitors.items():
            flag_names = [f.name.lower() for f in EVENT_TYPE if f.value and f in flags]
            label = MiscCommands._resolve_monitor_label(key, project_names, source_names)
            result.append({'key': label, 'flags': flag_names})
        return result

    @staticmethod
    def _resolve_monitor_label(
        key: str,
        project_names: Dict[str, str],
        source_names: Dict[str, str],
    ) -> str:
        """Resolve a raw monitor key into a human-friendly label."""
        if key == '*':
            return 'All tasks'

        if not key.startswith('p.'):
            return 'Task monitor'

        # Strip the 'p.' prefix and split: ownerId, projectId, source, [pipeId]
        # (keys are owner-scoped: p.{teamId|userId}.{projectId}.{source})
        parts = key[2:].split('.', 3)
        if len(parts) < 2:
            return 'Task monitor'
        project_id = parts[1]
        project_label = project_names.get(project_id, project_id[:8])

        if len(parts) == 2 or (len(parts) == 3 and parts[2] == '*'):
            return f'{project_label}.*'

        source = parts[2]
        source_label = source_names.get(f'{project_id}.{source}', source)

        if len(parts) == 4:
            return f'{project_label}.{source_label}.pipe{parts[3]}'

        return f'{project_label}.{source_label}'
