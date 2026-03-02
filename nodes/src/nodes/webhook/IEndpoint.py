# =============================================================================
# MIT License
# Copyright (c) 2026 RocketRide, Inc.
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

    async def _startup(self):
        """
        Perform startup initialization for the endpoint.

        This method is called when the endpoint is started and can be
        overridden in subclasses to perform additional initialization tasks.
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
        """
        Initialize and run the FastAPI server with the specified configuration.

        Args:
            config (dict): The configuration dictionary containing parameters like endpoint, port, etc.
        """
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
        self.server.use('profiler')

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
