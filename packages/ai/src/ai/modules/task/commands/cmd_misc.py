"""
MiscCommands: DAP Command Handler for Miscellaneous Operations.

This module implements a Debug Adapter Protocol (DAP) command handler for
miscellaneous utility operations that don't fit into the core task, data,
monitoring, or debugging categories. It provides access to system-level
information and metadata services.

Primary Responsibilities:
--------------------------
1. Handles DAP 'apaext_services' command for service definition retrieval
2. Provides access to connector schemas, UI schemas, and metadata
3. Returns service information for pipeline configuration and validation

Architecture:
-------------
- Inherits from DAPConn to leverage DAP protocol handling
- Works in conjunction with TaskServer for server context
- Provides read-only access to service metadata
"""

from typing import TYPE_CHECKING, Dict, Any
from rocketlib import getServiceDefinitions, getServiceDefinition, validatePipeline
from ai.common.dap import DAPConn, TransportBase

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

    async def on_apaext_services(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """
        Handle DAP 'apaext_services' command to retrieve service definitions.

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
        - Get all services: { "command": "apaext_services" }
        - Get specific service: { "command": "apaext_services", "arguments": { "service": "ocr" } }
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

    async def on_apaext_validate(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """
        Handle DAP 'apaext_validate' command to validate a pipeline configuration.

        Validates pipeline structure, component compatibility, and connection
        integrity using rocketlib's validatePipeline function.

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
        { "command": "apaext_validate", "arguments": { "pipeline": { ... }, "source": "chat_1" } }
        """
        try:
            args = request.get('arguments', {})
            pipeline = args.get('pipeline', {})

            # Resolve source: explicit arg > pipeline field > implied from components
            source = args.get('source', None) or pipeline.get('source', None)
            if not source:
                for component in pipeline.get('components', []):
                    config = component.get('config', {})
                    if config.get('mode', '') == 'Source':
                        if source is not None:
                            raise ValueError('Pipeline has multiple source components, please specify one explicitly')
                        source = component.get('id', None)

            # Build the C++ payload with resolved source and default version
            inner = {**pipeline, 'version': pipeline.get('version', 1)}
            if source:
                inner['source'] = source

            data = validatePipeline({'pipeline': inner})

            return self.build_response(request, body=data)

        except Exception as e:
            self.debug_message(f'Pipeline validation failed: {str(e)}')
            raise
