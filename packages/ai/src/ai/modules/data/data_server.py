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

from typing import TYPE_CHECKING, Optional
import hashlib
import hmac
from fastapi import WebSocket
from dataclasses import dataclass
from starlette.websockets import WebSocketState
from rocketlib import IEndpointBase
from ai.common.dap import DAPBase, TransportWebSocket
from .data_conn import DataConn

if TYPE_CHECKING:
    from ai.web import WebServer

# Close code for a refused connection; before accept the client sees HTTP 403
CONST_DATA_REFUSED = 1008


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

    def __init__(self, server: 'WebServer', token_sha256: Optional[str] = None, **kwargs) -> None:
        """Initialize the DataServer with a back-reference for lazy target lookup.

        For sourceless pipelines (agentic, etc.) ``state.target`` is never
        set; ``_target`` returns ``None`` and data-bearing operations on
        ``DataConn`` raise a controlled error via ``_require_target()``.

        Args:
            server: The parent WebServer; used for lazy ``state.target`` reads.
            token_sha256: Hex SHA-256 of the run's channel token, which a
                connection must present; ``None`` refuses every connection.
            **kwargs: Additional arguments passed to the parent ``DAPBase``.
        """
        # Hold the server reference for lazy target lookup.
        self._server = server

        # Only the token's hash is known here; None fails closed
        self._token_sha256 = token_sha256

        # Socket currently holding the channel (one live connection at a time)
        self._live: Optional[WebSocket] = None

        # Initialize parent with server identification
        super().__init__(module='DATA-SERVER', **kwargs)

    @property
    def _target(self) -> Optional[IEndpointBase]:
        """Read the current target endpoint lazily from ``server.app.state``.

        Returns ``None`` if no source node has registered a target yet
        (e.g., for sourceless / agentic pipelines).
        """
        return getattr(self._server.app.state, 'target', None)

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

    def _authorized(self, websocket: WebSocket) -> bool:
        """
        Check the handshake's ``Authorization`` header against the run's token hash.

        Args:
            websocket (WebSocket): The connection, not yet accepted.

        Returns:
            bool: True when the SHA-256 of the presented token is this run's;
            False otherwise, and always False when the server has no hash.
        """
        if not self._token_sha256:
            return False

        presented = websocket.headers.get('authorization', '').removeprefix('Bearer ').strip()
        digest = hashlib.sha256(presented.encode('utf-8')).hexdigest()

        # Bytes, so a malformed non-ASCII expected value is a mismatch rather than a TypeError
        return hmac.compare_digest(digest.encode('ascii'), self._token_sha256.encode('utf-8'))

    def _channel_busy(self) -> bool:
        """
        Tell whether another connection holds the channel.

        The holder counts until either side has closed it, not until its
        handlers drain, so a reconnect is never blocked by a slow handler.

        Returns:
            bool: True while the holder is handshaking or open.
        """
        live = self._live
        if live is None:
            return False
        return WebSocketState.DISCONNECTED not in (live.client_state, live.application_state)

    async def listen(self, websocket: WebSocket) -> None:
        """
        Authenticate an incoming WebSocket connection, accept it and service it.

        The run's token is checked on the handshake, before accept: a
        connection without it, or arriving while another one is live, is
        closed unaccepted (HTTP 403) and never reaches a ``DataConn``.

        Listen is not a traditional receive loop. Since we are using
        FastAPI and websockets, listen has already established the connection
        so we just need to let the framework know we are connected. For
        a TCP/IP connection, this would be the equivalent of accepting
        the connection on a socket, and waiting for messages to be received.

        Args:
            websocket (WebSocket): The FastAPI WebSocket object.
        """
        if not self._authorized(websocket):
            self.debug_message('Data connection refused: missing or wrong token')
            await websocket.close(code=CONST_DATA_REFUSED)
            return

        if self._channel_busy():
            self.debug_message('Data connection refused: the channel is in use')
            await websocket.close(code=CONST_DATA_REFUSED)
            return

        # Claim the channel before the first await, so a concurrent handshake sees it
        self._live = websocket

        try:
            # Create the transport and accept the connection
            transport = TransportWebSocket()

            # Allocate a new connection
            conn = DataConn(server=self, transport=transport)

            # Signal we are connected
            await self._dapbase_on_connected(conn)

            # Accept the connection and start servicing it. This will not
            # return until the connection is closed
            await transport.accept(websocket=websocket)

            # Signal we are disconnected
            await self._dapbase_on_disconnected(conn)

        finally:
            # A newer connection may already hold the channel
            if self._live is websocket:
                self._live = None
