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

import os
import tempfile
from rocketlib import IInstanceBase, AVI_ACTION, Entry
from ai.common.table import Table

from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    def beginInstance(self):
        from ai.common.avi.frame import VideoFrameExtractor
        from .segment_tracker import SegmentTracker

        self._SegmentTracker = SegmentTracker

        fe_config = dict(self.IGlobal.config)
        fe_config['type'] = 'interval'
        fe_config['fps'] = fe_config.get('frame_sample_fps', 1.0)

        self._frame_extractor = VideoFrameExtractor(
            frame_callback=self._frame_callback,
            name='ObjectDetectionFilter',
            config=fe_config,
        )

        self._tracker = None
        self._temp_video_file = None
        self._temp_video_path: str = None

    def endInstance(self):
        self._frame_extractor = None
        self._cleanup_temp()

    def open(self, obj: Entry):
        max_gap = self.IGlobal.config.get('max_gap_sec', 2.0)
        self._tracker = self._SegmentTracker(max_gap_sec=max_gap)

    def close(self):
        self._generate_output()
        self._cleanup_temp()

    # ------------------------------------------------------------------
    # Video stream handling
    # ------------------------------------------------------------------

    def writeVideo(self, action: AVI_ACTION, mimeType: str, buffer: bytes):
        if action == AVI_ACTION.BEGIN:
            self._temp_video_file = tempfile.NamedTemporaryFile(
                delete=False, suffix='.mp4', prefix='objdet_src_',
            )
            self._temp_video_path = self._temp_video_file.name
            self._frame_extractor.writeAVI(action, mimeType, buffer)

        elif action == AVI_ACTION.WRITE:
            self._temp_video_file.write(buffer)
            self._frame_extractor.writeAVI(action, mimeType, buffer)

        elif action == AVI_ACTION.END:
            self._temp_video_file.close()
            self._temp_video_file = None
            # stop() blocks until all frame callbacks have completed
            self._frame_extractor.writeAVI(action, mimeType, buffer)

    # ------------------------------------------------------------------
    # Frame callback — runs once per extracted frame
    # ------------------------------------------------------------------

    def _frame_callback(self, image: bytes, frame_number: int, time_stamp: float):
        if image is None:
            return

        detections = self.IGlobal.detector.detect_and_match(image)
        self._tracker.add_frame(frame_number, time_stamp, detections)

    # ------------------------------------------------------------------
    # Output generation (called from close())
    # ------------------------------------------------------------------

    def _generate_output(self):
        if self._tracker is None:
            return

        segments = self._tracker.get_segments()
        if not segments:
            return

        from .clip_extractor import extract_clips

        cfg = self.IGlobal.config
        clips = extract_clips(
            self._temp_video_path,
            segments,
            pre_roll_sec=cfg.get('pre_roll_sec', 2.0),
            post_roll_sec=cfg.get('post_roll_sec', 2.0),
            min_clip_sec=cfg.get('min_clip_sec', 3.0),
            max_clip_sec=cfg.get('max_clip_sec', 60.0),
        )

        if self.instance.hasListener('video'):
            for clip_info in clips:
                self._output_clip(clip_info.path)

        if self.instance.hasListener('table'):
            self._output_table(clips)

        # Clean up clip temp files
        for clip_info in clips:
            try:
                os.remove(clip_info.path)
            except OSError:
                pass

    def _output_clip(self, clip_path: str):
        """Stream a clip file to the downstream video lane."""
        chunk_size = 64 * 1024
        self.instance.writeVideo(AVI_ACTION.BEGIN, 'video/mp4')

        with open(clip_path, 'rb') as fh:
            while True:
                chunk = fh.read(chunk_size)
                if not chunk:
                    break
                self.instance.writeVideo(AVI_ACTION.WRITE, 'video/mp4', chunk)

        self.instance.writeVideo(AVI_ACTION.END, 'video/mp4')

    def _output_table(self, clips):
        """Emit a metadata table describing the extracted clips."""
        def fmt(seconds: float) -> str:
            h = int(seconds // 3600)
            m = int((seconds % 3600) // 60)
            s = seconds % 60
            return f'{h:02}:{m:02}:{s:05.2f}'

        rows = []
        for i, ci in enumerate(clips):
            seg = ci.segment
            rows.append([
                i + 1,
                fmt(ci.start_time),
                fmt(ci.end_time),
                f'{ci.duration:.1f}',
                seg.frame_count,
                f'{seg.avg_confidence:.3f}',
                f'{seg.avg_similarity:.3f}',
                f'{seg.peak_confidence:.3f}',
                f'{seg.peak_similarity:.3f}',
            ])

        table = Table.generate_markdown_table(
            headers=[
                'Clip', 'Start', 'End', 'Duration (s)', 'Frames',
                'Avg Conf', 'Avg Sim', 'Peak Conf', 'Peak Sim',
            ],
            data=rows,
        )
        self.instance.writeTable(table)

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _cleanup_temp(self):
        if self._temp_video_path and os.path.exists(self._temp_video_path):
            try:
                os.remove(self._temp_video_path)
            except OSError:
                pass
        self._temp_video_path = None
        self._temp_video_file = None
