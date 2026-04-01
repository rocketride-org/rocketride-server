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
    async with RocketRideClient(uri="http://localhost:8080", auth="your_api_key") as client:
        token = await client.use(filepath="pipeline.json")
        await client.send(token, "Hello, world!")

    # Chat with AI
    from rocketrideschema import Question
    question = Question()
    question.addQuestion("What is machine learning?")
    response = await client.chat(token="chat_token", question=question)
"""

import os
from .core import DAPClient, RocketRideException, CONST_DEFAULT_WEB_CLOUD
from .mixins.connection import ConnectionMixin
from .mixins.execution import ExecutionMixin
from .mixins.data import DataMixin
from .mixins.chat import ChatMixin
from .mixins.events import EventMixin
from .mixins.ping import PingMixin
from .mixins.services import ServicesMixin
from .mixins.dashboard import DashboardMixin

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
        # Async context manager (recommended)
        async with RocketRideClient(uri="http://localhost:8080", auth="your_api_key") as client:
            # Client is automatically connected
            token = await client.use(filepath="my_pipeline.json")
            result = await client.send(token, "Process this data")

        # Using environment variables
        # Set ROCKETRIDE_URI and ROCKETRIDE_APIKEY in environment or .env file
        async with RocketRideClient() as client:
            # Will use environment variables
            token = await client.use(filepath="my_pipeline.json")

        # Manual connection management
        client = RocketRideClient(uri="http://localhost:8080", auth="your_api_key")
        await client.connect()
        try:
            # Your operations here
            pass
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
            # Use the provided env dictionary
            self._env = dict(env)

        # If we didn't get the URI, look at the env. If not there,
        # use the default
        if not uri:
            uri = self._env.get('ROCKETRIDE_URI', CONST_DEFAULT_WEB_CLOUD)

        if not auth:
            auth = self._env.get('ROCKETRIDE_APIKEY', None)

        # Normalize the URI into a fully-formed WebSocket address
        from .mixins.connection import ConnectionMixin

        self._uri = ConnectionMixin._get_websocket_uri(uri)
        self._apikey = auth

        # Initialize chat question counter
        self._next_chat_id = 1

        # Synchronous mode support (advanced usage)
        self._loop = None
        self._thread = None

        # Debug Adapter Protocol integration
        self._dap_attempted = False
        self._dap_send = None

        # Create unique client identifier
        client_name = f'CLIENT-{client_id}'
        client_id += 1

        # Client identification for auth handshake
        self._client_display_name = kwargs.get('client_name', None)
        self._client_display_version = kwargs.get('client_version', None)

        # Initialize the underlying DAP client; transport is created in _internal_connect
        super().__init__(transport=None, module=kwargs.get('module', client_name), **kwargs)

    # Context manager support for automatic connection handling
    async def __aenter__(self):
        """
        Enter async context manager - automatically connects to server.

        Returns:
            self: The connected client instance
        """
        await self.connect()
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        """
        Exit async context manager - automatically disconnects from server.
        """
        await self.disconnect()
