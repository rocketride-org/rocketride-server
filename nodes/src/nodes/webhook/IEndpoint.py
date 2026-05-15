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
import argparse
import sys
import threading
from rocketlib import IEndpointBase, monitorOther, monitorStatus, debug
from typing import Any, Dict, Callable
from ai.web import WebServer


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
        server: The FastAPI server instance.
        target: The target endpoint to send data to. Created before the call to scanObjects
    """

    target: IEndpointBase | None = None

    def _emit_ready_status_sync(self):
        """Emit the per-logical-type readiness status message.

        Pure-sync body, just three C-extension calls (``monitorOther`` and
        ``monitorStatus``) and a ``json.dumps``. Extracted from
        :pyfunc:`_startup` so the shared-server path in :pyfunc:`_run`
        can call it directly without spinning up a fresh asyncio loop
        via ``asyncio.run`` (which crashes the subprocess in production —
        see Phase 3 notes).
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

    def _emit_shutdown_status_sync(self):
        """Sync version of the ``_shutdown`` body — single ``monitorOther('usr')``."""
        try:
            monitorOther('usr')
        except Exception as e:
            debug(f'Error during shutdown: {e}')

    async def _startup(self):
        """Async wrapper for FastAPI's lifespan hook (legacy fallback path).

        The shared-server path calls :pyfunc:`_emit_ready_status_sync` directly
        instead. This async wrapper exists so the legacy WebServer
        ``on_startup=`` registration still works.
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

                # Output the info
                monitorOther(
                    'usr',
                    json.dumps([info]),
                )

                # Chat is the source component, so when it's ready, all downstream
                # components (embedding, LLM, etc.) have already been initialized
                # This status message indicates the chat is ready to accept questions
                monitorStatus('Chat ready - system is ready to accept questions')

            elif self.endpoint.logicalType == 'dropper':
                # These should NOT be replacable strings!!!
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

                # Output the info
                monitorOther(
                    'usr',
                    json.dumps([info]),
                )
                # Chat is the source component, so when it's ready, all downstream
                # components (embedding, LLM, etc.) have already been initialized
                # This status message indicates the chat is ready to accept questions
                monitorStatus('Dropper ready - system is ready to process files')

            elif self.endpoint.logicalType in ('webhook', 'adtoolchain'):
                # These should NOT be replacable strings!!!
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

                # Output the info
                monitorOther(
                    'usr',
                    json.dumps([info]),
                )

                # Webhook is the source component, so when it's ready, all downstream
                # components have already been initialized
                # This status message indicates the webhook is ready to accept requests
                monitorStatus('Webhook ready - system is ready to accept requests')

        except Exception as e:
            debug(f'Error during startup: {e}')

    async def _shutdown(self):
        try:
            monitorOther('usr')
        except Exception as e:
            debug(f'Error during shutdown: {e}')

    def _run(self):
        """Block until shutdown, using the shared WebServer from ``node.py`` if available.

        When EaaS spawns this subprocess with ``--data_port=N``, ``node.py``
        bootstraps a shared :class:`WebServer` on the background event loop
        and exposes it as ``ai.node.shared_web_server``. We just register
        our target endpoint on that server's ``app.state.target`` (the
        ``data`` module reads it lazily on each WebSocket connection) and
        block on a shutdown event so ``scanObjects()`` doesn't return.

        Legacy fallback (direct CLI invocation without ``--data_port``,
        unit tests, etc.): the shared server is ``None``, and we build our
        own ``WebServer`` and run it blocking — today's behavior preserved.
        """
        # Discover the shared server lazily — `from ai.node import
        # shared_web_server` MUST be inside this function (not at module
        # top), because `node.py:run()` assigns to the module-level
        # `shared_web_server` at runtime; a top-of-file `from` binding
        # would capture the pre-assignment value (None) forever.
        from ai import node as ai_node

        shared = ai_node.shared_web_server

        if shared is None:
            return self._run_legacy_self_hosted_server()

        shared.app.state.target = self.target

        self._emit_ready_status_sync()

        self._shutdown_event = threading.Event()
        self._shutdown_event.wait()

        self._emit_shutdown_status_sync()

    def _run_legacy_self_hosted_server(self):
        """Legacy path: construct and run a dedicated ``WebServer``.

        Used only when ``ai.node.shared_web_server`` is ``None`` — i.e.
        when ``node.py`` was invoked without ``--data_port`` (direct CLI
        invocations, unit tests). EaaS always passes ``--data_port`` in
        production, so this branch never runs there.
        """
        debug('webhook shared web server is not setup, using LEGACY self-hosted WebServer path')
        # Parse arguments
        parser = argparse.ArgumentParser(add_help=False)
        parser.add_argument('--data_host', type=str, default='localhost')
        parser.add_argument('--data_port', type=int, default=5567)

        # Parse only the args we care about, ignore unknown ones
        parsed_args, _ = parser.parse_known_args(sys.argv)

        data_host = parsed_args.data_host
        data_port = parsed_args.data_port

        # Create our server - we use the command line arguments passed over
        # by eaas to determine the host and port
        self.server = WebServer(
            config={
                'port': data_port,
                'host': data_host,
            },
            on_startup=self._startup,
            on_shutdown=self._shutdown,
        )

        # Save the target
        self.server.app.state.target = self.target

        # Create our data server to accept incoming data
        self.server.use('data')

        # Run the  server
        self.server.run()

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
