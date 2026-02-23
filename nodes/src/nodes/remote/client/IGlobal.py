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

# ------------------------------------------------------------------------------
# This class controls the data shared between all threads for the task
# ------------------------------------------------------------------------------
from typing import Dict, Any, List
import requests
from rocketlib import configureLogger, IGlobalBase, monitorStatus, IJson, Lvl
from ai.common.config import Config


class IGlobal(IGlobalBase):
    def beginGlobal(self):
        # Enable websockets.client logging with Engine Lvl.Remoting level
        configureLogger('websockets.client', Lvl.Remoting)

        # Get the parameters
        config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)

        # Get and check the parameters
        remoteConfig = config['remote']['remote']['remote']
        self._host = remoteConfig.get('host')
        if not self._host:
            raise Exception('Host not specified')
        self._port = remoteConfig.get('port')
        if not self._port:
            raise Exception('Port not specified')
        self._apikey = remoteConfig.get('apikey')
        if not self._apikey:
            raise Exception('API key not specified')
        self._pipeline = config.get('pipeline')
        if not self._pipeline:
            raise Exception('Pipeline not specified')
        self._pipeId = self.IEndpoint.endpoint.jobConfig['taskId']
        if not self._pipeId:
            raise Exception('Task ID not specified')

        # Get the lanes to remote/return
        self.inputLanes = config.get('input', ['tags'])
        self.outputLanes = config.get('output', ['documents'])

        # Build up the headers to send
        self.headers = {'Content-Type': 'application/json', 'Authorization': f'Bearer {self._apikey}'}

        # Build the URLs to access the pipe
        self.urlControl = f'http://{self._host}:{self._port}/remote?pipe={self._pipeId}'
        self.urlProcess = f'ws://{self._host}:{self._port}/remote/pipe?pipe={self._pipeId}'

        # Update the monitor
        monitorStatus('Loading remote pipe')

        requests.post(f'http://{self._host}:{self._port}/use?name=remote', headers=self.headers).raise_for_status()

        # Issue the request
        response = requests.post(self.urlControl, json=IJson.toDict(self._pipeline), headers=self.headers)

        # Check for success
        if response.status_code != 200:
            raise Exception(f'Unable to create pipe on {self.urlControl}: {response.text}')

    def endGlobal(self):
        # Issue the request
        response = requests.delete(self.urlControl, headers=self.headers)

        # Check for success
        if response.status_code != 200:
            raise Exception(f'Unable to destroy pipe on {self.urlControl}: {response.txt}')

    def isLaneRemote(self, lane: str) -> bool:
        return lane in self.inputLanes

    urlControl: str
    urlProcess: str
    headers: Dict[str, Any]
    inputLanes: List[str]
    outputLanes: List[str]
