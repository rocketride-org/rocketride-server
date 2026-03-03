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

from rocketlib import IInstanceBase, AVI_ACTION, Entry
from ai.common.table import Table

from .IGlobal import IGlobal

_LOG_PATH = '/tmp/objdet_debug.log'


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    def beginInstance(self):
        self._frame_idx = 0
        self._matched = 0
        self._total = 0
        self._match_rows = []
        self._image_buf = bytearray()
        self._image_mime = 'image/png'
        self._fps = self.IGlobal.config.get('fps', 1.0)

    def endInstance(self):
        pass

    def open(self, obj: Entry):
        self._frame_idx = 0
        self._matched = 0
        self._total = 0
        self._match_rows = []

    def close(self):
        self._log(f'close: {self._matched}/{self._total} frames matched')

        if self.instance.hasListener('table') and self._match_rows:
            table = Table.generate_markdown_table(
                headers=['Frame', 'Time', 'Label', 'Confidence', 'Similarity'],
                data=self._match_rows,
            )
            self.instance.writeTable(table)

    # ------------------------------------------------------------------
    # Image stream handling
    # ------------------------------------------------------------------

    def writeImage(self, action: AVI_ACTION, mimeType: str, buffer: bytes):
        if action == AVI_ACTION.BEGIN:
            self._image_buf = bytearray()
            self._image_mime = mimeType

        elif action == AVI_ACTION.WRITE:
            if buffer:
                self._image_buf.extend(buffer)

        elif action == AVI_ACTION.END:
            self._on_frame_complete(bytes(self._image_buf), self._image_mime)
            self._image_buf = bytearray()

    # ------------------------------------------------------------------
    # Per-frame detection + forwarding
    # ------------------------------------------------------------------

    def _on_frame_complete(self, image_bytes: bytes, mime: str):
        idx = self._frame_idx
        self._frame_idx += 1
        self._total += 1
        timestamp = idx / self._fps if self._fps > 0 else float(idx)

        try:
            detections = self.IGlobal.detector.detect_and_match(image_bytes)
        except Exception as e:
            self._log(f'frame {idx} detection error: {e}')
            return

        if not detections:
            return

        self._matched += 1
        best = max(detections, key=lambda d: d.similarity if d.similarity is not None else d.confidence)

        self._match_rows.append([
            idx,
            self._fmt_time(timestamp),
            best.label,
            f'{best.confidence:.3f}',
            f'{best.similarity:.3f}' if best.similarity is not None else '-',
        ])

        self._log(
            f'frame {idx} t={timestamp:.2f}s MATCH '
            f'label={best.label} conf={best.confidence:.3f} '
            f'sim={best.similarity}'
        )

        if self.instance.hasListener('image'):
            self.instance.writeImage(AVI_ACTION.BEGIN, mime)
            self.instance.writeImage(AVI_ACTION.WRITE, mime, image_bytes)
            self.instance.writeImage(AVI_ACTION.END, mime)

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _fmt_time(seconds: float) -> str:
        h = int(seconds // 3600)
        m = int((seconds % 3600) // 60)
        s = seconds % 60
        return f'{h:02}:{m:02}:{s:05.2f}'

    @staticmethod
    def _log(msg: str):
        with open(_LOG_PATH, 'a') as f:
            f.write(f'[OBJDET] {msg}\n')
