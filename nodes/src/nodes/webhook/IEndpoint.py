# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

import json
import os
import threading
from rocketlib import IEndpointBase, monitorOther, monitorStatus, debug
from typing import Any, Dict, Callable


from depends import depends  # type: ignore

# Load the requirements
requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
depends(requirements)


class IEndpoint(IEndpointBase):
    """
    The IEndpoint class handles the actual HTTP request endpoint.

    Supports webhook and provides the functionality for file processing,
    and manages the execution of asynchronous processing in response to
    incoming requests.

    Attributes:
        target: The target endpoint to send data to. Created before the call to scanObjects
    """

    target: IEndpointBase | None = None

    def _startup(self):
        """Emit the per-logical-type readiness status message.

        Pure-sync — C-extension calls (``monitorOther`` / ``monitorStatus``)
        plus a ``json.dumps``. Called directly from :pyfunc:`_run`.
        """
        try:
            if self.endpoint.logicalType == 'chat':
                # These should NOT be replacable strings!!!
                info = {
                    'button-text': 'Chat now',
                    'button-link': '{host}/chat?auth={public_auth}',
                    'url-text': 'Chat interface URL',
                    'url-link': '{host}/chat',
                    'auth-text': 'Public Authorization Key',
                    'auth-key': '{public_auth}',
                    'token-text': 'Private Token',
                    'token-key': '{token}',
                }
                monitorOther('usr', json.dumps([info]))
                monitorStatus('Chat ready - system is ready to accept questions')

            elif self.endpoint.logicalType == 'dropper':
                info = {
                    'button-text': 'Drop now',
                    'button-link': '{host}/dropper?auth={public_auth}',
                    'url-text': 'Dropper interface URL',
                    'url-link': '{host}/dropper',
                    'auth-text': 'Public Authorization Key',
                    'auth-key': '{public_auth}',
                    'token-text': 'Private Token',
                    'token-key': '{token}',
                }
                monitorOther('usr', json.dumps([info]))
                monitorStatus('Dropper ready - system is ready to process files')

            elif self.endpoint.logicalType in ('webhook', 'adtoolchain'):
                url_text_map = {
                    'webhook': 'Webhook interface URL',
                    'adtoolchain': 'RocketRide DataToolchain interface URL',
                }
                info = {
                    'url-text': url_text_map[self.endpoint.logicalType],
                    'url-link': '{host}/webhook',
                    'auth-text': 'Public Authorization Key',
                    'auth-key': '{public_auth}',
                    'token-text': 'Private Token',
                    'token-key': '{token}',
                }
                monitorOther('usr', json.dumps([info]))
                monitorStatus('Webhook ready - system is ready to accept requests')

        except Exception as e:
            debug(f'Error during startup: {e}')

    def _shutdown(self):
        """Clear the per-source UI metadata published in :pyfunc:`_startup`."""
        try:
            monitorOther('usr')
        except Exception as e:
            debug(f'Error during shutdown: {e}')

    def _run(self):
        """Register on the shared WebServer from ``node.py`` and block on shutdown.

        EaaS spawns this subprocess with ``--data_port=N``; ``node.py``
        bootstraps a shared :class:`WebServer` on the background event loop
        and exposes it as ``ai.node.shared_web_server``. We register our
        target endpoint on that server's ``app.state.target`` (the
        ``data`` module reads it lazily on each WebSocket connection) and
        block on a shutdown event so ``scanObjects()`` doesn't return.
        """
        # Discover the shared server lazily — the import MUST be inside
        # this function (not at module top), because `node.py:run()`
        # assigns to the module-level `shared_web_server` at runtime; a
        # top-of-file `from ai.node import shared_web_server` would capture
        # the pre-assignment value (None) forever.
        from ai import node

        node.shared_web_server.app.state.target = self.target

        self._startup()

        self._shutdown_event = threading.Event()
        self._shutdown_event.wait()

        self._shutdown()

    def scanObjects(self, path: str, scanCallback: Callable[[Dict[str, Any]], None]):
        """
        Initialize the scan process.

        Does this be setting the callback function and running
        the web server. The server will keep running until manually stopped.

        Args:
            path (str): The path to scan for objects.
            scanCallback (Callable): The callback function to call when the scan is complete.
        """
        # Save the target endpoint
        self.target = self.endpoint.target

        # Run the web server supporting this endpoint
        self._run()

        # The task will be considered complete once the server exits
        return
