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

Architecture:
-------------
- Inherits from DAPConn to leverage DAP protocol handling
- Works in conjunction with TaskServer for server context
- Provides read-only access to service metadata
"""

import os
from typing import TYPE_CHECKING, Dict
from rocketlib import getServiceDefinitions, getServiceDefinition, validatePipeline
from ai.common.dap import DAPConn, TransportBase
from ai.account.models import RequestContext
from rocketride.types.client import DAPRequest, DAPResponse
from ..pipeline import resolve_implied_source, resolve_pipeline_env

# Only import for type checking to avoid circular import errors
if TYPE_CHECKING:
    from ..task_server import TaskServer


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

    async def on_rrext_services(self, request: DAPRequest, ctx: RequestContext) -> DAPResponse:
        """
        Handle DAP 'rrext_services' command to retrieve service definitions.

        This method provides access to connector service definitions including
        schemas, UI schemas, and other metadata. It can return either a single
        service definition by name or all available service definitions.

        Args:
            request (Dict[str, Any]): DAP request containing:
                - arguments (Dict[str, Any], optional):
                    - service (str, optional): Name of specific service to retrieve

        Returns:
            Dict[str, Any]: DAP response containing:
                - body: Service definition(s) as JSON object
                    - If service specified: single service definition
                    - If no service specified: all service definitions

        Raises:
            Exception: If the specified service is not found

        Usage Examples:
        - Get all services: { "command": "rrext_services" }
        - Get specific service: { "command": "rrext_services", "arguments": { "service": "ocr" } }
        """
        try:
            # Extract optional service name from request arguments
            args = request.get('arguments', {})
            service = args.get('service', None)

            if service:
                # Retrieve specific service definition by name
                schema = getServiceDefinition(service)

                # Validate the service exists
                if not schema:
                    raise ValueError(f"Service '{service}' not found. Please check the service name and try again.")
            else:
                # Retrieve all available service definitions
                schema = getServiceDefinitions()

            # Return successful response with service definition(s)
            return self.build_response(request, body=schema)

        except Exception as e:
            # Log service retrieval failure with context
            self.debug_message(f'Failed to retrieve service definitions: {str(e)}')

            # Re-raise to let DAP error handling create proper error response
            raise

    async def on_rrext_validate(self, request: DAPRequest, ctx: RequestContext) -> DAPResponse:
        """
        Handle DAP 'rrext_validate' command to validate a pipeline configuration.

        Validates pipeline structure, component compatibility, and connection
        integrity using rocketlib's validatePipeline function.

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
            if ctx.account_info:
                # Determine org and team IDs from account info
                org_id = ''
                team_id = getattr(ctx.account_info, 'defaultTeam', '') or ''
                org = getattr(ctx.account_info, 'organization', None)
                if org:
                    org_id = org.get('id', '') if isinstance(org, dict) else getattr(org, 'id', '')

                # sys.admin: seed with server RR_* keys mapped to ROCKETRIDE_*
                if 'sys.admin' in (ctx.account_info.sysPermissions or []):
                    merged_env = {'ROCKETRIDE_' + k[3:]: v for k, v in os.environ.items() if k.startswith('RR_')}

                # Layer org → team → user secrets on top
                merged_env.update(
                    await account.get_merged_env(
                        user_id=ctx.account_info.userId,
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

    @staticmethod
    def _mask_apikey(apikey: str) -> str:
        """Mask an API key for display, showing only first 4 and last 4 characters."""
        if not apikey or len(apikey) <= 8:
            return '****'
        return f'{apikey[:4]}****{apikey[-4:]}'
