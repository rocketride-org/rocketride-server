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
RocketRide Python Client - Main Interface.

This module provides the primary RocketRideClient class for interacting with RocketRide servers.
Use this client to connect to RocketRide services, execute pipelines, chat with AI, and manage data operations.

Basic Usage:
    # Connect and execute a pipeline
    client = RocketRideClient(uri="http://localhost:8080")
    result = await client.connect("your_api_key")
    token = await client.use(filepath="pipeline.json")
    await client.send(token, "Hello, world!")
    await client.disconnect()

    # Chat with AI
    from rocketrideschema import Question
    question = Question()
    question.addQuestion("What is machine learning?")
    response = await client.chat(token="chat_token", question=question)
"""

import os
from functools import cached_property
from .core import DAPClient, RocketRideException, CONST_DEFAULT_WEB_CLOUD
from .account import AccountApi
from .billing import BillingApi
from .mixins.connection import ConnectionMixin
from .mixins.execution import ExecutionMixin
from .mixins.data import DataMixin
from .mixins.chat import ChatMixin
from .mixins.events import EventMixin
from .mixins.ping import PingMixin
from .mixins.services import ServicesMixin
from .mixins.dashboard import DashboardMixin
from .mixins.store import StoreMixin
from typing import Callable, TYPE_CHECKING

if TYPE_CHECKING:
    from .types.client import DAPMessage, ServerInfoResult

# Module-level counter used to generate unique client identifiers (CLIENT-0, CLIENT-1, …)
# so multiple client instances running in the same process are distinguishable in logs.
client_id = 0

__all__ = [
    'RocketRideClient',
    'RocketRideException',
]


class RocketRideClient(
    ConnectionMixin,
    ExecutionMixin,
    DataMixin,
    ChatMixin,
    EventMixin,
    PingMixin,
    ServicesMixin,
    DashboardMixin,
    StoreMixin,
    DAPClient,
):
    """
    Main RocketRide client for connecting to RocketRide servers and services.

    This client combines all functionality needed to work with RocketRide:
    - Connection management (connect/disconnect)
    - Pipeline execution (start, monitor, terminate pipelines)
    - Data operations (send data, upload files, streaming)
    - AI chat functionality (ask questions, get responses)
    - Event handling (monitor pipeline progress, receive notifications)
    - Server connectivity testing (ping operations)

    The client supports both synchronous and asynchronous usage patterns
    and can be used as a context manager for automatic connection handling.

    Args:
        uri (str, optional): Service URI of the RocketRide server (e.g., "http://localhost:8080").
            If not provided, uses ROCKETRIDE_URI environment variable or default service.
        auth (str, optional): Your API key or access token for authentication.
            If not provided, uses ROCKETRIDE_APIKEY environment variable. Required at connect time.
        **kwargs: Additional configuration options like custom module name

    Raises:
        ValueError: If auth is not provided and ROCKETRIDE_APIKEY env var is not set
        ConnectionError: If unable to connect to the specified server

    Example:
        # Explicit connection management
        client = RocketRideClient(uri="http://localhost:8080")
        result = await client.connect("your_api_key")  # returns ConnectResult
        try:
            token = await client.use(filepath="my_pipeline.json")
            await client.send(token, "Process this data")
        finally:
            await client.disconnect()

        # Using ROCKETRIDE_APIKEY env var (connect() falls back to it when no credential given)
        client = RocketRideClient()
        result = await client.connect()
        try:
            token = await client.use(filepath="my_pipeline.json")
        finally:
            await client.disconnect()
    """

    def __init__(
        self,
        uri: str = '',
        auth: str = '',
        **kwargs,
    ):
        """
        Create a new RocketRide client instance.

        Args:
            uri: WebSocket URI of your RocketRide server (e.g., "ws://localhost:8080").
                Optional; uses ROCKETRIDE_URI from env or .env if empty.
            auth: Your API key or access token. Optional; uses ROCKETRIDE_APIKEY from env or .env if empty.
            **kwargs: Additional options:
                - env: Dictionary of environment variables to use instead of os.environ
                - module: Custom module name for client identification
                - request_timeout: Default timeout in ms for individual requests (default: no timeout)
                - max_retry_time: Max total time in ms to keep retrying connections (default: forever)
                - persist: Enable automatic reconnection with exponential backoff (default: False)
                - on_protocol_message: Callable[[str], None] for logging raw DAP messages
                - on_debug_message: Callable[[str], None] for debug output

        Raises:
            ValueError: If URI is empty or not a string
        """
        global client_id

        # Get or load environment variables
        env = kwargs.get('env', None)
        if env is None:
            # Start with process environment so ROCKETRIDE_* vars work out of the box.
            self._env = dict(os.environ)

            # Try to load .env file
            try:
                # Resolve the .env path relative to the current working directory
                env_path = os.path.join(os.getcwd(), '.env')
                if os.path.exists(env_path):
                    with open(env_path, 'r', encoding='utf-8') as f:
                        for line in f:
                            line = line.strip()
                            # Skip comments and empty lines
                            if not line or line.startswith('#'):
                                continue
                            # Parse KEY=VALUE format
                            if '=' in line:
                                key, value = line.split('=', 1)
                                key = key.strip()
                                value = value.strip()
                                # Remove quotes if present
                                if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
                                    value = value[1:-1]
                                # Preserve already-defined process env values.
                                self._env.setdefault(key, value)
            except Exception:
                # File doesn't exist or can't be read - that's okay
                pass
        else:
            # Use the provided env dictionary; copy it so the caller's dict is not mutated
            self._env = dict(env)

        # If we didn't get the URI, look at the env. If not there,
        # use the default
        if not uri:
            uri = self._env.get('ROCKETRIDE_URI', CONST_DEFAULT_WEB_CLOUD)

        # If no explicit auth credential was given, fall back to the environment variable
        if not auth:
            auth = self._env.get('ROCKETRIDE_APIKEY', None)

        # Normalize the URI into a fully-formed WebSocket address
        from .mixins.connection import ConnectionMixin

        # Convert the HTTP/HTTPS URI (or bare host:port) to a wss:// or ws:// URI
        # pointing at the /task/service WebSocket endpoint.
        self._uri = ConnectionMixin._get_websocket_uri(uri)
        self._apikey = auth

        # Initialize chat question counter — each chat request gets a unique sequential ID
        self._next_chat_id = 1

        # Synchronous mode support (advanced usage)
        self._loop = None  # background event loop thread for sync wrappers
        self._thread = None  # background thread that runs the event loop

        # Debug Adapter Protocol integration
        self._dap_attempted = False  # True once the DAP layer has attempted a connection
        self._dap_send = None  # Optional callable injected by DAP tooling to intercept sends

        # Create unique client identifier
        client_name = f'CLIENT-{client_id}'
        client_id += 1

        # Client identification for auth handshake
        from rocketride import __version__

        # Use caller-supplied display name/version if provided; fall back to SDK defaults
        self._client_display_name = kwargs.get('client_name', None) or 'Python SDK'
        self._client_display_version = kwargs.get('client_version', None) or __version__

        # Trace callback for observing all call() traffic
        self._on_trace: 'Callable[[int, DAPMessage], None] | None' = kwargs.get('on_trace', None)

        # Initialize the underlying DAP client; transport is created in _internal_connect
        super().__init__(transport=None, module=kwargs.get('module', client_name), **kwargs)

    # =========================================================================
    # CALL — PUBLIC DAP COMMAND INTERFACE
    # =========================================================================

    # Trace type constants (mirrors TypeScript TraceType enum)
    TRACE_REQUEST = 0
    TRACE_SUCCESS = 1
    TRACE_ERROR = 2

    async def call(self, command: str, *, token: str = None, timeout: float = None, **kwargs) -> dict:
        """
        Send a DAP command, unwrap the response body, and raise on failure.

        This is the single public entry point for all typed DAP operations.
        The :attr:`account` and :attr:`billing` namespaces delegate here.

        If an ``on_trace`` callback was provided in the constructor kwargs,
        it is invoked before the request (TRACE_REQUEST) and after completion
        (TRACE_SUCCESS or TRACE_ERROR).

        Args:
            command: DAP command name (e.g. "rrext_account_me").
            token: Optional task/session token for scoped calls.
            timeout: Optional per-request timeout in ms.
            **kwargs: Key/value arguments forwarded in the request.

        Returns:
            The ``body`` field of a successful DAP response.

        Raises:
            RuntimeError: If the server signals failure.
        """
        # Build the raw DAP request
        message = self.build_request(command=command, token=token, arguments=kwargs)

        # Trace: outbound request
        if self._on_trace:
            self._on_trace(self.TRACE_REQUEST, message)

        response = await self.request(message, timeout=timeout)

        if self.did_fail(response):
            if self._on_trace:
                self._on_trace(self.TRACE_ERROR, response)
            raise RuntimeError(response.get('message', f'{command} failed'))

        # Trace: success response
        if self._on_trace:
            self._on_trace(self.TRACE_SUCCESS, response)

        return response.get('body') or {}

    # =========================================================================
    # NAMESPACED API ACCESSORS
    # =========================================================================

    @cached_property
    def account(self) -> AccountApi:
        """Account management operations (profile, keys, org, members, teams)."""
        return AccountApi(self)

    @cached_property
    def billing(self) -> BillingApi:
        """Billing and subscription operations (plans, checkout, credits)."""
        return BillingApi(self)

    # =========================================================================
    # SERVER INFO — PRE-AUTH PROBE
    # =========================================================================

    @staticmethod
    async def get_server_info(uri: str, timeout: float = None) -> 'ServerInfoResult':
        """
        Probe a server for its capabilities without authenticating.

        Opens a WebSocket, sends an ``auth`` request with ``infoOnly: True``,
        and returns the server's version, capabilities, and platform. The
        connection is closed immediately after.

        Uses transport-only connect (no auth handshake) because the normal
        ``connect()`` bundles transport open + auth with credentials — here we
        need to send our own ``auth`` message with ``infoOnly`` instead.

        Args:
            uri: Server URI (e.g. ``"localhost:5565"`` or ``"https://cloud.example.com"``).
            timeout: Optional timeout in milliseconds for the entire operation.

        Returns:
            A :class:`~rocketride.types.ServerInfoResult` dict with ``version``,
            ``capabilities``, and ``platform`` keys.

        Raises:
            RuntimeError: If the server is unreachable or does not support info probes.

        Example::

            info = await RocketRideClient.get_server_info('localhost:5565')
            if 'saas' in info.get('capabilities', []):
                # Show cloud sign-in options
                pass
        """
        from .core.transport_websocket import TransportWebSocket

        # Build a throwaway client — no auth credential needed for info probes
        client = RocketRideClient(uri=uri, auth='', persist=False)
        try:
            # Open the transport without the normal auth handshake —
            # connect() would send auth with credentials, but we need to
            # send our own auth message with infoOnly instead.
            client._transport = TransportWebSocket(uri=client._uri, auth='')
            client._bind_transport(client._transport)
            await client._transport.connect(timeout)

            # Send auth with infoOnly flag — server returns metadata without authenticating
            message = client.build_request('auth', arguments={'infoOnly': True})
            response = await client.request(message, timeout=timeout)

            if client.did_fail(response):
                raise RuntimeError(response.get('message', 'Server info request failed'))

            return response.get('body', {})
        finally:
            await client.disconnect()
