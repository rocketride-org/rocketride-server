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

from rocketlib import IGlobalBase, OPEN_MODE
from ai.common.config import Config


class IGlobal(IGlobalBase):
    snapshotDir: str = '.snapshots'
    matchMode: str = 'exact'
    similarityThreshold: float = 0.95
    updateSnapshots: bool = False

    def beginGlobal(self) -> None:
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            pass
        else:
            # Get our configuration
            config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)

            # Get the parameters
            self.snapshotDir = config.get('snapshotDir', '.snapshots')
            self.matchMode = config.get('matchMode', 'exact')
            self.similarityThreshold = config.get('similarityThreshold', 0.95)
            self.updateSnapshots = config.get('updateSnapshots', False)

            # Initialize the snapshot manager
            from .snapshot_manager import SnapshotManager

            self.snapshotManager = SnapshotManager(self.snapshotDir)

            # Initialize the comparator
            from .comparator import Comparator

            self.comparator = Comparator(self.matchMode, self.similarityThreshold)
