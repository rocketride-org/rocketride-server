"""
DataCommands: DAP Data Processing Interface for Task Communication.

This module implements a DAP-based data processing interface that enables clients
to send data processing requests to active computational tasks. It serves as the
communication bridge for data exchange between DAP clients and running task instances,
facilitating real-time data processing and response handling.

Primary Responsibilities:
--------------------------
1. Handles DAP 'apaext_process' commands for data processing requests
2. Manages authentication and task identification for data access
3. Ensures tasks are in running state before processing data requests
4. Forwards data processing requests to appropriate task instances
5. Returns processed results back to requesting clients via DAP protocol
6. Provides error handling and logging for data processing operations

Use Cases:
----------
- Real-time data analysis requests to running computational tasks
- Interactive data processing sessions with task instances
- Client-server data exchange in distributed computing environments
- Dynamic data queries and transformations on active tasks

Architecture:
-------------
This module works in conjunction with TaskServer to:
- Authenticate clients using API keys
- Locate and validate target task instances
- Ensure task readiness before data processing
- Facilitate bidirectional data communication
- Handle processing errors and edge cases
"""

from typing import TYPE_CHECKING, Dict, Any
from ai.common.dap import DAPConn, TransportBase

# Only import for type checking to avoid circular import errors
if TYPE_CHECKING:
    from ..task_server import TaskServer


class DataCommands(DAPConn):
    """
    DAP command handler for data processing requests to computational tasks.

    This class processes DAP 'apaext_process' commands to facilitate data exchange
    between clients and running task instances. It handles authentication,
    task validation, and data forwarding while maintaining DAP protocol
    compliance for seamless integration with debugging and monitoring tools.

    Key Features:
    - Authenticated data processing requests using API keys
    - Task state validation before processing (ensures tasks are running)
    - Direct data forwarding to target task instances
    - Error handling with comprehensive logging
    - DAP-compliant request/response handling

    Workflow:
    1. Receive 'apaext_process' DAP command from client
    2. Extract authentication credentials and task identification
    3. Validate task exists and is in running state
    4. Forward data processing request to target task
    5. Return processed results to client
    6. Handle and log any processing errors

    Attributes:
        _server: Reference to TaskServer for task lookup and management
        connection_id: Unique identifier for this data processing connection
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
        Initialize a new DataCommands instance for data processing operations.

        Sets up the data processing command handler with connection to the
        task management server and establishes the DAP communication transport.

        Args:
            connection_id (int): Unique identifier for this data processing connection
            server (TaskServer): The server instance managing task lifecycle and access
            transport (TransportBase): Communication transport layer for DAP messages
            **kwargs: Additional arguments passed to parent DAPConn constructor
        """
        pass

    async def on_apaext_process(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """
        Handle DAP 'apaext_process' command for data processing requests.

        This method processes data processing requests by locating the target task,
        ensuring it's in a running state, and forwarding the data processing request
        to the task instance. It handles the complete request lifecycle from
        authentication through response delivery.

        Args:
            request (Dict[str, Any]): DAP data processing request containing:
                - apikey: Authentication key for task access control
                - token: Unique identifier for the target task instance
                - arguments: Data processing parameters and payload (task-specific)

        Returns:
            Dict[str, Any]: Response from the task's data processing operation,
                          which may contain:
                          - Processed data results
                          - Status information
                          - Task-specific response payload

        Workflow:
        1. Extract authentication credentials (apikey) and task identifier (token)
        2. Locate the target task instance using server registry
        3. Wait for task to reach running state (blocks until ready)
        4. Forward the complete request to task's data processing method
        5. Return the task's response directly to the client
        6. Handle and log any errors that occur during processing

        Raises:
            Exception: If task lookup fails, task is not accessible, task cannot
                      reach running state, or data processing operation fails

        Note:
        - This method blocks until the target task is in running state
        - The actual data processing logic is implemented by the task instance
        - Error details are logged for debugging but original exceptions are re-raised
        - Response format is determined by the individual task's processing logic
        """
        try:
            # Locate the target task instance using authentication and token
            task = self.get_task(request, 'task.data')

            # Ensure the task is ready to process data (blocks until running)
            # This is critical as tasks may be in startup, initialization, or other states
            await task.wait_for_running()

            # Forward the complete data processing request to the task instance
            # The task's _send_data method handles the actual processing logic
            response = await task._send_data(request)

            return response

        except Exception as e:
            # Log data processing failure with context for debugging
            self.debug_message(f'Failed to process data request: {str(e)}')

            # Re-raise the exception to maintain error propagation to client
            raise
