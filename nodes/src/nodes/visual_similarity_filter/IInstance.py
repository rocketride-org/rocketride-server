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

from rocketlib import IInstanceBase, AVI_ACTION, Entry
from ai.common.table import Table

from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    def beginInstance(self):
        self._frame_idx = 0
        self._matched = 0
        self._total = 0
        self._forwarded = 0
        self._match_rows = []
        self._image_buf = bytearray()
        self._image_mime = 'image/png'

        cfg = self.IGlobal.config
        self._fps = float(cfg.get('fps', 1.0))

    def endInstance(self):
        pass

    def open(self, obj: Entry):
        self._frame_idx = 0
        self._matched = 0
        self._total = 0
        self._forwarded = 0
        self._match_rows = []

    def close(self):
        if self.instance.hasListener('table') and self._match_rows:
            table = Table.generate_markdown_table(
                headers=['Frame', 'Time', 'Similarity'],
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
            self.preventDefault()

        elif action == AVI_ACTION.WRITE:
            if buffer:
                self._image_buf.extend(buffer)
            self.preventDefault()

        elif action == AVI_ACTION.END:
            self._on_frame_complete(bytes(self._image_buf), self._image_mime)
            self._image_buf = bytearray()
            self.preventDefault()

    # ------------------------------------------------------------------
    # Control-plane invoke (called by clip_buffer)
    # ------------------------------------------------------------------

    def invoke(self, frame_bytes: bytes) -> bool:
        matched, _ = self._score_frame(frame_bytes)
        return matched

    # ------------------------------------------------------------------
    # Per-frame similarity + ring buffer forwarding
    # ------------------------------------------------------------------

    def _score_frame(self, image_bytes: bytes) -> tuple:
        """Embed image_bytes and score against the reference.

        Returns (matched: bool, similarity: float).
        First call sets the reference and returns (True, 1.0).
        """
        import numpy as np

        with self.IGlobal.device_lock:
            if self.IGlobal.reference_embedding is None:
                self.IGlobal.reference_embedding = self.IGlobal.embedder.embed(image_bytes)
                return True, 1.0
            frame_emb = self.IGlobal.embedder.embed(image_bytes)

        try:
            similarity = float(np.dot(self.IGlobal.reference_embedding, frame_emb))
        except Exception:
            return False, 0.0
        return similarity >= self.IGlobal.embedder.similarity_threshold, similarity

    def _on_frame_complete(self, image_bytes: bytes, mime: str):
        idx = self._frame_idx
        self._frame_idx += 1
        self._total += 1
        timestamp = idx / self._fps if self._fps > 0 else float(idx)

        matched, similarity = self._score_frame(image_bytes)
        if matched:
            self._matched += 1
            self._match_rows.append([idx, self._fmt_time(timestamp), f'{similarity:.3f}'])
            self._forward_frame(image_bytes, mime)

    def _forward_frame(self, image_bytes: bytes, mime: str):
        if self.instance.hasListener('image'):
            self.instance.writeImage(AVI_ACTION.BEGIN, mime)
            self.instance.writeImage(AVI_ACTION.WRITE, mime, image_bytes)
            self.instance.writeImage(AVI_ACTION.END, mime)
            self._forwarded += 1

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _fmt_time(seconds: float) -> str:
        h = int(seconds // 3600)
        m = int((seconds % 3600) // 60)
        s = seconds % 60
        return f'{h:02}:{m:02}:{s:05.2f}'
