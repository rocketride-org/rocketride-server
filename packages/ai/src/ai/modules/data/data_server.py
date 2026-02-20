"""
DataServer: WebSocket Proxy for DAP-Based Mid-Tier Data Operations.

This module implements the middle layer in a three-tier distributed data pipeline.
It serves as a proxy that forwards Debug Adapter Protocol (DAP) traffic over WebSockets
between clients (such as ALB servers) and backend data processing engines.

Primary Responsibilities:
--------------------------
1. Acts as the mid-tier of the pipeline stack, bridging the frontend ALB layer with backend engine nodes.
2. Accepts incoming WebSocket connections on `/data/service`.
3. On receiving a 'launch' command, it initiates a new backend data processor with the appropriate pipeline configuration.
4. On receiving an 'attach' command, it attaches the client to an existing backend data processing session.
5. On 'disconnect', it terminates the session and tears down associated WebSocket connections.
6. For all other DAP commands, it transparently proxies requests and responses.

Designed for integration with a FastAPI application and built on top of the ai.web debug server stack.
"""

from fastapi import WebSocket
from dataclasses import dataclass
from rocketlib import IEndpointBase
from ai.common.dap import DAPBase, TransportWebSocket
from .data_conn import DataConn


@dataclass
class DATA_CONTROL:
    token: str = ''
    apikey: str = ''


class DataServer(DAPBase):
    """
    DataServer manages incoming data processing connections over WebSocket/DAP.

    This server serves as the central hub for managing sessions in the
    distributed data processing pipeline. It maintains processor registries, handles client
    connections, and provides data operation lifecycle management including automatic cleanup
    of expired sessions.

    Responsibilities:
    - Accepting new WebSocket connections at `/data/service`
    - Creating DataConnection instances for each new client
    - Managing data processor registration and lifecycle
    - Broadcasting events to data operation monitors
    - Automatic cleanup of completed operations
    - Providing operation status and metrics

    Architecture:
        Client (Data Tools) → ALB → DataServer → Backend Data Engine
    """

    def __init__(self, target: IEndpointBase, **kwargs) -> None:
        """
        Initialize the DataServer with configuration and optional parameters.

        Args:
            target (IEndpointBase): The target endpoint for data operations.
            **kwargs: Additional arguments passed to parent DAPBase
        """
        # Save the target endpoint
        self._target = target

        # Initialize parent with server identification
        super().__init__(module='DATA-SERVER', **kwargs)

    async def _dapbase_on_connected(self, conn: DataConn) -> None:
        """
        Handle a new WebSocket connection by adding it to the active connections.

        This method is called when a new client connects to the server. It
        registers the connection and prepares it for receiving messages.

        Args:
            conn (DataConnection): The newly established WebSocket connection
        """
        # Log the new connection for debugging purposes
        self.debug_message('Data connection established')

    async def _dapbase_on_disconnected(self, conn: DataConn) -> None:
        """
        Handle a WebSocket disconnection by cleaning up the connection registry.

        This method is called when a client disconnects from the server. We need
        to remove the connection from processors and monitors, and if the operation
        was launched, not executed, auto stop it.

        Args:
            conn (DataConnection): The disconnected WebSocket connection
        """
        # Log the disconnection for debugging purposes
        self.debug_message('Data connection disconnected.')

    async def listen(self, websocket: WebSocket) -> None:
        """
        Accept an incoming WebSocket connection and start listening for messages.

        Listen is not a traditional receive loop. Since we are using
        FastAPI and websockets, listen has already established the connection
        so we just need to let the framework know we are connected. For
        a TCP/IP connection, this would be the equivalent of accepting
        the connection on a socket, and waiting for messages to be received.

        Args:
            websocket (WebSocket): The FastAPI WebSocket object.
        """
        # Create the transport and accept the connection
        transport = TransportWebSocket()

        # Allocate a new connection
        conn = DataConn(server=self, target=self._target, transport=transport)

        # Signal we are connected
        await self._dapbase_on_connected(conn)

        # Accept the connection and start servicing it. This will not
        # return until the connection is closed
        await transport.accept(websocket=websocket)

        # Signal we are disconnected
        await self._dapbase_on_disconnected(conn)
        return
