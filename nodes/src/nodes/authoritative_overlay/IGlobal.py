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

from rocketlib import IGlobalBase, debug
from ai.common.config import Config


class IGlobal(IGlobalBase):
    def __init__(self):
        super().__init__()
        self.regulator_type = 'sec'
        self.cik = ''

    def beginGlobal(self):
        """Initialize the global authoritative overlay configuration."""
        raw = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig) or {}
        self.regulator_type = str(raw.get('regulator_type', 'sec')).strip()
        cik_raw = str(raw.get('cik', '')).strip()
        # Zero-pad only after the emptiness check so a blank CIK stays falsy
        # (zfill(10) on '' would become '0000000000' and skip query_sec's guard).
        self.cik = cik_raw.zfill(10) if cik_raw else ''
        debug(f'Initialized Authoritative Overlay with regulator: {self.regulator_type}, CIK: {self.cik}')
