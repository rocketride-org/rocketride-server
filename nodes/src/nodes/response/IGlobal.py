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

from rocketlib import IGlobalBase, warning

from ai.account.store import Store


class IGlobal(IGlobalBase):
    lanes: Dict[str, str] = {}
    # Account FileStore for persisting media outputs; None => fall back to base64.
    client_id = None
    file_store = None
    # When True, produced media is announced live for streaming; False persists only.
    transmit_media = True

    def beginGlobal(self):
        # This will create a local copy
        self.lanes = {}
        self.laneName = None
        self.client_id = None
        self.file_store = None
        self.transmit_media = True

        # Build the account FileStore so media outputs are persisted and served
        # by URL (fsGetUrl) instead of inlined as base64 in the result.
        self._init_file_store()

        # Get this nodes config
        config = self.glb.connConfig

        # Toggle live media transmission (default on). Off => persist without
        # announcing, so clients won't stream it over the reliable channel.
        if 'transmit_media' in config:
            self.transmit_media = bool(config['transmit_media'])

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

    def _init_file_store(self):
        """Resolve the account FileStore for the current engine task (best-effort).
        Identity and the storage anchor come from the task file, not the environment, so
        deploy runs write into the task's team subtree — same as the read side in cmd_media.
        On failure it stays None and media falls back to base64, never breaking a pipeline.
        """
        try:
            store = Store.engine_file_store()
            if store is None:
                return
            self.file_store = store
            self.client_id = store._client_id  # spool namespace: same identity the store scopes to
        except Exception as e:
            warning(f'response: FileStore init failed; media falls back to base64: {e}')
            self.file_store = None
            self.client_id = None
