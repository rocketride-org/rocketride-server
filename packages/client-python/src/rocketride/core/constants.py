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
Core Constants for RocketRide Client.

This module defines global constants used throughout the RocketRide client library.
These constants provide default values, timeouts, and service endpoints that
ensure consistent behavior across all client operations.

Constants:
    CONST_DEFAULT_SERVICE: Default RocketRide service URI. This is used when no
                          custom service URI is provided during client initialization.
                          Points to the official RocketRide Enterprise as a Service (EaaS)
                          endpoint.
    
    CONST_SOCKET_TIMEOUT: WebSocket timeout in seconds. This value controls how long
                         the client will wait for server responses before timing out.
                         Set to 180 seconds (3 minutes) to accommodate long-running
                         operations while still detecting dead connections.

Usage:
    from rocketride.core.constants import CONST_DEFAULT_SERVICE, CONST_SOCKET_TIMEOUT
    
    # Use default service endpoint
    client = RocketRideClient(uri=CONST_DEFAULT_SERVICE, auth='api_key')
    
    # Access timeout for custom configurations
    custom_timeout = CONST_SOCKET_TIMEOUT * 2  # Double the default timeout
"""

# Default protocol for connections when none is specified
CONST_DEFAULT_WEB_PROTOCOL = 'http://'

# Default hostname for local RocketRide instances
CONST_DEFAULT_WEB_HOST = 'localhost'

# Default server port for self-hosted / local RocketRide instances.
# Applied when no port is specified in the URI.
CONST_DEFAULT_WEB_PORT = 5565

# Default local RocketRide service endpoint URL
CONST_DEFAULT_WEB_LOCAL = f'{CONST_DEFAULT_WEB_PROTOCOL}{CONST_DEFAULT_WEB_HOST}:{CONST_DEFAULT_WEB_PORT}'

# Default cloud RocketRide service endpoint URL
# This points to the production Enterprise as a Service (EaaS) instance
CONST_DEFAULT_WEB_CLOUD = 'https://cloud.rocketride.ai:80'

# Deprecated: use CONST_DEFAULT_WEB_CLOUD instead
CONST_DEFAULT_SERVICE = CONST_DEFAULT_WEB_CLOUD

# WebSocket timeout in seconds
# This controls how long to wait for server responses before timing out
# Set to 3 minutes to handle long-running operations like large file uploads
# or complex pipeline processing while still detecting connection failures
CONST_SOCKET_TIMEOUT = 180

# WebSocket ping interval in seconds
# Ping frames are sent at this interval to detect dead connections
CONST_WS_PING_INTERVAL = 15

# WebSocket ping timeout in seconds
# If no pong response is received within this period after a ping,
# the connection is considered dead and will be closed
CONST_WS_PING_TIMEOUT = 60