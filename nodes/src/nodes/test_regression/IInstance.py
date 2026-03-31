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

from rocketlib import IInstanceBase, Entry
from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    def open(self, object: Entry):
        self.text = ''

    def writeText(self, text: str):
        self.text += text

    def writeTable(self, text: str):
        self.text += text

    def closing(self):
        if not self.text:
            return

        manager = self.IGlobal.snapshotManager
        comparator = self.IGlobal.comparator

        # Compute the content key for this input
        content_key = manager.computeKey(self.text)

        if self.IGlobal.updateSnapshots:
            # Update mode: save the current output as the new golden snapshot
            manager.save(content_key, self.text)
            self.instance.writeText(f'[regression] Snapshot updated for key {content_key[:12]}...\n')
            return

        # Compare mode: load the golden snapshot and compare
        golden = manager.load(content_key)

        if golden is None:
            # No golden snapshot exists yet — save it and pass through
            manager.save(content_key, self.text)
            self.instance.writeText(f'[regression] No existing snapshot — created golden file for key {content_key[:12]}...\n')
            return

        # Perform the comparison
        result = comparator.compare(golden, self.text)

        if result['match']:
            self.instance.writeText(f'[regression] PASS (score={result["score"]:.4f}, mode={self.IGlobal.matchMode})\n')
        else:
            # Build the regression report
            report_lines = [
                f'[regression] FAIL (score={result["score"]:.4f}, threshold={self.IGlobal.similarityThreshold}, mode={self.IGlobal.matchMode})',
                '',
                '--- Diff ---',
                result.get('diff', ''),
            ]
            report = '\n'.join(report_lines)

            self.instance.writeText(report + '\n')

            # Also emit a structured JSON summary for downstream consumption
            summary = json.dumps(
                {
                    'status': 'FAIL',
                    'mode': self.IGlobal.matchMode,
                    'score': result['score'],
                    'threshold': self.IGlobal.similarityThreshold,
                    'key': content_key,
                },
                indent=2,
            )
            self.instance.writeText(summary + '\n')
