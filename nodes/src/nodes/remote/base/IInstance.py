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

import asyncio
import json
from fastapi import WebSocket as ServerConnection
import nest_asyncio
from websockets.sync.client import ClientConnection

# Enable runing the async coroutines in a synchronous context
nest_asyncio.apply()

from ai.common.schema import Doc
from rocketlib import APERR, Ec, Entry, IInstanceBase


class IInstance(IInstanceBase):
    def connect(self, webSocket: (ClientConnection, ServerConnection)):
        # Check connection state and type
        if self._webSocket:
            raise Exception('WebSocket already connected')
        elif not webSocket:
            raise ValueError('WebSocket not specified')
        elif isinstance(webSocket, ClientConnection):
            pass
        elif isinstance(webSocket, ServerConnection):
            pass
        else:
            raise ValueError(f'Invalid WebSocket: {webSocket}')

        # Store connection
        self._webSocket = webSocket

    def disconnect(self):
        if self._webSocket:
            if isinstance(self._webSocket, ClientConnection):
                # Close client connection
                self._webSocket.close()
            # elif isinstance(self._webSocket, ServerConnection):
            #     pass
            else:
                raise Exception(f'Unexpected WebSocket state: {self._webSocket}')

            # Release connection object
            self._webSocket = None

    def _send(self, lane: str, data: None | str | bytes | dict | list = None):
        # Determine data type
        if isinstance(data, str):
            datatype = 'str'
        elif isinstance(data, bytes):
            datatype = 'bytes'
        elif isinstance(data, (dict, list)):
            datatype = 'json'
        elif data is None:
            datatype = 'none'
        else:
            raise TypeError(f'Unknown data type {type(data)}')

        # Create the message header
        header = {'lane': lane, 'type': datatype}

        if isinstance(self._webSocket, ClientConnection):
            # Send the header
            self._webSocket.send(json.dumps(header))

            # Prepare json data
            if isinstance(data, (dict, list)):
                data = json.dumps(data)

            # Send the actual data
            if data is not None:
                self._webSocket.send(data)

        elif isinstance(self._webSocket, ServerConnection):
            # Send the header
            IInstance.runAsync(self._webSocket.send_json(header))

            # Send the actual data
            if datatype == 'str':
                IInstance.runAsync(self._webSocket.send_text(data))
            elif datatype == 'bytes':
                IInstance.runAsync(self._webSocket.send_bytes(data))
            elif datatype == 'json':
                IInstance.runAsync(self._webSocket.send_json(data))

        else:
            raise Exception(f'Unexpected WebSocket state: {self._webSocket}')

    def _recv(self) -> (str, None | str | bytes | dict | list):
        if isinstance(self._webSocket, ClientConnection):
            # Get the data response string
            headerStr = self._webSocket.recv()

            # Convert from json
            header = json.loads(headerStr)

            # Grab the type
            lane, datatype = header['lane'], header['type']

            # Receive data according to its type
            if datatype == 'str':
                data = self._webSocket.recv()
            elif datatype == 'bytes':
                data = self._webSocket.recv()
            elif datatype == 'json':
                data_str = self._webSocket.recv()
                data = json.loads(data_str)
            elif datatype == 'none':
                data = None
            else:
                raise TypeError(f'Unknown data type {datatype}')

        elif isinstance(self._webSocket, ServerConnection):
            # Get the data response json
            header = IInstance.runAsync(self._webSocket.receive_json())

            # Grab the type
            lane, datatype = header['lane'], header['type']

            # Receive data according to its type
            if datatype == 'str':
                data = IInstance.runAsync(self._webSocket.receive_text())
            elif datatype == 'bytes':
                data = IInstance.runAsync(self._webSocket.receive_bytes())
            elif datatype == 'json':
                data = IInstance.runAsync(self._webSocket.receive_json())
            elif datatype == 'none':
                data = None
            else:
                raise TypeError(f'Unknown data type {datatype}')

        else:
            raise Exception(f'Unexpected WebSocket state: {self._webSocket}')

        # And return it
        return lane, data

    def callRemote(self, lane: str, data: None | str | bytes | dict | list = None):
        """
        Send lane data to the remote pipeline.

        Handle all responses with the local pipeline.
        """
        dataChunks = None
        if data and isinstance(data, list):
            # Split the list into sublists, each with a size smaller than WebSocket max_size.
            dataChunks = IInstance.listChunks(data)
        else:
            dataChunks = (data,)

        for dataChunk in dataChunks:
            # Send the call to the remote pipeline
            self._send(lane, dataChunk)

            while True:
                # Receive the next call from the remote pipeline
                rspLane, rspData = self._recv()

                # Check if the remote pipeline completed the call and returned an error code.
                if rspLane == 'error':
                    ccode = APERR.fromDict(rspData)
                    ccode.check_raise()
                    break

                try:
                    # Send it to the local pipeline
                    self.callLocal(rspLane, rspData)

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

    def callLocal(self, lane: str, data):
        """
        Send specified lane data to the local pipeline.
        """
        if lane == 'open':
            if not isinstance(data, dict):
                raise TypeError(f'Unexpected data type {type(data)} for lane {lane}')

            url = data['url']
            del data['url']

            self._obj = Entry(url)  # preserve object from release
            self._obj.fromDict(data)

            self.instance.pipe.open(self._obj)

        elif lane == 'closing':
            if data is not None:
                raise TypeError(f'Unexpected data {data} for lane {lane}')

            self.instance.pipe.closing()

        elif lane == 'close':
            if data is not None:
                raise TypeError(f'Unexpected data {data} for lane {lane}')

            self.instance.pipe.close()

        elif lane == 'writeTag':
            if not isinstance(data, bytes):
                raise TypeError(f'Unexpected data type {type(data)} for lane {lane}')

            self.instance.writeTag(data)

        elif lane == 'writeText':
            if not isinstance(data, str):
                raise TypeError(f'Unexpected data type {type(data)} for lane {lane}')

            self.instance.writeText(data)

        elif lane == 'writeDocuments':
            if not isinstance(data, list):
                raise TypeError(f'Unexpected data type {type(data)} for lane {lane}')

            docs = list(Doc.fromDict(doc) for doc in data)

            self.instance.writeDocuments(docs)

        else:
            raise TypeError(f'Unexpected lane {lane}')

    @staticmethod
    def runAsync(asyncAction):
        """
        Run an async coroutine in a synchronous context using the current event loop.
        """
        loop = asyncio.get_event_loop()
        result = loop.run_until_complete(asyncAction)
        return result

    @staticmethod
    def estimateJsonLength(obj):
        """
        Estimates the JSON-serialized length (in characters) of a Python object.
        """
        if obj is None:
            return 4
        elif isinstance(obj, bool):
            return 4 if obj else 5
        elif isinstance(obj, (int, float)):
            return len(str(obj))
        elif isinstance(obj, str):
            return len(obj) + 2  # quotes
        elif isinstance(obj, list):
            if not obj:
                return 2
            return sum(IInstance.estimateJsonLength(i) + 1 for i in obj) + 1
        elif isinstance(obj, dict):
            if not obj:
                return 2
            total = 2
            for i, (k, v) in enumerate(obj.items()):
                total += len(k) + 2  # key with quotes
                total += 1  # colon
                total += IInstance.estimateJsonLength(v)
                if i != len(obj) - 1:
                    total += 1  # comma
            return total
        else:
            raise TypeError(f'Unsupported type: {type(obj)}')

    @staticmethod
    def listChunks(data: list):
        """
        Split a list of data items into chunks.

        Ensure that the estimated JSON-encoded size of each chunk does not exceed
        the WebSocket `max_size`.
        """
        MAX_CHUNK_SIZE = int(0.98 * (2**20))  # WebSocket max_size with error factor
        chunkIdx, chunkSize = 0, 0
        for idx in range(len(data)):
            itemSize = IInstance.estimateJsonLength(data[idx])
            if chunkSize + itemSize >= MAX_CHUNK_SIZE:
                yield data[chunkIdx:idx]
                chunkIdx, chunkSize = idx, itemSize
            else:
                chunkSize += itemSize
        yield data[chunkIdx:]

    _webSocket: (ClientConnection, ServerConnection) = None
    _obj: Entry = None
