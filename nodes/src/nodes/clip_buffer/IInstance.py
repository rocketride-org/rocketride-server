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

from collections import deque
from typing import Optional

from rocketlib import IInstanceBase, AVI_ACTION, Entry
from ai.common.table import Table

from .IGlobal import IGlobal

_LOG = '/tmp/brandy_pipeline.log'


def _plog(msg: str) -> None:
    import datetime

    line = f'[{datetime.datetime.now().isoformat(timespec="milliseconds")}] [clip_buffer  ] {msg}\n'
    with open(_LOG, 'a') as f:
        f.write(line)


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    def beginInstance(self):
        cfg = self.IGlobal.config
        self._scan_interval = float(cfg.get('scan_interval', 5.0))
        self._buffer_seconds = float(cfg.get('buffer_seconds', 5.0))
        self._scene_threshold = float(cfg.get('scene_threshold', 0.25))

        # Lazy-initialised on first _invoke_vsf call — controllers may not be
        # registered yet at beginInstance time.
        self._vsf_node_id: Optional[str] = None
        _plog(f'beginInstance: scan_interval={self._scan_interval} buffer_seconds={self._buffer_seconds} scene_threshold={self._scene_threshold} vsf_node_id=deferred')

    def endInstance(self):
        pass

    def open(self, obj: Entry):
        self._buffer: deque = deque()  # (timestamp, frame_bytes, mime)
        self._clip: list = []
        self._in_match: bool = False
        self._pending_scene_change_score: float = 0.0
        self._pending_timestamp: float = 0.0
        self._last_scan: float = float('-inf')
        self._image_buf = bytearray()
        self._image_mime = 'image/png'
        self._clip_idx: int = 0
        self._reference_set: bool = False

    def close(self):
        # Flush any in-progress clip if the video ends mid-match
        if self._in_match and self._clip:
            self._flush_clip()

    # ------------------------------------------------------------------
    # documents lane — consume scene_change_score + timestamp metadata
    # ------------------------------------------------------------------

    def writeDocuments(self, docs):
        doc = docs[0]
        self._pending_scene_change_score = getattr(doc.metadata, 'scene_change_score', 0.0)
        self._pending_timestamp = getattr(doc.metadata, 'time_stamp', 0.0)
        self.preventDefault()

    # ------------------------------------------------------------------
    # image lane — accumulate frame bytes, process on END
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
            self._on_frame(bytes(self._image_buf), self._image_mime)
            self._image_buf = bytearray()
            self.preventDefault()

    # ------------------------------------------------------------------
    # Core state machine
    # ------------------------------------------------------------------

    def _on_frame(self, frame_bytes: bytes, mime: str):
        timestamp = self._pending_timestamp
        scene_change_score = self._pending_scene_change_score

        # 0. First frame: send to VSF to establish the reference image
        if not self._reference_set:
            self._reference_set = True
            _plog(f'reference: setting reference from first frame ts={timestamp:.3f}')
            self._invoke_vsf(frame_bytes)
            self._last_scan = timestamp  # treat as just scanned so next poll is scan_interval away

        # 1. Append to rolling pre-buffer; evict entries older than buffer_seconds
        self._buffer.append((timestamp, frame_bytes, mime))
        cutoff = timestamp - self._buffer_seconds
        while self._buffer and self._buffer[0][0] < cutoff:
            self._buffer.popleft()

        if not self._in_match:
            # 2. Sparse VSF poll
            if (timestamp - self._last_scan) >= self._scan_interval:
                self._last_scan = timestamp
                result = self._invoke_vsf(frame_bytes)
                _plog(f'scan: ts={timestamp:.3f} vsf_result={result}')
                if result:
                    _plog(f'match: clip_idx={self._clip_idx} pre_buffer_frames={len(self._buffer)}')
                    self._in_match = True
                    self._clip = list(self._buffer)  # snapshot pre-buffer (includes this frame)
        else:
            # 3. Collecting — append frame, flush on scene change OR VSF miss
            self._clip.append((timestamp, frame_bytes, mime))

            # Re-verify with VSF at scan_interval — stop clip if car has left
            if (timestamp - self._last_scan) >= self._scan_interval:
                self._last_scan = timestamp
                still_matched = self._invoke_vsf(frame_bytes)
                _plog(f'collect_scan: ts={timestamp:.3f} vsf_result={still_matched}')
                if not still_matched:
                    _plog(f'car_left: ts={timestamp:.3f} flushing clip with {len(self._clip)} frames')
                    self._flush_clip()
                    self._in_match = False
                    self._clip = []
                    self._buffer.clear()
                    return

            if scene_change_score >= self._scene_threshold:
                _plog(f'scene_change: ts={timestamp:.3f} score={scene_change_score:.3f} clip_frames={len(self._clip)}')
                self._flush_clip()
                self._in_match = False
                self._clip = []
                self._buffer.clear()

    def _invoke_vsf(self, frame_bytes: bytes) -> bool:
        # Lazy lookup — try once per instance; if still empty, mark NOT_FOUND.
        if self._vsf_node_id is None:
            vsf_ids = self.instance.getControllerNodeIds('visual_similarity')
            self._vsf_node_id = vsf_ids[0] if vsf_ids else 'NOT_FOUND'
            _plog(f'invoke_vsf: lazy_init vsf_node_id={self._vsf_node_id!r}')
        if self._vsf_node_id == 'NOT_FOUND':
            _plog('invoke_vsf: no VSF wired — stub match=True')
            return True  # stub: always match when no VSF wired (dev/test)
        try:
            result = bool(self.instance.invoke('visual_similarity', frame_bytes, nodeId=self._vsf_node_id))
            return result
        except Exception as e:
            _plog(f'invoke_vsf: EXCEPTION {e}')
            return False

    def _flush_clip(self):
        if not self._clip:
            return

        _plog(f'flush_clip: clip_idx={self._clip_idx} frames={len(self._clip)} has_image_listener={self.instance.hasListener("image")}')
        table_rows = []
        for frame_ts, frame_bytes, mime in self._clip:
            if self.instance.hasListener('image'):
                self.instance.writeImage(AVI_ACTION.BEGIN, mime)
                self.instance.writeImage(AVI_ACTION.WRITE, mime, frame_bytes)
                self.instance.writeImage(AVI_ACTION.END, mime)
            table_rows.append([self._clip_idx, frame_ts])

        if self.instance.hasListener('table') and table_rows:
            table = Table.generate_markdown_table(
                headers=['Clip', 'Timestamp'],
                data=table_rows,
            )
            self.instance.writeTable(table)

        self._clip_idx += 1
