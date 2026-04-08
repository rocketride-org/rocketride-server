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

from typing import Dict
from rocketlib import IGlobalBase


class IGlobal(IGlobalBase):
    lanes: Dict[str, str] = {}

    def beginGlobal(self):
        # This will create a local copy
        self.lanes = {}
        self.laneName = None

        # Get this nodes config
        config = self.glb.connConfig

        # If the is a laneName
        if 'laneName' in config:
            # If the laneName is specified, use it
            self.laneName = config['laneName']

        # If there is a lanes specifier (obsolete)
        if 'lanes' in config:
            # Read each lane info
            for laneInfo in config['lanes']:
                # Get the info
                laneId = laneInfo.get('laneId', None)
                laneName = laneInfo.get('laneName', None)

                # If either is not specified, skip it
                if not laneId or not laneName:
                    continue

                # Add the lane to the global lanes dictionary
                self.lanes[laneId] = laneName
