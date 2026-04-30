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

from fastapi import WebSocket

from rocketlib import APERR, Ec

from ..base import IInstanceBase
from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    """
    WebSocket-capable instance class.

    Processes input/output and handles data exchange via lanes.
    Supports string, bytes, and JSON data with chunked sending
    for large JSON lists.
    """

    def handleWebSocket(self, webSocket: WebSocket):
        """
        Handle the main WebSocket loop.

        Receive the input lanes from the remote pipeline,
        process them with the local pipeline and send the results
        back to the remote pipeline.
        """
        self.connect(webSocket)

        while True:
            # Receive the next call from the remote pipeline
            lane, data = self._recv()

            try:
                # Send it to the local pipeline
                self.callLocal(lane, data)

                # Send the success signal to the remote pipeline
                self._send('error', APERR().toDict())

            except Exception as e:
                # Determine whether this error originated from the remote side.
                # If so, propagate the original error code; otherwise wrap it as
                # a new RemoteException so the remote side sees what went wrong.
                if isinstance(e, APERR) and e.ec == Ec.RemoteException:
                    self._send('error', e.toDict())
                else:
                    self._send('error', APERR(Ec.RemoteException, str(e)).toDict())

                raise

    def writeText(self, text: str):
        # Send a text message to the remote pipeline
        self.callRemote('writeText', text)

    def writeDocuments(self, documents: list):
        # Send a document list to the remote pipeline
        docdata = list(doc.toDict() for doc in documents)
        self.callRemote('writeDocuments', docdata)

    # Shared global reference and socket state
    IGlobal: IGlobal = None
