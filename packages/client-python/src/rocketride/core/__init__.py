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
Core Components for RocketRide Client.

This module provides the foundational components that power the RocketRide client:
    - DAP (Debug Adapter Protocol) base classes and client implementation
    - WebSocket transport layer for server communication
    - Exception classes for structured error handling
    - Core constants and configuration values

These components are used internally by the RocketRideClient and typically don't need
to be imported directly unless you're extending the client or implementing custom
transport layers.

Components:
    DAPBase: Base class providing DAP messaging and logging capabilities
    DAPClient: Client implementation of the Debug Adapter Protocol
    TransportBase: Abstract base class for transport implementations
    TransportWebSocket: WebSocket transport for client-server communication
    RocketRideException: Base exception class for all RocketRide operations
    ConnectionException: Raised for connection-related errors
    PipeException: Raised for data pipe operation errors
    ExecutionException: Raised for pipeline execution errors
    ValidationException: Raised for input validation failures

Usage:
    # These are typically used internally, but can be imported for advanced use cases
    from rocketride.core import DAPClient, TransportWebSocket, RocketRideException
"""

from .dap import DAPBase, DAPClient
from .transport import TransportBase, TransportWebSocket
from .runtime import RuntimeManager, StateDB, DockerRuntime
from .constants import (
    CONST_DEFAULT_SERVICE,
    CONST_DEFAULT_WEB_CLOUD,
    CONST_DEFAULT_WEB_HOST,
    CONST_DEFAULT_WEB_LOCAL,
    CONST_DEFAULT_WEB_PORT,
    CONST_DEFAULT_WEB_PROTOCOL,
    CONST_SOCKET_TIMEOUT,
)
from .exceptions import (
    DAPException,
    RocketRideException,
    ConnectionException,
    AuthenticationException,
    PipeException,
    ExecutionException,
    ValidationException,
)

__all__ = [
    'CONST_DEFAULT_SERVICE',
    'CONST_DEFAULT_WEB_CLOUD',
    'CONST_DEFAULT_WEB_HOST',
    'CONST_DEFAULT_WEB_LOCAL',
    'CONST_DEFAULT_WEB_PORT',
    'CONST_DEFAULT_WEB_PROTOCOL',
    'CONST_SOCKET_TIMEOUT',
    'RocketRideException',
    'AuthenticationException',
    'ConnectionException',
    'PipeException',
    'ExecutionException',
    'ValidationException',
    'DAPBase',
    'DAPClient',
    'DAPException',
    'TransportBase',
    'TransportWebSocket',
    'RuntimeManager',
    'StateDB',
    'DockerRuntime',
]
