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
import re
import subprocess
import tempfile
from rocketlib import IInstanceBase, AVI_ACTION, Entry
from ai.common.table import Table

from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    def beginInstance(self):
        self._log('beginInstance() called')
        try:
            from .segment_tracker import SegmentTracker

            self._SegmentTracker = SegmentTracker
            self._tracker = None
            self._temp_video_file = None
            self._temp_video_path: str = None
            self._log(f'beginInstance() OK')
        except Exception as e:
            import traceback
            self._log(f'beginInstance() FAILED: {e}\n{traceback.format_exc()}')

    def endInstance(self):
        self._cleanup_temp()

    def _log(self, msg):
        with open('/tmp/objdet_debug.log', 'a') as f:
            f.write(msg + '\n')

    def open(self, obj: Entry):
        self._log(f'open() called')
        max_gap = self.IGlobal.config.get('max_gap_sec', 2.0)
        self._tracker = self._SegmentTracker(max_gap_sec=max_gap)

    def close(self):
        self._log('close() called')
        self._process_video()
        self._generate_output()
        self._cleanup_temp()

    # ------------------------------------------------------------------
    # Video stream handling -- just buffer to disk, no pipes
    # ------------------------------------------------------------------

    def writeVideo(self, action: AVI_ACTION, mimeType: str, buffer: bytes):
        if action == AVI_ACTION.BEGIN:
            self._log(f'writeVideo BEGIN mime={mimeType}')
            self._temp_video_file = tempfile.NamedTemporaryFile(
                delete=False, suffix='.mp4', prefix='objdet_src_',
            )
            self._temp_video_path = self._temp_video_file.name
            self._write_count = 0
            self._write_bytes = 0

        elif action == AVI_ACTION.WRITE:
            self._write_count += 1
            self._write_bytes += len(buffer) if buffer else 0
            self._temp_video_file.write(buffer)

        elif action == AVI_ACTION.END:
            self._log(
                f'writeVideo END chunks={self._write_count} '
                f'total_bytes={self._write_bytes}'
            )
            self._temp_video_file.close()
            self._temp_video_file = None

    # ------------------------------------------------------------------
    # Frame extraction + detection (runs in close(), after full video saved)
    # ------------------------------------------------------------------

    def _process_video(self):
        """Extract frames via subprocess ffmpeg, then run detection."""
        if not self._temp_video_path or not os.path.exists(self._temp_video_path):
            self._log('_process_video: no video file')
            return
        if self._tracker is None:
            self._log('_process_video: no tracker')
            return

        frames_dir = tempfile.mkdtemp(prefix='objdet_frames_')
        self._log(f'Extracting frames to {frames_dir}')

        try:
            timestamps = self._extract_frames(frames_dir)
            self._log(f'Extracted {len(timestamps)} frames')

            frame_files = sorted(
                f for f in os.listdir(frames_dir) if f.endswith('.png')
            )
            self._log(f'Found {len(frame_files)} PNG files')

            for i, fname in enumerate(frame_files):
                fpath = os.path.join(frames_dir, fname)
                timestamp = timestamps[i] if i < len(timestamps) else float(i)

                with open(fpath, 'rb') as fh:
                    image_bytes = fh.read()

                self._log(
                    f'Frame {i + 1}/{len(frame_files)} '
                    f't={timestamp:.2f}s ({len(image_bytes)} bytes)'
                )
                try:
                    detections = self.IGlobal.detector.detect_and_match(image_bytes)
                    self._log(f'  -> {len(detections)} detections')
                    self._tracker.add_frame(i, timestamp, detections)
                except Exception as e:
                    self._log(f'  -> detection error: {e}')

        except Exception as e:
            import traceback
            self._log(f'_process_video error: {e}\n{traceback.format_exc()}')
        finally:
            for f in os.listdir(frames_dir):
                try:
                    os.remove(os.path.join(frames_dir, f))
                except OSError:
                    pass
            try:
                os.rmdir(frames_dir)
            except OSError:
                pass

    def _extract_frames(self, output_dir: str) -> list:
        """Run ffmpeg to dump 1-per-second PNGs and return their timestamps."""
        import imageio_ffmpeg as ffmpeg

        ffexec = ffmpeg.get_ffmpeg_exe()

        fps = self.IGlobal.config.get('frame_sample_fps', 1.0)
        fps_filter = f'fps={int(fps)}' if fps >= 1 else f'fps=1/{int(1 / fps)}'

        out_pattern = os.path.join(output_dir, 'frame_%06d.png')
        cmd = [
            ffexec,
            '-hide_banner',
            '-loglevel', 'info',
            '-i', self._temp_video_path,
            '-vf', f'{fps_filter},showinfo',
            '-vsync', 'vfr',
            out_pattern,
        ]
        self._log(f'ffmpeg cmd: {" ".join(cmd)}')

        result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)

        self._log(f'ffmpeg exit={result.returncode}')
        if result.returncode != 0:
            self._log(f'ffmpeg stderr (first 2000): {result.stderr[:2000]}')

        timestamps = []
        for line in result.stderr.split('\n'):
            if '[Parsed_showinfo_' not in line:
                continue
            match = re.search(r'pts_time:\s*([0-9.]+)', line)
            if match:
                timestamps.append(float(match.group(1)))

        return timestamps

    # ------------------------------------------------------------------
    # Output generation (called from close())
    # ------------------------------------------------------------------

    def _generate_output(self):
        if self._tracker is None:
            return

        segments = self._tracker.get_segments()
        self._log(f'Total segments found: {len(segments)}')
        if not segments:
            return

        from .clip_extractor import extract_clips
        import shutil

        cfg = self.IGlobal.config
        clips = extract_clips(
            self._temp_video_path,
            segments,
            pre_roll_sec=cfg.get('pre_roll_sec', 2.0),
            post_roll_sec=cfg.get('post_roll_sec', 2.0),
            min_clip_sec=cfg.get('min_clip_sec', 3.0),
            max_clip_sec=cfg.get('max_clip_sec', 60.0),
        )

        save_dir = '/tmp/objdet_clips'
        os.makedirs(save_dir, exist_ok=True)
        for i, ci in enumerate(clips):
            dest = os.path.join(save_dir, f'clip_{i}_{ci.start_time:.0f}s-{ci.end_time:.0f}s.mp4')
            shutil.copy2(ci.path, dest)
            self._log(f'Saved clip: {dest}')

        if self.instance.hasListener('video'):
            for clip_info in clips:
                self._output_clip(clip_info.path)

        if self.instance.hasListener('table'):
            self._output_table(clips)

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
