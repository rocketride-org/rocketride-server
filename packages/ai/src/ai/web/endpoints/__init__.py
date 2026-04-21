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
Standard Endpoint Handlers Package.

This package collects the built-in HTTP endpoint handlers that every AI service
instance registers automatically. Importing from this package gives the server
module a single, consistent import point for all standard routes.

Endpoints provided:
    use          — POST /use: dynamically load a service module at runtime
    ping         — GET  /ping: lightweight liveness probe (public, no auth)
    version      — GET  /version: return build/package version (public, no auth)
    shutdown     — POST /shutdown: gracefully stop the server process
    status       — GET  /status: return aggregated server health and metrics
    auth_callback — GET /auth/callback: OAuth PKCE safety-net redirect handler
"""

# Import each handler from its own sibling module so callers can do:
#   from ai.web.endpoints import ping, version, ...
from .use import use
from .ping import ping
from .version import version
from .shutdown import shutdown
from .status import status
from .auth_callback import auth_callback

__all__ = ['use', 'ping', 'version', 'shutdown', 'status', 'auth_callback']
