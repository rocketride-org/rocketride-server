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

import asyncio
import threading
import time
from typing import TYPE_CHECKING, Optional
from fastapi import WebSocket
from dataclasses import dataclass
import engLib
from hosting import is_hosted
from rocketlib import IEndpointBase
from ai.common.dap import DAPBase, TransportWebSocket
from ai.account.base import OutOfCreditsError
from ai.constants import CONST_SPEND_ALLOW_SECONDS, CONST_SPEND_CHECK_TIMEOUT
from .data_conn import DataConn

if TYPE_CHECKING:
    from ai.web import WebServer


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

    def __init__(self, server: 'WebServer', **kwargs) -> None:
        """Initialize the DataServer with a back-reference for lazy target lookup.

        For sourceless pipelines (agentic, etc.) ``state.target`` is never
        set; ``_target`` returns ``None`` and data-bearing operations on
        ``DataConn`` raise a controlled error via ``_require_target()``.

        Args:
            server: The parent WebServer; used for lazy ``state.target`` reads.
            **kwargs: Additional arguments passed to the parent ``DAPBase``.
        """
        # Hold the server reference for lazy target lookup.
        self._server = server

        # A hosted task asks EaaS for credit before every getPipe()
        if is_hosted():
            engLib.setPipeGate(require_credit)

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
        conn = DataConn(server=self, transport=transport)

        # Signal we are connected
        await self._dapbase_on_connected(conn)

        # EaaS is the only peer of /task/data: its connection answers credit checks
        global _eaas
        _eaas = (conn, asyncio.get_running_loop())
        _eaas_connected.set()

        # Accept the connection and start servicing it. This will not
        # return until the connection is closed
        await transport.accept(websocket=websocket)

        if _eaas and _eaas[0] is conn:
            _eaas = None
            _eaas_connected.clear()

        # Signal we are disconnected
        await self._dapbase_on_disconnected(conn)
        return


# The EaaS data connection and the loop it runs on, while EaaS is connected
_eaas: 'tuple[DataConn, asyncio.AbstractEventLoop] | None' = None
_eaas_connected = threading.Event()

# Until when the last "allowed" answer stands, so a job asks once per window, not per object
_allowed_until = 0.0


def require_credit() -> None:
    """
    Engine pipe gate: raise OutOfCreditsError if this task's org may not open a pipe.

    It trusts the peer by position: whoever holds /task/data (loopback, the
    run's token) answers, and only EaaS opens it.
    """
    global _allowed_until
    if time.monotonic() < _allowed_until:
        return
    # EaaS connects once the task is up and again after a drop; no answer, no pipe
    _eaas_connected.wait(CONST_SPEND_CHECK_TIMEOUT)
    peer = _eaas
    if peer is None:
        raise RuntimeError('No credit check answered: EaaS is not connected to the task')
    conn, loop = peer
    asking = asyncio.run_coroutine_threadsafe(conn.ask_spend(), loop)
    try:
        refusal = asking.result(CONST_SPEND_CHECK_TIMEOUT)
    except TimeoutError:
        raise TimeoutError('No credit check answered: EaaS did not answer in time') from None
    finally:
        asking.cancel()  # no-op once answered; drops a question EaaS never answered
    if refusal:
        raise OutOfCreditsError(refusal)
    _allowed_until = time.monotonic() + CONST_SPEND_ALLOW_SECONDS
