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

from websockets.sync.client import connect
from typing import List

from ai.common.schema import Doc
from rocketlib import Entry, TAG

from .IGlobal import IGlobal
from ..base import IInstanceBase


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    def beginInstance(self):
        # Connect to the WebSocket synchronously and keep it open
        webSocket = connect(self.IGlobal.urlProcess, additional_headers=self.IGlobal.headers, open_timeout=None, close_timeout=None)

        self.connect(webSocket)

    def endInstance(self):
        self.disconnect()

    def open(self, object: Entry):
        data = object.toDict()
        data['url'] = object.url
        self.callRemote('open', data)

    def writeTag(self, tag: TAG):
        # If this is one of the lanes to send, send it over
        if self.IGlobal.isLaneRemote('tags'):
            self.callRemote('writeTag', tag.asBytes)

    def writeText(self, text: str):
        # If this is one of the lanes to send, send it over
        if self.IGlobal.isLaneRemote('text'):
            self.callRemote('writeText', text)

    def writeWords(self, words: List[str]):
        # If this is one of the lanes to send, send it over
        if self.IGlobal.isLaneRemote('words'):
            self.callRemote('writeWords', words)

    def writeDocuments(self, documents: List[Doc]):
        # If this is one of the lanes to send, send it over
        if self.IGlobal.isLaneRemote('documents'):
            self.callRemote('writeDocuments', documents)

    def closing(self):
        self.callRemote('closing')

    def close(self):
        self.callRemote('close')
