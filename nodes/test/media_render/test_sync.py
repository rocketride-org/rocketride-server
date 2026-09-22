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

"""
A/V sync: the picture cut on its frame grid from the sound's clock, a framing
plan's holes rendered rather than skipped, and the keep list in time order.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

from media_render import plan as plan_lib
from media_render.render_lib import (
    build_layout_graph,
    build_video_filter,
    ffmpeg_exe,
    layout_pieces,
    plan_programme_parts,
    programme_audio_graph,
    programme_part_graph,
    render_audio,
    render_clip_video,
    slice_audio,
    snap_segments,
)

# 1.020 s kept out of every 1.5 s, forty times: 40.800 s of output. Trimmed
# per segment at 30 fps each one held 31 frames (1.033 s), and the picture ran
# 0.533 s past its sound.
FORTY_CUTS = [(k * 1_500, k * 1_500 + 1_020) for k in range(40)]
FPS = 30


class SnapSegmentsTest(unittest.TestCase):
    """Bug 1 — every keep boundary lands on the frame grid once, on the audio's clock."""

    def test_the_frame_count_follows_the_audio_running_total(self):
        spans = snap_segments(FORTY_CUTS, FPS)
        self.assertEqual(len(spans), 40)
        self.assertEqual(sum(b - a for a, b in spans), 1224)  # 40.800 s x 30 fps — not 40 x 31
        self.assertTrue(all(b - a in (30, 31) for a, b in spans))
        out_ms = out_frames = 0
        for (s, e), (a, b) in zip(FORTY_CUTS, spans):
            # the boundary is never more than half a frame off the sound…
            self.assertLessEqual(abs(out_frames / FPS - out_ms / 1000), 0.5 / FPS + 1e-9)
            # …and the segment opens on the source frame nearest the sound that plays under it
            under = s / 1000 + (out_frames / FPS - out_ms / 1000)
            self.assertLessEqual(abs(a / FPS - under), 0.5 / FPS + 1e-9)
            out_ms += e - s
            out_frames += b - a
        self.assertLessEqual(abs(out_frames / FPS - out_ms / 1000), 0.5 / FPS + 1e-9)

    def test_frames_are_relative_to_the_decode_and_slivers_keep_their_place(self):
        self.assertEqual(
            snap_segments([(60_000, 64_000), (66_000, 70_000)], FPS, base_ms=60_000), [(0, 120), (180, 300)]
        )
        # a 10 ms sliver holds no frame: dropped from the picture, the sound keeps
        # it and the next boundary absorbs the fraction
        slivered = [(0, 1_000), (2_000, 2_010), (3_000, 4_000)]
        self.assertEqual(snap_segments(slivered, FPS), [(0, 30), (90, 120)])
        self.assertEqual(snap_segments(slivered, FPS, drop_empty=False), [(0, 30), (60, 60), (90, 120)])
        self.assertEqual(snap_segments([], FPS), [])
        self.assertEqual(snap_segments([(500, 500)], FPS), [])

    def test_separate_parts_share_the_output_clock_at_each_boundary(self):
        """Changing the part size must not change the edited timeline's frame count."""
        keep = [(0, 25_123), (30_456, 59_001)]
        for fps in (24, 25, 30, 60):
            for part_ms in (1_020, 1_007, 10_020):
                with self.subTest(fps=fps, part_ms=part_ms):
                    frames = 0
                    for part in plan_programme_parts(keep, part_ms=part_ms):
                        spans = snap_segments(
                            part['keep'], fps, part['keep'][0][0], output_start_ms=part['out_start_ms']
                        )
                        frames += sum(b - a for a, b in spans)
                        self.assertLessEqual(abs(frames / fps - part['out_end_ms'] / 1000), 0.5 / fps + 1e-9)


class FrameGridGraphTest(unittest.TestCase):
    """The graphs trim at the snapped boundaries — exact where a whole millisecond is not."""

    def test_the_clip_graph_trims_on_the_grid(self):
        graph = build_video_filter(FORTY_CUTS, 'wide', 320, 180, FPS, None)
        self.assertIn('[b0]trim=start=0.000:end=1.033333,', graph)  # 31 frames: the running total is 30.6
        self.assertIn('[b1]trim=start=1.500:end=2.500,', graph)  # 30 frames: 61.2 - 30.6 -> 61 - 31
        self.assertIn('concat=n=40:v=1:a=0[joined]', graph)
        # a whole-millisecond boundary prints as it always has
        self.assertIn('trim=start=0.000:end=10.000,', build_video_filter([(0, 10_000)], 'wide', 320, 180, FPS, None))
        with self.assertRaises(ValueError):
            build_video_filter([(0, 10)], 'wide', 320, 180, FPS, None)

    def test_the_programme_part_graph_trims_on_the_same_grid(self):
        graph = programme_part_graph(FORTY_CUTS, 320, 180, FPS)
        self.assertIn('[b0]trim=start=0.000:end=1.033333,', graph)
        self.assertIn('[b1]trim=start=1.500:end=2.500,', graph)

    def test_the_layout_graph_renders_no_piece_that_holds_no_frame(self):
        plan = {'canvas': {'width': 180, 'height': 320}, 'segments': [], 'paths': []}
        seg = {'layout': 'full_frame', 'subjects': []}
        pieces = [
            {'start_ms': 0, 'end_ms': 1_000, 'segment_index': 0, 'segment': seg},
            {'start_ms': 2_000, 'end_ms': 2_010, 'segment_index': 0, 'segment': seg},
            {'start_ms': 3_000, 'end_ms': 4_000, 'segment_index': 0, 'segment': seg},
        ]
        work = Path(tempfile.mkdtemp(prefix='sync_layout_'))
        self.addCleanup(shutil.rmtree, work, True)
        graph = build_layout_graph(pieces, plan, 320, 180, FPS, None, work)
        self.assertIn('split=2[b0][b1]', graph)
        self.assertIn('[b0]trim=start=0.000:end=1.000,', graph)
        self.assertIn('[b1]trim=start=3.000:end=4.000,', graph)
        self.assertIn('concat=n=2:v=1:a=0[joined]', graph)
        with self.assertRaises(ValueError):
            build_layout_graph(pieces[1:2], plan, 320, 180, FPS, None, work)


class LayoutPiecesGapTest(unittest.TestCase):
    """Bug 2 — what the plan does not describe is rendered full frame and flagged, not dropped."""

    HOLE = [
        {'start_ms': 0, 'end_ms': 3_000, 'layout': 'fixed_crop', 'subjects': ['a']},
        {'start_ms': 5_000, 'end_ms': 10_000, 'layout': 'fixed_crop', 'subjects': ['a']},
    ]

    @staticmethod
    def _shape(pieces):
        return [(p['start_ms'], p['end_ms'], p['segment']['layout'], bool(p.get('fallback'))) for p in pieces]

    def test_a_hole_in_the_plan_is_filled_and_flagged(self):
        pieces = layout_pieces([(0, 10_000)], self.HOLE)
        self.assertEqual(
            self._shape(pieces),
            [(0, 3_000, 'fixed_crop', False), (3_000, 5_000, 'full_frame', True), (5_000, 10_000, 'fixed_crop', False)],
        )
        self.assertEqual([p['segment_index'] for p in pieces], [0, None, 1])
        self.assertEqual(sum(p['end_ms'] - p['start_ms'] for p in pieces), 10_000)  # exactly the keep

    def test_a_lead_in_and_a_tail_the_plan_never_reached(self):
        plan = [{'start_ms': 4_000, 'end_ms': 9_000, 'layout': 'solo_follow', 'subjects': ['a']}]
        self.assertEqual(
            self._shape(layout_pieces([(2_000, 12_000)], plan)),
            [
                (2_000, 4_000, 'full_frame', True),
                (4_000, 9_000, 'solo_follow', False),
                (9_000, 12_000, 'full_frame', True),
            ],
        )

    def test_a_plan_that_misses_the_material_covers_each_keep_range_on_its_own(self):
        """Never one piece spanning the cut between two keep ranges (6 s of picture for 2 s of sound)."""
        pieces = layout_pieces(
            [(0, 1_000), (5_000, 6_000)], [{**s, 'start_ms': 100_000, 'end_ms': 110_000} for s in self.HOLE]
        )
        self.assertEqual(self._shape(pieces), [(0, 1_000, 'full_frame', True), (5_000, 6_000, 'full_frame', True)])
        # …and a hole is filled inside each range, not across the cut
        pieces = layout_pieces([(0, 4_000), (4_500, 10_000)], self.HOLE)
        self.assertEqual(
            self._shape(pieces),
            [
                (0, 3_000, 'fixed_crop', False),
                (3_000, 4_000, 'full_frame', True),
                (4_500, 5_000, 'full_frame', True),
                (5_000, 10_000, 'fixed_crop', False),
            ],
        )

    def test_a_sliver_is_folded_into_its_neighbour_rather_than_flashed(self):
        crop = {'layout': 'fixed_crop', 'subjects': ['a']}
        # a 30 ms hole: the piece before it takes it, nothing is flagged
        plan = [{**crop, 'start_ms': 0, 'end_ms': 3_000}, {**crop, 'start_ms': 3_030, 'end_ms': 10_000}]
        self.assertEqual(
            self._shape(layout_pieces([(0, 10_000)], plan)),
            [(0, 3_030, 'fixed_crop', False), (3_030, 10_000, 'fixed_crop', False)],
        )
        # a 20 ms lead-in: the first piece starts early
        plan = [{**crop, 'start_ms': 3_000, 'end_ms': 10_000}]
        self.assertEqual(self._shape(layout_pieces([(2_980, 10_000)], plan)), [(2_980, 10_000, 'fixed_crop', False)])
        # a 30 ms plan segment is too short to render: its stretch goes to the piece before it
        plan = [
            {**crop, 'start_ms': 0, 'end_ms': 3_000},
            {'start_ms': 3_000, 'end_ms': 3_030, 'layout': 'solo_follow', 'subjects': ['a']},
            {**crop, 'start_ms': 3_030, 'end_ms': 10_000},
        ]
        self.assertEqual(
            self._shape(layout_pieces([(0, 10_000)], plan)),
            [(0, 3_030, 'fixed_crop', False), (3_030, 10_000, 'fixed_crop', False)],
        )
        # the whole keep list is covered, whatever the plan looks like
        for keep, segments in (
            ([(0, 10_000)], plan),
            ([(0, 4_000), (4_500, 10_000)], self.HOLE),
            ([(2_000, 12_000)], [{**crop, 'start_ms': 4_000, 'end_ms': 9_000}]),
        ):
            self.assertEqual(
                sum(p['end_ms'] - p['start_ms'] for p in layout_pieces(keep, segments)), sum(e - s for s, e in keep)
            )

    def test_overlapping_or_unsorted_plan_segments_never_double_the_picture(self):
        crop = {'layout': 'fixed_crop', 'subjects': ['a']}
        plan = [{**crop, 'start_ms': 4_000, 'end_ms': 10_000}, {**crop, 'start_ms': 0, 'end_ms': 6_000}]
        pieces = layout_pieces([(0, 10_000)], plan)
        self.assertEqual(self._shape(pieces), [(0, 6_000, 'fixed_crop', False), (6_000, 10_000, 'fixed_crop', False)])
        self.assertEqual([p['segment_index'] for p in pieces], [1, 0])


class KeepOrderTest(unittest.TestCase):
    """Bug 3 — the keep list is cut in time order, and two ranges never share material."""

    def test_as_ranges_sorts_by_start(self):
        rows = [[5_000, 6_000], [0, 1_000], {'start_ms': 2_000, 'end_ms': 3_000}, [1_000, 1_000]]
        self.assertEqual(plan_lib.as_ranges(rows), [(0, 1_000), (2_000, 3_000), (5_000, 6_000)])

    def test_resolve_keep_cuts_in_time_order(self):
        plan = plan_lib.resolve_keep({'keep': [[5_000, 6_000], [0, 1_000]]})
        self.assertEqual(plan['keep'], [(0, 1_000), (5_000, 6_000)])
        self.assertEqual(plan['full_keep'], [(0, 1_000), (5_000, 6_000)])
        self.assertEqual(plan['map'], [[0, 1_000, 0], [5_000, 6_000, 1_000]])
        self.assertEqual(plan['body_ms'], 2_000)

    def test_overlapping_keep_is_refused(self):
        for keep in ([[0, 1_500], [1_000, 2_000]], [[1_000, 2_000], [0, 1_500]], [[0, 5_000], [1_000, 2_000]]):
            with self.assertRaisesRegex(ValueError, 'keep intervals must not overlap'):
                plan_lib.resolve_keep({'keep': keep})
        with self.assertRaises(plan_lib.SpecError):  # a spec problem, worded for the person who wrote it
            plan_lib.resolve_keep({'keep': [[0, 1_500], [1_000, 2_000]]})

    def test_touching_keep_ranges_are_fine(self):
        plan = plan_lib.resolve_keep({'keep': [[1_000, 2_000], [0, 1_000]]})
        self.assertEqual(plan['keep'], [(0, 1_000), (1_000, 2_000)])


def _ffmpeg_available() -> bool:
    exe = ffmpeg_exe()
    return bool(shutil.which(exe) or os.path.exists(exe))


@unittest.skipUnless(_ffmpeg_available(), 'no ffmpeg binary reachable')
@unittest.skipIf(os.environ.get('MEDIA_TOOLKIT_SKIP_FFMPEG'), 'ffmpeg smoke test disabled')
class RenderedSyncTest(unittest.TestCase):
    """Measured on real renders: the streams' own durations, forty cuts apart."""

    END_MS = FORTY_CUTS[-1][1]

    @classmethod
    def setUpClass(cls):
        cls.work = Path(tempfile.mkdtemp(prefix='sync_render_'))
        cls.source = cls.work / 'source.mp4'
        subprocess.run(
            [
                ffmpeg_exe(),
                '-hide_banner',
                '-nostdin',
                '-y',
                '-f',
                'lavfi',
                '-i',
                f'testsrc2=size=320x180:rate={FPS}:duration=60',
                '-f',
                'lavfi',
                '-i',
                'sine=frequency=440:sample_rate=48000:duration=60',
                '-c:v',
                'libx264',
                '-preset',
                'ultrafast',
                '-pix_fmt',
                'yuv420p',
                '-c:a',
                'aac',
                '-shortest',
                str(cls.source),
            ],
            check=True,
            capture_output=True,
            text=True,
        )

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.work, ignore_errors=True)

    @staticmethod
    def _seconds(path: Path, kind: str) -> float:
        import av

        with av.open(str(path)) as container:
            stream = container.streams.video[0] if kind == 'video' else container.streams.audio[0]
            return float(stream.duration * stream.time_base)

    def _video_only(self, graph: str, start_ms: int, end_ms: int, name: str) -> Path:
        """The picture alone, so no `-shortest` can hide a mismatch."""
        out = self.work / name
        subprocess.run(
            [
                ffmpeg_exe(),
                '-hide_banner',
                '-nostdin',
                '-y',
                '-ss',
                f'{start_ms / 1000:.3f}',
                '-t',
                f'{(end_ms - start_ms) / 1000:.3f}',
                '-i',
                str(self.source),
                '-filter_complex',
                graph,
                '-map',
                '[vout]',
                '-an',
                '-c:v',
                'libx264',
                '-preset',
                'ultrafast',
                '-r',
                str(FPS),
                '-pix_fmt',
                'yuv420p',
                str(out),
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        return out

    def _audio_cut(self, keep, name: str) -> Path:
        wav = slice_audio(self.source, 0, self.END_MS, self.work / f'{name}-source.wav')
        return render_audio(
            wav, keep, self.work / f'{name}.wav', master=False, denoise=False, highpass=False, compress=False
        )

    def test_forty_cuts_keep_the_picture_on_its_sound(self):
        audio = self._audio_cut(FORTY_CUTS, 'forty')
        video = self._video_only(
            build_video_filter(FORTY_CUTS, 'wide', 320, 180, FPS, None), 0, self.END_MS, 'forty.mp4'
        )
        a, v = self._seconds(audio, 'audio'), self._seconds(video, 'video')
        self.assertAlmostEqual(a, 40.8, delta=0.002)
        self.assertLess(abs(v - a), 1 / FPS)  # was 41.333 s of picture for 40.800 s of sound
        # through the real entry point nothing is left for `-shortest` to throw away
        clip = render_clip_video(
            self.source,
            0,
            self.END_MS,
            FORTY_CUTS,
            audio,
            self.work / 'clip.mp4',
            layout='wide',
            width=320,
            height=180,
            fps=FPS,
        )
        self.assertLess(abs(self._seconds(clip, 'video') - 40.8), 1 / FPS)
        self.assertLess(abs(self._seconds(clip, 'video') - self._seconds(clip, 'audio')), 1 / FPS)

    def test_a_hole_in_the_plan_keeps_the_picture_as_long_as_the_sound(self):
        keep = [(0, 10_000)]
        plan = {
            'source': {'width': 320, 'height': 180},
            'canvas': {'width': 180, 'height': 320},
            'segments': LayoutPiecesGapTest.HOLE,
            'paths': [
                {'segment': 0, 'subject': 'a', 'w': 100, 'h': 180, 'keyframes': [[0, 10, 0]]},
                {'segment': 1, 'subject': 'a', 'w': 100, 'h': 180, 'keyframes': [[5_000, 10, 0]]},
            ],
        }
        audio = self._audio_cut(keep, 'hole')
        pieces = layout_pieces(keep, plan['segments'])
        graph = build_layout_graph(pieces, plan, 320, 180, FPS, None, self.work)
        video = self._video_only(graph, 0, 10_000, 'hole.mp4')
        self.assertLess(abs(self._seconds(video, 'video') - self._seconds(audio, 'audio')), 1 / FPS)  # was 8 s vs 10 s
        self.assertTrue(any(p.get('fallback') for p in pieces))  # the caller warns off this flag

    def test_programme_parts_match_the_one_pass_audio(self):
        video = self._video_only(programme_part_graph(FORTY_CUTS, 320, 180, FPS), 0, self.END_MS, 'part.mp4')
        graph = programme_audio_graph(FORTY_CUTS, noise_reduction=False, high_pass=False, compression=False)
        audio = self.work / 'programme.wav'
        subprocess.run(
            [
                ffmpeg_exe(),
                '-hide_banner',
                '-nostdin',
                '-y',
                '-i',
                str(self.source),
                '-filter_complex',
                f'{graph};[pre]aresample=48000[out]',
                '-map',
                '[out]',
                '-c:a',
                'pcm_s16le',
                str(audio),
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        self.assertLess(abs(self._seconds(video, 'video') - self._seconds(audio, 'audio')), 1 / FPS)  # was +0.533 s

    def test_multipart_node_render_stays_in_sync_before_final_mux(self):
        """Measure every real encoded part; final -shortest must not conceal drift."""
        from media_render import IInstance
        from .test_streams import feed, node

        keep = [(0, 60_000)]
        parts = plan_programme_parts(keep, part_ms=1_020)
        module = __import__(IInstance.__module__, fromlist=['IInstance'])
        for framed in (False, True):
            with self.subTest(framed=framed):
                spec = {
                    'kind': 'media_render_spec',
                    'pipeline': 'programme',
                    'keep': keep,
                    'chunking': {'part_ms': 1_020},
                    'audio': {'master': False, 'denoise': False, 'highpass': False, 'compress': False},
                    'thumbnail': False,
                    'subtitles': {'enabled': False, 'sidecars': False},
                    'outputs': [{'key': 'wide', 'file': 'result.mp4', 'width': 160, 'height': 90, 'fps': FPS}],
                }
                if framed:
                    spec['outputs'][0]['framing'] = True
                    spec['framing_plan'] = {
                        'source': {'width': 320, 'height': 180},
                        'canvas': {'width': 160, 'height': 90},
                        'segments': [{'start_ms': 0, 'end_ms': 60_000, 'layout': 'fixed_crop', 'subjects': ['a']}],
                        'paths': [{'segment': 0, 'subject': 'a', 'w': 320, 'h': 180, 'keyframes': [[0, 0, 0]]}],
                    }
                renderer = 'render_layout_part' if framed else 'render_programme_part'
                original = getattr(module, renderer)
                durations = []

                def measured_render(*args, **kwargs):
                    result = original(*args, **kwargs)
                    durations.append(self._seconds(result, 'video'))
                    expected = parts[len(durations) - 1]['out_end_ms'] / 1000
                    self.assertLessEqual(
                        abs(sum(durations) - expected),
                        0.5 / FPS + 1e-6,
                        f'part {len(durations)}: cumulative={sum(durations)}, expected={expected}, last={durations[-1]}',
                    )
                    return result

                instance = node({'spec': spec})
                try:
                    with patch.object(module, renderer, side_effect=measured_render):
                        feed(instance, self.source)
                        instance.closing()
                    self.assertEqual(len(durations), len(parts))
                    final = self.work / f'multipart-{framed}.mp4'
                    final.write_bytes(instance.instance.files['result.mp4'])
                    self.assertAlmostEqual(self._seconds(final, 'video'), 60, delta=1 / FPS)
                    self.assertAlmostEqual(self._seconds(final, 'audio'), 60, delta=1 / FPS)
                finally:
                    instance.close()


if __name__ == '__main__':
    unittest.main()
