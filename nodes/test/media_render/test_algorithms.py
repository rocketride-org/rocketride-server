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

"""Render graphs, request validation, reports, and real-media regressions."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest
import unittest.mock
from pathlib import Path


from media_render import plan as plan_lib
from media_render import render_lib as render_lib_module
from media_render import report as report_lib

from media_render.render_lib import (  # noqa: E402
    BLEEP_DB,
    PROGRAMME_PART_MS,
    LOUDNESS_TARGET_LUFS,
    TRUE_PEAK_DBTP,
    aspect_dims,
    build_layout_graph,
    build_video_filter,
    capped_dims,
    caption_layout_for,
    channel_filter,
    chapters_payload,
    display_dims,
    programme_audio_graph,
    programme_part_graph,
    ffmetadata_chapters,
    ffmpeg_exe,
    layout_pieces,
    loudnorm_filter,
    panel_fit,
    panel_rects,
    parse_aspect,
    plan_programme_parts,
    probe,
    range_to_keep,
    reframe_chain,
    render_layout_part,
    HOUSE_TAGS,
    VIDEO_COLOUR_ARGS,
    sar_of,
    source_colour_warning,
    source_normalize,
    screen_share_split,
    shift_groups,
    canonical_numbers,
    spec_hash,
    square_pixels,
)
from media_render.captions import build_ass  # noqa: E402


KEEP = [(0, 10_000), (15_000, 20_000)]


class ProgrammeAudioGraphTest(unittest.TestCase):
    def test_mutes_and_bleeps_are_applied_on_the_source_timeline(self):
        """Silencing has to happen before the trims, or a cut would move it."""
        graph = programme_audio_graph(KEEP, mutes=[(2_000, 2_500)], bleeps=[(17_000, 17_600)])
        head = graph.split(';')[0]
        self.assertTrue(head.startswith('[0:a]'))
        self.assertIn("volume=enable='between(t,2.000,2.500)':volume=0", head)
        # the speech under a bleep is zeroed too — the tone replaces it
        self.assertIn("volume=enable='between(t,17.000,17.600)':volume=0", head)
        self.assertLess(graph.index('volume=enable'), graph.index('atrim'))

    def test_bleep_is_a_1khz_sine_at_minus_14_db_gated_to_its_range(self):
        graph = programme_audio_graph(KEEP, bleeps=[(17_000, 17_600)])
        self.assertIn('sine=frequency=1000:sample_rate=48000:duration=17.600', graph)
        self.assertIn(f'volume={BLEEP_DB}dB', graph)
        # `enable` bypasses the filter, so volume=0 sits OUTSIDE the bleep window
        self.assertIn("volume=enable='not(between(t,17.000,17.600))':volume=0:eval=frame[tone]", graph)
        self.assertIn('[speech_src][tone]amix=inputs=2:duration=first:dropout_transition=0:normalize=0', graph)

    def test_no_bleep_means_no_tone_generator(self):
        graph = programme_audio_graph(KEEP)
        self.assertNotIn('sine=', graph)
        self.assertNotIn('[tone]', graph)

    def test_keep_list_is_trimmed_and_concatenated_never_crossfaded(self):
        graph = programme_audio_graph(KEEP)
        self.assertIn('[k0]atrim=start=0.000:end=10.000', graph)
        self.assertIn('[k1]atrim=start=15.000:end=20.000', graph)
        self.assertIn('[a0][a1]concat=n=2:v=0:a=1[cat]', graph)
        self.assertNotIn('xfade', graph)
        self.assertNotIn('acrossfade', graph)

    def test_a_single_keep_segment_skips_the_split_and_the_concat(self):
        graph = programme_audio_graph([(0, 5_000)])
        self.assertNotIn('asplit', graph.split('afade')[0])
        self.assertNotIn('concat', graph)
        self.assertTrue(graph.endswith('[pre]'))

    def test_clean_up_stages_follow_the_spec_flags(self):
        full = programme_audio_graph(KEEP, noise_reduction=True, high_pass=True, compression=True)
        self.assertIn('afftdn=nr=10:nf=-40,highpass=f=80,acompressor=', full)
        none = programme_audio_graph(KEEP, noise_reduction=False, high_pass=False, compression=False)
        for stage in ('afftdn', 'highpass', 'acompressor'):
            self.assertNotIn(stage, none)
        rough = programme_audio_graph(KEEP, noise_reduction=False, high_pass=True, compression=False)
        self.assertIn('highpass=f=80[clean]', rough)
        self.assertNotIn('afftdn', rough)

    def test_music_is_ducked_by_a_sidechain_fed_from_the_speech(self):
        graph = programme_audio_graph(KEEP, music={'gain_db': -22, 'duck_db': -12, 'fade_ms': 1500})
        self.assertIn('asplit=2[spk][sc]', graph)  # one copy plays, one drives the duck
        self.assertIn('volume=-22.0dB', graph)
        self.assertIn('afade=t=in:d=1.500', graph)
        self.assertIn('[mus][sc]sidechaincompress=threshold=0.03:ratio=8.0:attack=20:release=400[duck]', graph)
        self.assertIn('[spk][duck]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[mixed]', graph)
        # the bed is trimmed to the OUTPUT length (15 s of keep), not the source length
        self.assertIn('atrim=end=15.000', graph)

    def test_duck_depth_scales_the_compression_ratio(self):
        gentle = programme_audio_graph(KEEP, music={'gain_db': -20, 'duck_db': -6, 'fade_ms': 500})
        self.assertIn('ratio=4.0', gentle)
        hard = programme_audio_graph(KEEP, music={'gain_db': -20, 'duck_db': -24, 'fade_ms': 500})
        self.assertIn('ratio=16.0', hard)

    def test_programme_fades_close_at_the_end_of_the_output(self):
        graph = programme_audio_graph(KEEP, fade_in_ms=500, fade_out_ms=2000)
        self.assertIn('afade=t=in:d=0.500,afade=t=out:st=13.000:d=2.000[pre]', graph)

    def test_empty_keep_is_refused(self):
        with self.assertRaises(ValueError):
            programme_audio_graph([])


class MasteringGraphTest(unittest.TestCase):
    """The loudness pass belongs on the finished programme, not on the body."""

    STATS = {
        'input_i': '-23.4',
        'input_tp': '-4.1',
        'input_lra': '6.2',
        'input_thresh': '-33.9',
        'target_offset': '0.3',
    }

    def test_the_body_pass_never_masters_on_its_own(self):
        """programme_audio_graph ends at [pre] — no loudnorm anywhere inside it."""
        graph = programme_audio_graph(KEEP, mutes=[(2_000, 2_500)], music={'gain_db': -22})
        self.assertNotIn('loudnorm', graph)
        self.assertTrue(graph.endswith('[pre]'))

    def test_the_first_pass_only_measures(self):
        first = loudnorm_filter(-16)
        self.assertEqual(first, f'loudnorm=I=-16.0:TP={TRUE_PEAK_DBTP}:LRA=11.0')
        self.assertNotIn('measured_I', first)
        self.assertEqual(loudnorm_filter(), f'loudnorm=I={LOUDNESS_TARGET_LUFS}:TP={TRUE_PEAK_DBTP}:LRA=11.0')

    def test_the_second_pass_carries_the_measurement_and_goes_linear(self):
        second = loudnorm_filter(-16, self.STATS)
        self.assertIn('measured_I=-23.4', second)
        self.assertIn('measured_TP=-4.1', second)
        self.assertIn('measured_LRA=6.2', second)
        self.assertIn('measured_thresh=-33.9', second)
        self.assertIn('offset=0.3', second)
        self.assertTrue(second.endswith(':linear=true'))

    def test_an_incomplete_measurement_falls_back_to_the_plain_filter(self):
        self.assertEqual(loudnorm_filter(-16, {'input_i': '-20'}), loudnorm_filter(-16))
        self.assertEqual(loudnorm_filter(-16, None), loudnorm_filter(-16))

    def test_a_target_from_the_edit_file_reaches_the_filter(self):
        self.assertIn('I=-14.0', loudnorm_filter(-14))


class ProgrammePartsTest(unittest.TestCase):
    def test_a_long_keep_segment_is_split_inside_itself(self):
        parts = plan_programme_parts([(0, 700_000), (800_000, 830_000)])
        self.assertEqual([p['n'] for p in parts], [1, 2, 3])
        self.assertEqual(parts[0]['keep'], [[0, 300_000]])
        self.assertEqual(parts[1]['keep'], [[300_000, 600_000]])
        self.assertEqual(parts[2]['keep'], [[600_000, 700_000], [800_000, 830_000]])

    def test_output_times_are_contiguous_and_total_the_keep_length(self):
        keep = [(0, 412_000), (500_000, 913_500), (1_000_000, 1_004_000)]
        parts = plan_programme_parts(keep)
        total = sum(e - s for s, e in keep)
        self.assertEqual(parts[0]['out_start_ms'], 0)
        self.assertEqual(parts[-1]['out_end_ms'], total)
        for a, b in zip(parts, parts[1:]):
            self.assertEqual(a['out_end_ms'], b['out_start_ms'])
        self.assertEqual(sum(p['duration_ms'] for p in parts), total)
        # nothing is lost or duplicated: the slices rebuild the keep list
        flat = [tuple(x) for p in parts for x in p['keep']]
        merged: list[list[int]] = []
        for s, e in flat:
            if merged and merged[-1][1] == s:
                merged[-1][1] = e
            else:
                merged.append([s, e])
        self.assertEqual([tuple(m) for m in merged], keep)

    def test_a_short_tail_is_folded_into_the_previous_part(self):
        parts = plan_programme_parts([(0, 305_000)])
        self.assertEqual(len(parts), 1)
        self.assertEqual(parts[0]['duration_ms'], 305_000)

    def test_short_programmes_are_one_part(self):
        parts = plan_programme_parts([(0, 60_000)], part_ms=PROGRAMME_PART_MS)
        self.assertEqual(len(parts), 1)
        self.assertEqual(parts[0]['keep'], [[0, 60_000]])
        self.assertEqual(plan_programme_parts([]), [])


class SpecHashTest(unittest.TestCase):
    BASE = {
        'version': 4,
        'source': 'projects/ep/source/a.mp4',
        'keep': [[0, 1000]],
        'mutes': [],
        'audio': {'master': True},
        'visual': {'aspect_ratio': '16:9'},
    }

    def test_range_and_quality_do_not_change_the_hash(self):
        """A range preview must not invalidate the export's finished parts."""
        a = spec_hash({**self.BASE, 'range': None, 'quality': 'full'})
        b = spec_hash({**self.BASE, 'range': [0, 30_000], 'quality': 'rough'})
        self.assertEqual(a, b)

    def test_an_edit_changes_the_hash(self):
        a = spec_hash(self.BASE)
        self.assertNotEqual(a, spec_hash({**self.BASE, 'keep': [[0, 900]]}))
        self.assertNotEqual(a, spec_hash({**self.BASE, 'visual': {'aspect_ratio': '9:16'}}))
        self.assertEqual(len(a), 16)

    # ------------------------------------------------- one number, one spelling

    RICH = {
        'version': 4,
        'source': 'projects/ep/source/a.mp4',
        'pipeline': 'clip',
        'keep': [[0.0, 1000.0], [2000, 3000]],
        'mutes': [],
        'audio': {'master': True, 'gain_db': -1.0, 'music': {'volume': 1.0, 'duck_db': -12.5}},
        'visual': {
            'aspect_ratio': '9:16',
            'sar': 1.0,
            'framing_plan': {'segments': [{'at': 0.0, 'panels': [{'x': 0.0, 'w': 1080.0}]}]},
        },
        'outputs': [{'name': 'vertical', 'long_edge': 1920.0, 'fps': 30.0, 'crf': 20}],
    }

    # `RICH` exactly as a JSON writer that is not Python spells it. Produced by
    # running JSON.stringify(JSON.parse(python_json)) under node and pasted
    # here, so the fixture is the real wire format and not this test's idea of
    # it: `1.0` is written `1`, `-1.0` is `-1`, and `-12.5` is untouched.
    RICH_ON_THE_WIRE = (
        '{"version":4,"source":"projects/ep/source/a.mp4","pipeline":"clip",'
        '"keep":[[0,1000],[2000,3000]],"mutes":[],'
        '"audio":{"master":true,"gain_db":-1,"music":{"volume":1,"duck_db":-12.5}},'
        '"visual":{"aspect_ratio":"9:16","sar":1,'
        '"framing_plan":{"segments":[{"at":0,"panels":[{"x":0,"w":1080}]}]}},'
        '"outputs":[{"name":"vertical","long_edge":1920,"fps":30,"crf":20}]}'
    )

    def test_a_spec_and_its_json_round_trip_are_one_identity(self):
        """Python whole floats and JavaScript JSON integers must identify the same render."""
        from_the_wire = json.loads(self.RICH_ON_THE_WIRE)
        # the two documents ARE the same document (`1.0 == 1` in any language);
        # what differs is how each side spells it, which is the whole problem
        self.assertIsInstance(self.RICH['visual']['sar'], float)
        self.assertIsInstance(from_the_wire['visual']['sar'], int)
        self.assertEqual(spec_hash(self.RICH), spec_hash(from_the_wire))
        self.assertEqual(plan_lib.spec_identity(self.RICH), plan_lib.spec_identity(from_the_wire))
        # and Python's own round trip, which keeps every `1.0` a float, agrees too
        self.assertEqual(spec_hash(self.RICH), spec_hash(json.loads(json.dumps(self.RICH))))

    def test_a_number_that_is_not_whole_still_says_so(self):
        """Canonicalising is not rounding: 0.5 is a different render from 1."""
        self.assertNotEqual(spec_hash({**self.BASE, 'speed': 1.0}), spec_hash({**self.BASE, 'speed': 1.5}))
        self.assertNotEqual(spec_hash({**self.BASE, 'speed': 0.0}), spec_hash({**self.BASE, 'speed': 0.5}))

    def test_only_whole_floats_move_and_only_at_a_size_json_agrees_on(self):
        self.assertEqual(
            canonical_numbers({'a': 1.0, 'b': [2.0, (3.0, 4.5)], 'c': {'d': -0.0}}),
            {'a': 1, 'b': [2, [3, 4.5]], 'c': {'d': 0}},
        )
        # a bool is not a number to canonicalise, and a string is left alone
        self.assertEqual(
            canonical_numbers({'on': True, 'off': False, 'text': '1.0', 'n': 7}),
            {'on': True, 'off': False, 'text': '1.0', 'n': 7},
        )
        self.assertIs(canonical_numbers({'on': True})['on'], True)
        # past 2**53 an integral float is no longer exactly an integer and no
        # JSON writer spells it plainly: it stays exactly as the document has it
        big = float(2**53)
        self.assertEqual(canonical_numbers({'big': big}), {'big': big})
        self.assertIsInstance(canonical_numbers({'big': big})['big'], float)
        for odd in (float('inf'), float('-inf')):
            self.assertEqual(canonical_numbers({'x': odd}), {'x': odd})


class RangeMappingTest(unittest.TestCase):
    # two kept pieces: source 0-10s -> output 0-10s, source 15-20s -> output 10-15s
    MAP = [[0, 10_000, 0], [15_000, 20_000, 10_000]]

    def test_a_window_inside_one_piece_maps_straight_back(self):
        self.assertEqual(range_to_keep(self.MAP, 2_000, 5_000), [(2_000, 5_000)])

    def test_a_window_across_a_cut_becomes_two_source_slices(self):
        self.assertEqual(range_to_keep(self.MAP, 9_000, 11_000), [(9_000, 10_000), (15_000, 16_000)])

    def test_a_window_in_the_tail_maps_past_the_cut(self):
        self.assertEqual(range_to_keep(self.MAP, 12_000, 15_000), [(17_000, 20_000)])

    def test_empty_and_inverted_windows_give_nothing(self):
        self.assertEqual(range_to_keep(self.MAP, 5_000, 5_000), [])
        self.assertEqual(range_to_keep(self.MAP, 8_000, 4_000), [])
        self.assertEqual(range_to_keep([], 0, 1_000), [])

    def test_captions_shift_onto_a_part_timeline_and_drop_what_falls_outside(self):
        groups = [
            [{'word': 'one', 'start_ms': 500, 'end_ms': 900}],
            [{'word': 'two', 'start_ms': 5_000, 'end_ms': 5_400}],
            [{'word': 'three', 'start_ms': 11_000, 'end_ms': 11_500}],
        ]
        shifted = shift_groups(groups, 4_000, 5_000)
        self.assertEqual([g[0]['word'] for g in shifted], ['two'])
        self.assertEqual(shifted[0][0]['start_ms'], 1_000)
        self.assertEqual(shifted[0][0]['end_ms'], 1_400)
        # a lead-in (intro + title card) shifts every line later
        later = shift_groups(groups, -3_000)
        self.assertEqual(later[0][0]['start_ms'], 3_500)


class PartGraphTest(unittest.TestCase):
    def test_every_piece_gets_square_pixels_before_the_concat(self):
        graph = programme_part_graph([(60_000, 70_000), (80_000, 85_000)], 1920, 1080, 30, base_ms=60_000)
        self.assertEqual(graph.count('setsar=1'), 3)  # two pieces + the reframe
        self.assertIn('[v0][v1]concat=n=2:v=1:a=0[joined]', graph)
        for i in range(2):
            self.assertIn(f'setsar=1[v{i}]', graph)
        self.assertNotIn('xfade', graph)

    def test_trims_are_relative_to_the_parts_own_seek(self):
        """The part is decoded with -ss at its first keep start."""
        graph = programme_part_graph([(60_000, 70_000), (80_000, 85_000)], 1280, 720, 30, base_ms=60_000)
        self.assertIn('[b0]trim=start=0.000:end=10.000', graph)
        self.assertIn('[b1]trim=start=20.000:end=25.000', graph)

    def test_fit_on_blur_letterboxes_over_a_blurred_copy(self):
        graph = programme_part_graph([(0, 5_000)], 1080, 1920, 30, fit='fit', background='blur')
        self.assertIn('gblur=sigma=30', graph)
        self.assertIn('scale=1080:1920:force_original_aspect_ratio=decrease[rf_fgo]', graph)
        self.assertIn('overlay=(W-w)/2:(H-h)/2,setsar=1[rf_out]', graph)

    def test_fit_on_a_colour_pads_instead_of_blurring(self):
        graph = programme_part_graph([(0, 5_000)], 1080, 1080, 30, fit='fit', background='#101820')
        self.assertNotIn('gblur', graph)
        self.assertIn('pad=1080:1080:(ow-iw)/2:(oh-ih)/2:color=0x101820,setsar=1', graph)

    def test_fill_crops_to_cover(self):
        chain = reframe_chain(1080, 1920, 'fill', 'blur')
        self.assertEqual(len(chain), 1)
        self.assertIn('force_original_aspect_ratio=increase,crop=1080:1920,setsar=1', chain[0])

    def test_logo_then_captions_then_pixel_format(self):
        graph = programme_part_graph(
            [(0, 5_000)], 1920, 1080, 30, ass_path='/tmp/c.ass', logo={'corner': 'br', 'height': 0.12, 'opacity': 0.8}
        )
        self.assertIn('[1:v]scale=-1:130,format=rgba,colorchannelmixer=aa=0.800[lg]', graph)
        self.assertIn('[rf_out][lg]overlay=W-w-43:H-h-43:format=auto:shortest=1[logoed]', graph)
        self.assertLess(graph.index('[logoed]'), graph.index('subtitles'))
        self.assertTrue(graph.endswith(f'format=yuv420p,{HOUSE_TAGS}[vout]'))

    def test_a_part_with_no_frame_sized_slice_is_refused(self):
        with self.assertRaises(ValueError):
            programme_part_graph([(0, 10)], 1920, 1080, 30)


class AspectTest(unittest.TestCase):
    def test_1080p_is_measured_on_the_short_edge(self):
        self.assertEqual(aspect_dims('16:9'), (1920, 1080))
        self.assertEqual(aspect_dims('9:16'), (1080, 1920))
        self.assertEqual(aspect_dims('1:1'), (1080, 1080))
        self.assertEqual(aspect_dims('4:5'), (1080, 1350))

    def test_previews_cap_the_long_edge(self):
        self.assertEqual(capped_dims('16:9', 640), (640, 360))
        self.assertEqual(capped_dims('9:16', 640), (360, 640))
        self.assertEqual(capped_dims('16:9', 1280), (1280, 720))

    def test_unknown_aspects_fall_back_to_wide(self):
        self.assertEqual(parse_aspect(None), (16, 9))
        self.assertEqual(parse_aspect('nonsense'), (16, 9))
        self.assertEqual(parse_aspect('2:3'), (2, 3))

    def test_caption_geometry_follows_the_frame(self):
        self.assertEqual(caption_layout_for(1080, 1920), 'vertical')
        self.assertEqual(caption_layout_for(1920, 1080), 'wide')
        self.assertEqual(caption_layout_for(1080, 1080), 'wide')


class ChaptersTest(unittest.TestCase):
    MARKS = [{'title': 'Intro', 'out_ms': 0}, {'title': 'The interview', 'out_ms': 60_000}]

    def test_ffmetadata_header_and_timebase(self):
        text = ffmetadata_chapters(self.MARKS, 120_000, 'Programme 12')
        self.assertTrue(text.startswith(';FFMETADATA1\n'))
        self.assertIn('title=Programme 12', text)
        self.assertEqual(text.count('[CHAPTER]'), 2)
        self.assertEqual(text.count('TIMEBASE=1/1000'), 2)

    def test_each_chapter_ends_where_the_next_begins_and_the_last_at_the_end(self):
        text = ffmetadata_chapters(self.MARKS, 120_000)
        starts = [int(m) for m in re.findall(r'^START=(\d+)$', text, re.M)]
        ends = [int(m) for m in re.findall(r'^END=(\d+)$', text, re.M)]
        self.assertEqual(starts, [0, 60_000])
        self.assertEqual(ends, [60_000, 120_000])

    def test_marks_are_sorted_and_specials_escaped(self):
        text = ffmetadata_chapters([{'title': 'B=2', 'out_ms': 5_000}, {'title': 'A', 'out_ms': 0}], 10_000)
        self.assertLess(text.index('title=A'), text.index(r'title=B\=2'))

    def test_chapters_json_carries_ends_and_labels(self):
        payload = chapters_payload(self.MARKS, 3_723_000)
        self.assertEqual(payload['schema_version'], 1)
        self.assertEqual(
            payload['chapters'][0], {'title': 'Intro', 'start_ms': 0, 'end_ms': 60_000, 'start': '00:00:00'}
        )
        self.assertEqual(payload['chapters'][-1]['end_ms'], 3_723_000)
        self.assertEqual(payload['chapters'][-1]['start'], '00:01:00')


class SourceColourTest(unittest.TestCase):
    """Normalize camera input before cropping; retain limited-range 8-bit input unchanged."""

    EIGHT_BIT = {'sar': 1.0, 'width': 1920, 'height': 1080, 'pix_fmt': 'yuv420p', 'color_range': 'tv'}
    CAMERA = {'sar': 1.0, 'width': 3840, 'height': 2160, 'pix_fmt': 'yuv422p10le', 'color_range': 'pc'}

    @staticmethod
    def _plan():
        return {
            'source': {'width': 3840, 'height': 2160},
            'canvas': {'width': 1080, 'height': 1920},
            'segments': [{'layout': 'solo_follow', 'start_ms': 0, 'end_ms': 4_000, 'subjects': ['p1']}],
            'paths': [
                {
                    'segment': 0,
                    'subject': 'p1',
                    'panel': 'a',
                    'w': 1568,
                    'h': 1394,
                    'keyframes': [[0, 2071, 553], [4_000, 2071, 553]],
                }
            ],
        }

    def test_an_eight_bit_limited_source_is_left_exactly_as_it_was(self):
        """The whole point of the condition: existing material renders through the SAME graph."""
        self.assertEqual(source_normalize(self.EIGHT_BIT), '')
        self.assertEqual(source_normalize({'pix_fmt': 'yuv420p'}), '')  # range unstated
        self.assertEqual(source_normalize({}), '')  # probe said nothing
        self.assertEqual(source_normalize(None), '')
        for build in (
            lambda src: build_video_filter([(0, 5_000)], 'vertical', 1080, 1920, 30, None, source=src),
            lambda src: programme_part_graph([(0, 5_000)], 1080, 1920, 30, source=src),
        ):
            self.assertEqual(build(self.EIGHT_BIT), build(None))

    def test_an_eight_bit_source_renders_through_the_graph_it_always_did(self):
        """Byte for byte, with only the colour STATEMENT added at the end. That
        stamp converts nothing — it is there so `-color_range tv` matches the
        frames it is given; without it ffmpeg inserts a scaler that reads an
        untagged 8-bit recording as FULL range and quietly changes the levels
        of every render that ever worked.
        """
        work = Path(tempfile.mkdtemp(prefix='colour_graph_'))
        try:
            plan = self._plan()
            pieces = layout_pieces([(0, 4_000)], plan['segments'])
            graph = build_layout_graph(pieces, plan, 3840, 2160, 30, None, work, source=self.EIGHT_BIT)
            self.assertEqual(graph, build_layout_graph(pieces, plan, 3840, 2160, 30, None, work, source=None))
            # This test compares colour graphs; use the native platform's path escaping.
            cmd = render_lib_module._escape_filter_path(work / 'pan_0_p0a.cmd')
            self.assertEqual(
                graph.replace(',' + HOUSE_TAGS, ''),
                '[0:v]fps=30,setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop=1,split=1[b0];'
                '[b0]trim=start=0.000:end=4.000,setpts=PTS-STARTPTS,'
                f"sendcmd=f='{cmd}',crop@p0a=1568:1394:2071:553:exact=1,"
                'scale=1080:1920[v0];[v0]setsar=1[u0];[u0]format=yuv420p[vout]',
            )
        finally:
            shutil.rmtree(work, ignore_errors=True)

    def test_a_camera_source_is_converted_once_ahead_of_every_split_and_crop(self):
        work = Path(tempfile.mkdtemp(prefix='colour_graph_'))
        try:
            plan = self._plan()
            graph = build_layout_graph(
                layout_pieces([(0, 4_000)], plan['segments']), plan, 3840, 2160, 30, None, work, source=self.CAMERA
            )
            head = '[0:v]scale=in_range=pc:out_range=tv,format=yuv420p,'
            self.assertTrue(graph.startswith(head))
            self.assertEqual(graph.count('scale=in_range=pc:out_range=tv'), 1)  # ONCE, not per branch
            self.assertLess(graph.index('format=yuv420p'), graph.index('split='))
            self.assertLess(graph.index('format=yuv420p'), graph.index('crop@'))
            self.assertIn('crop@p0a=1568:1394:2071:553:exact=1', graph)  # still an odd x
            self.assertTrue(graph.endswith(f'format=yuv420p,{HOUSE_TAGS}[vout]'))
        finally:
            shutil.rmtree(work, ignore_errors=True)

    def test_every_graph_closes_on_the_same_colour_statement(self):
        work = Path(tempfile.mkdtemp(prefix='colour_graph_'))
        try:
            plan = self._plan()
            graphs = [
                build_video_filter([(0, 5_000)], 'vertical', 1080, 1920, 30, None, source=self.EIGHT_BIT),
                programme_part_graph([(0, 5_000)], 1080, 1920, 30, source=self.CAMERA),
                build_layout_graph(
                    layout_pieces([(0, 4_000)], plan['segments']), plan, 3840, 2160, 30, None, work, source=None
                ),
            ]
            for graph in graphs:
                self.assertTrue(graph.endswith(f'format=yuv420p,{HOUSE_TAGS}[vout]'), graph[-80:])
        finally:
            shutil.rmtree(work, ignore_errors=True)

    def test_the_conversion_comes_before_the_square_pixel_scale(self):
        """Both go first; the colour one goes FIRST first, so the scale is an 8-bit scale."""
        anamorphic = dict(self.CAMERA, sar=1.185185, width=4551)
        graph = build_video_filter([(0, 5_000)], 'vertical', 1080, 1920, 30, None, source=anamorphic)
        self.assertLess(graph.index('out_range=tv'), graph.index('scale=4551:2160,setsar=1'))

    def test_a_full_range_eight_bit_source_still_has_its_levels_corrected(self):
        chain = source_normalize({'pix_fmt': 'yuv420p', 'color_range': 'pc'})
        self.assertTrue(chain.startswith('scale=in_range=pc:out_range=tv,'))

    def test_an_unstated_range_is_left_to_swscale_rather_than_guessed(self):
        chain = source_normalize({'pix_fmt': 'yuv422p10le'})
        self.assertTrue(chain.startswith('scale=out_range=tv,'))
        self.assertNotIn('in_range', chain)

    def test_hdr_is_tone_mapped_when_the_build_can(self):
        hdr = dict(self.CAMERA, color_transfer='smpte2084')
        with unittest.mock.patch('media_render.render_lib.has_zscale', return_value=True):
            chain = source_normalize(hdr)
            self.assertIn('zscale=t=linear:npl=100', chain)
            self.assertIn('tonemap=tonemap=hable', chain)
            self.assertTrue(chain.endswith('format=yuv420p,'))
            self.assertIsNone(source_colour_warning(hdr))

    def test_hdr_on_a_build_without_zscale_falls_back_and_says_so(self):
        hdr = dict(self.CAMERA, color_transfer='arib-std-b67')
        with unittest.mock.patch('media_render.render_lib.has_zscale', return_value=False):
            self.assertNotIn('zscale', source_normalize(hdr))
            self.assertIn('tone-map', source_colour_warning(hdr))

    def test_a_log_profile_cannot_be_detected_and_the_caller_is_told(self):
        """A camera shooting S-Log / V-Log / Log-C writes a picture whose transfer
        is not Rec.709 and whose tags say nothing at all. Nothing downstream
        can tell it from an ordinary untagged recording, so it is passed
        through and the producer is told to apply the LUT first.
        """
        note = source_colour_warning(self.CAMERA)
        self.assertIsNotNone(note)
        self.assertIn('log profile', note)
        self.assertIsNone(source_colour_warning(self.EIGHT_BIT))
        self.assertIsNone(source_colour_warning({}))

    def test_every_render_path_states_the_colour_it_wrote(self):
        self.assertEqual(
            VIDEO_COLOUR_ARGS,
            ['-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709'],
        )


def _ffmpeg_available() -> bool:
    exe = ffmpeg_exe()
    return bool(shutil.which(exe) or os.path.exists(exe))


@unittest.skipUnless(_ffmpeg_available(), 'no ffmpeg binary reachable')
@unittest.skipIf(os.environ.get('MEDIA_TOOLKIT_SKIP_FFMPEG'), 'ffmpeg smoke test disabled')
class ProgrammeSmokeTest(unittest.TestCase):
    """One real render over a six second synthetic source (a few seconds of work)."""

    @staticmethod
    def _duration_ms(path: Path) -> int:
        out = subprocess.run([ffmpeg_exe(), '-hide_banner', '-i', str(path)], capture_output=True, text=True).stderr
        m = re.search(r'Duration:\s*(\d+):(\d+):(\d+\.\d+)', out)
        assert m, out[-400:]
        return int((int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))) * 1000)

    def test_cuts_mutes_and_bleeps_render_and_mux(self):
        from media_render.render_lib import (
            concat_parts,
            mux_programme,
            render_programme_audio,
            render_programme_part,
        )

        work = Path(tempfile.mkdtemp(prefix='studio_smoke_'))
        try:
            source = work / 'source.mp4'
            subprocess.run(
                [
                    ffmpeg_exe(),
                    '-hide_banner',
                    '-nostdin',
                    '-y',
                    '-f',
                    'lavfi',
                    '-i',
                    'testsrc2=size=640x360:rate=15:duration=6',
                    '-f',
                    'lavfi',
                    '-i',
                    'sine=frequency=440:sample_rate=48000:duration=6',
                    '-c:v',
                    'libx264',
                    '-preset',
                    'ultrafast',
                    '-pix_fmt',
                    'yuv420p',
                    '-c:a',
                    'pcm_s16le',
                    '-shortest',
                    str(source),
                ],
                check=True,
                capture_output=True,
                text=True,
            )
            keep = [(0, 2_000), (3_000, 6_000)]  # one second cut out of the middle
            audio = render_programme_audio(
                source,
                keep,
                work / 'body.wav',
                mutes=[(500, 800)],
                bleeps=[(4_000, 4_400)],
                noise_reduction=False,
                compression=False,
                master=False,
                channels=1,
            )
            self.assertTrue(audio.exists() and audio.stat().st_size > 40_000)
            part = render_programme_part(
                source,
                keep,
                work / 'part-001.mp4',
                320,
                180,
                fps=15,
                crf=32,
                preset='ultrafast',
                fit='fit',
                background='#000000',
            )
            joined = concat_parts([part], work / 'video.mp4', work)
            final = mux_programme(joined, audio, work / 'programme.mp4')
            self.assertAlmostEqual(self._duration_ms(final), 5_000, delta=400)
        finally:
            shutil.rmtree(work, ignore_errors=True)

    def test_a_loud_intro_cannot_push_the_finished_file_off_target(self):
        """The defect this guards: mastering the body alone and bolting the intro
        and outro on afterwards. Here the added clips are 25 dB louder than the
        programme body, so a body-only master would leave the finished mp4 far
        above -16 LUFS. Mastering the assembled programme lands it anyway.
        """
        from media_render.render_lib import (
            assemble_programme_audio,
            master_wav,
            measure_loudness,
            mux_programme,
        )

        work = Path(tempfile.mkdtemp(prefix='studio_master_'))
        try:

            def tone(name: str, seconds: float, hz: int, volume: str) -> Path:
                path = work / name
                subprocess.run(
                    [
                        ffmpeg_exe(),
                        '-hide_banner',
                        '-nostdin',
                        '-y',
                        '-f',
                        'lavfi',
                        '-i',
                        f'sine=frequency={hz}:sample_rate=48000:duration={seconds}',
                        '-af',
                        f'volume={volume}',
                        '-ac',
                        '2',
                        '-c:a',
                        'pcm_s16le',
                        str(path),
                    ],
                    check=True,
                    capture_output=True,
                    text=True,
                )
                return path

            # ffmpeg's sine generator sits near -22 LUFS, so the levels are set
            # from there: the stings land around -4 LUFS, the body around -29
            intro = tone('intro.wav', 3, 440, '18dB')  # a brand sting at full level
            body = tone('body.wav', 6, 220, '-7dB')  # the quiet programme itself
            outro = tone('outro.wav', 3, 660, '18dB')
            programme = assemble_programme_audio(
                [
                    {'path': str(intro)},
                    {'silence_ms': 1_000},
                    {'path': str(body)},
                    {'silence_ms': 1_000},
                    {'path': str(outro)},
                ],
                work / 'programme.wav',
            )

            raw = measure_loudness(programme)
            self.assertIsNotNone(raw)
            self.assertGreater(raw['integrated_lufs'], LOUDNESS_TARGET_LUFS + 1.0)  # the problem is real

            mastered = master_wav(programme, work / 'mastered.wav', loudness_lufs=LOUDNESS_TARGET_LUFS)
            picture = work / 'picture.mp4'
            subprocess.run(
                [
                    ffmpeg_exe(),
                    '-hide_banner',
                    '-nostdin',
                    '-y',
                    '-f',
                    'lavfi',
                    '-i',
                    'testsrc2=size=320x180:rate=15:duration=14',
                    '-c:v',
                    'libx264',
                    '-preset',
                    'ultrafast',
                    '-pix_fmt',
                    'yuv420p',
                    str(picture),
                ],
                check=True,
                capture_output=True,
                text=True,
            )
            final = mux_programme(picture, mastered, work / 'programme.mp4')

            measured = measure_loudness(final)
            self.assertIsNotNone(measured)
            self.assertAlmostEqual(measured['integrated_lufs'], LOUDNESS_TARGET_LUFS, delta=1.0)
            self.assertLessEqual(measured['true_peak_dbtp'], TRUE_PEAK_DBTP + 0.2)
        finally:
            shutil.rmtree(work, ignore_errors=True)


class SpecTest(unittest.TestCase):
    """The spec is the contract: what the node reads out of one JSON document."""

    SPEC = {
        'source': 'media/in.mp4',
        'keep': [[0, 10_000], [15_000, 20_000]],
        'outputs': [{'key': 'vertical', 'name': 'clip1', 'layout': 'vertical', 'long_edge': 1920}],
        'write_to': 'out',
    }

    def test_an_output_takes_its_geometry_from_its_layout_and_long_edge(self):
        out = plan_lib.normalize_outputs(self.SPEC)[0]
        self.assertEqual((out['width'], out['height']), (1080, 1920))
        self.assertEqual((out['file'], out['key'], out['container']), ('clip1.mp4', 'vertical', 'mp4'))
        self.assertEqual(out['caption_layout'], 'vertical')
        self.assertTrue(out['framing'])  # portrait: a framing plan drives it
        wide = plan_lib.normalize_outputs(
            {**self.SPEC, 'outputs': [{'key': 'wide', 'layout': 'wide', 'long_edge': 1920}]}
        )[0]
        self.assertEqual((wide['width'], wide['height']), (1920, 1080))
        self.assertFalse(wide['framing'])  # wide is letterboxed as it always was
        self.assertEqual(wide['caption_layout'], 'wide')

    def test_the_feed_shapes_and_explicit_sizes_both_work(self):
        for layout, expected in (('4:5', (1080, 1350)), ('1:1', (1080, 1080))):
            out = plan_lib.normalize_outputs(
                {**self.SPEC, 'outputs': [{'key': layout, 'layout': layout, 'long_edge': 1920}]}
            )[0]
            self.assertEqual((out['width'], out['height']), expected)
            self.assertEqual(out['caption_layout'], layout)
        exact = plan_lib.normalize_outputs(
            {**self.SPEC, 'outputs': [{'key': 'programme', 'width': 1280, 'height': 720}]}
        )[0]
        self.assertEqual((exact['width'], exact['height'], exact['caption_layout']), (1280, 720, 'wide'))

    def test_the_node_config_only_fills_what_the_output_left_out(self):
        config = {'fps': 24, 'crf': 28, 'preset': 'ultrafast', 'long_edge': 960}
        out = plan_lib.normalize_outputs(self.SPEC, {**plan_lib.DEFAULTS, **config})[0]
        self.assertEqual((out['fps'], out['crf'], out['preset']), (24, 28, 'ultrafast'))
        stated = plan_lib.normalize_outputs(
            {**self.SPEC, 'outputs': [{'key': 'v', 'layout': 'vertical', 'fps_max': 30, 'crf': 19, 'preset': 'fast'}]},
            {**plan_lib.DEFAULTS, **config},
        )[0]
        self.assertEqual((stated['fps'], stated['crf'], stated['preset']), (30, 19, 'fast'))
        self.assertEqual((stated['width'], stated['height']), (540, 960))  # long edge from the config

    def test_audio_outputs_and_duplicate_keys(self):
        outs = plan_lib.normalize_outputs(
            {
                **self.SPEC,
                'outputs': [
                    {'key': 'programme', 'name': 'programme', 'width': 640, 'height': 360},
                    {'key': 'mp3', 'name': 'programme', 'container': 'mp3', 'from': 'programme_audio'},
                ],
            }
        )
        self.assertEqual([o['video'] for o in outs], [True, False])
        self.assertEqual(outs[1]['file'], 'programme.mp3')
        with self.assertRaises(ValueError):
            plan_lib.normalize_outputs({**self.SPEC, 'outputs': [{'key': 'a'}, {'key': 'a'}]})
        with self.assertRaises(ValueError):
            plan_lib.normalize_outputs({**self.SPEC, 'outputs': []})
        with self.assertRaises(ValueError):
            plan_lib.normalize_outputs({**self.SPEC, 'outputs': [{'key': 'a', 'container': 'ogg'}]})

    def test_a_source_without_a_picture_keeps_only_the_audio_outputs(self):
        outs = plan_lib.normalize_outputs(
            {**self.SPEC, 'outputs': [{'key': 'vertical', 'layout': 'vertical'}, {'key': 'audio', 'container': 'mp3'}]},
            None,
            False,
        )
        self.assertEqual([o['key'] for o in outs], ['audio'])

    def test_a_window_renders_only_the_source_behind_it(self):
        plan = plan_lib.resolve_keep(
            {**self.SPEC, 'map': [[0, 10_000, 0], [15_000, 20_000, 10_000]], 'window': [9_000, 11_000]}
        )
        self.assertEqual(plan['keep'], [(9_000, 10_000), (15_000, 16_000)])
        self.assertEqual(plan['offset_ms'], 9_000)
        self.assertEqual(plan['body_ms'], 2_000)
        self.assertEqual(plan['full_keep'], [(0, 10_000), (15_000, 20_000)])
        whole = plan_lib.resolve_keep(self.SPEC)
        self.assertEqual(whole['keep'], [(0, 10_000), (15_000, 20_000)])
        self.assertEqual(whole['offset_ms'], 0)
        self.assertIsNone(whole['window'])
        with self.assertRaises(ValueError):
            plan_lib.resolve_keep({**self.SPEC, 'window': [10_000, 10_000]})
        with self.assertRaises(ValueError):
            plan_lib.resolve_keep({'source': 'x', 'outputs': []})

    def test_keep_defaults_to_the_whole_source_range(self):
        plan = plan_lib.resolve_keep({'source': 'x', 'source_range': [4_000, 9_000]})
        self.assertEqual(plan['keep'], [(4_000, 9_000)])
        self.assertEqual(plan['source_range'], [4_000, 9_000])

    def test_the_pipeline_follows_the_shape_of_the_spec(self):
        self.assertEqual(plan_lib.choose_pipeline(self.SPEC), 'clip')
        for key, value in (
            ('chunking', {'part_ms': 300_000}),
            ('bleeps', [[1, 2]]),
            ('music', {'source': 'm.mp3'}),
            ('cards', [{'text': 'hi'}]),
            ('concat', [{'source': 'i.mp4'}]),
            ('chapters', [{'title': 'One', 'out_ms': 0}]),
        ):
            self.assertEqual(plan_lib.choose_pipeline({**self.SPEC, key: value}), 'programme', key)
        self.assertEqual(plan_lib.choose_pipeline({**self.SPEC, 'pipeline': 'programme'}), 'programme')
        self.assertEqual(plan_lib.choose_pipeline({**self.SPEC, 'bleeps': [[1, 2]], 'pipeline': 'clip'}), 'clip')

    def test_words_are_mapped_through_the_keep_list_and_grouped(self):
        words = [
            {'w': 'one', 's': 500, 'e': 900},
            {'w': 'cut', 's': 11_000, 'e': 11_400},
            {'w': 'two', 's': 16_000, 'e': 16_400},
        ]
        caps = plan_lib.caption_plan({**self.SPEC, 'subtitles': {'words': words}}, [(0, 10_000), (15_000, 20_000)])
        said = [w['word'] for group in caps['groups'] for w in group]
        self.assertEqual(said, ['one', 'two'])  # the word inside the cut is gone
        self.assertEqual(caps['groups'][0][0]['start_ms'], 500)
        self.assertEqual([w['start_ms'] for g in caps['groups'] for w in g][-1], 11_000)
        self.assertTrue(caps['enabled'])

    def test_caption_lines_can_arrive_ready_made_on_the_output_timeline(self):
        subs = {
            'groups': [
                {
                    'start_ms': 0,
                    'end_ms': 900,
                    'speaker': 's1',
                    'words': [{'w': 'hello', 's': 0, 'e': 400}, {'w': 'there', 's': 400, 'e': 900}],
                }
            ],
            'style': {'preset': 'clean'},
        }
        caps = plan_lib.caption_plan({**self.SPEC, 'subtitles': subs}, [(0, 10_000)])
        self.assertEqual([w['word'] for w in caps['groups'][0]], ['hello', 'there'])
        self.assertEqual([w['speaker'] for w in caps['groups'][0]], ['s1', 's1'])
        self.assertEqual(caps['style']['preset'], 'minimal')  # `clean` is the minimal look
        off = plan_lib.caption_plan({**self.SPEC, 'subtitles': {**subs, 'style': {'preset': 'off'}}}, None)
        self.assertFalse(off['enabled'])

    def test_the_identity_is_the_spec_and_nothing_a_caller_named(self):
        """The render's identity is derived from the document that is going to
        be rendered; a key the caller put in the spec is not part of it, and
        cannot make two identical renders look like two (V3 FINDING A).
        """
        named = plan_lib.spec_identity({**self.SPEC, 'cache_key': 'abc123'})
        self.assertNotEqual(named, 'abc123')
        self.assertEqual(len(named), 16)
        self.assertEqual(named, plan_lib.spec_identity({**self.SPEC, 'cache_key': 'def456'}))
        self.assertEqual(named, plan_lib.spec_identity(self.SPEC))

        a = plan_lib.spec_identity(
            {**self.SPEC, 'window': [0, 1000], 'quality': 'range', 'prepared_at': 1.0, 'warnings': []}
        )
        b = plan_lib.spec_identity(
            {**self.SPEC, 'window': None, 'quality': 'standard', 'prepared_at': 2.0, 'warnings': ['skipped']}
        )
        self.assertEqual(a, b)
        self.assertEqual(len(a), 16)
        self.assertNotEqual(a, plan_lib.spec_identity({**self.SPEC, 'keep': [[0, 900]]}))

    def test_a_plan_of_full_frames_does_not_reframe(self):
        flat = {'segments': [{'layout': 'full_frame', 'start_ms': 0, 'end_ms': 5_000}]}
        self.assertFalse(plan_lib.reframes(flat))
        self.assertTrue(plan_lib.reframes({'segments': [{'layout': 'solo_follow'}]}))
        self.assertIsNotNone(plan_lib.framing_plan({'framing_plan': flat}))
        self.assertIsNotNone(plan_lib.framing_plan({'layout': flat}))  # the schema-1 name
        summary = plan_lib.framing_summary({**flat, 'metrics': {'people': 2}}, False)
        self.assertEqual(summary['metrics'], {'people': 2})
        self.assertFalse(summary['applied'])
        self.assertEqual(len(summary['segments']), 1)

    def test_unknown_caption_layout_fails_before_render(self):
        with self.assertRaisesRegex(ValueError, "output 'main'.*caption_layout.*allowed layouts"):
            plan_lib.normalize_outputs({**self.SPEC, 'outputs': [{'key': 'main', 'caption_layout': 'typo'}]})

    def test_caption_layout_normalizes_and_keeps_geometry_fallback(self):
        for value, expected in [(' WIDE ', 'wide'), ('', 'vertical'), (None, 'vertical'), ('4:5', '4:5')]:
            with self.subTest(value=value):
                outputs = plan_lib.normalize_outputs(
                    {**self.SPEC, 'outputs': [{'key': 'main', 'width': 1080, 'height': 1920, 'caption_layout': value}]}
                )
                self.assertEqual(outputs[0]['caption_layout'], expected)


class ReportTest(unittest.TestCase):
    """What the report may claim about a finished render."""

    CHECK = {'duration_ms': 60_000, 'has_audio': True, 'has_video': True, 'width': 1920, 'height': 1080}
    ON_TARGET = {'integrated_lufs': -16.2, 'true_peak_dbtp': -1.4, 'loudness_range_lu': 7.0}

    def report(self, **over):
        payload = dict(
            kind='studio',
            mode='export',
            quality='export',
            check=self.CHECK,
            measured=self.ON_TARGET,
            measurements={'programme': self.ON_TARGET},
            target_lufs=-16,
            mastered=True,
            total_ms=60_000,
            body_ms=54_000,
            lead_ms=4_000,
            tail_ms=2_000,
            files={'programme': 'x.mp4'},
            version=3,
            title='Programme 12',
            fps=30,
            chapters=[{'title': 'Intro', 'out_ms': 4_000}, {'title': 'Guest', 'out_ms': 20_000}],
            spec_hash='abc123',
            warnings=[],
            seconds=12.0,
        )
        payload.update(over)
        return report_lib.build_render_report(**payload)

    def test_schema_two_shape(self):
        report = self.report()
        self.assertEqual(report['schema_version'], 2)
        self.assertTrue(report['has_audio'] and report['has_video'])
        self.assertEqual([c['title'] for c in report['chapters']], ['Intro', 'Guest'])
        self.assertEqual(report['chapters'][0], {'title': 'Intro', 'out_ms': 4_000})
        self.assertEqual(report['chapter_count'], 2)
        self.assertEqual(
            report['clock'], {'mode': 'export', 'quality': 'export', 'range': None, 'preview_output_start_ms': 0}
        )
        self.assertEqual(
            sorted(report['loudness']),
            ['integrated_lufs', 'loudness_ok', 'loudness_range_lu', 'target_lufs', 'true_peak_dbtp'],
        )
        self.assertEqual(report['measurements']['programme']['integrated_lufs'], -16.2)
        self.assertEqual(report['validation']['expected_duration_ms'], 60_000)
        self.assertTrue(report['validation']['duration_ok'])
        self.assertTrue(report['validation']['streams_ok'])
        self.assertTrue(report['validation']['loudness_ok'])
        self.assertEqual(report['warnings'], [])
        self.assertEqual(report['spec_hash'], 'abc123')

    def test_a_file_inside_tolerance_passes(self):
        for integrated, peak in ((-16.0, -1.0), (-17.0, -1.1), (-15.0, -0.8)):
            block = report_lib.loudness_block(
                {'integrated_lufs': integrated, 'true_peak_dbtp': peak, 'loudness_range_lu': 6.0}, -16
            )
            self.assertTrue(block['loudness_ok'], (integrated, peak))

    def test_out_of_tolerance_fails_with_a_warning(self):
        loud = self.report(measured={'integrated_lufs': -12.4, 'true_peak_dbtp': -1.2, 'loudness_range_lu': 8.0})
        self.assertFalse(loud['loudness']['loudness_ok'])
        self.assertFalse(loud['validation']['loudness_ok'])
        self.assertTrue(any('louder' in w for w in loud['warnings']))
        peaky = self.report(measured={'integrated_lufs': -16.0, 'true_peak_dbtp': -0.4, 'loudness_range_lu': 8.0})
        self.assertFalse(peaky['loudness']['loudness_ok'])
        self.assertTrue(any('dBTP' in w for w in peaky['warnings']))

    def test_an_unmastered_preview_says_so_instead_of_claiming_a_verdict(self):
        rough = self.report(mode='preview', quality='standard', mastered=False, measurements={}, measured=None)
        self.assertIsNone(rough['loudness']['loudness_ok'])
        self.assertTrue(rough['unmastered_preview'])
        self.assertIsNone(rough['loudness_target_lufs'])
        self.assertEqual(rough['clock']['mode'], 'rough_preview')

    def test_a_short_file_is_reported_as_a_warning(self):
        short = self.report(check={**self.CHECK, 'duration_ms': 57_000})
        self.assertFalse(short['validation']['duration_ok'])
        self.assertEqual(short['validation']['delta_ms'], -3_000)
        self.assertTrue(any('off the planned length' in w for w in short['warnings']))

    def test_the_source_window_is_reported_when_there_is_one(self):
        clip = self.report(source_range=[12_000, 42_000])
        self.assertEqual((clip['start_ms'], clip['end_ms'], clip['source_duration_ms']), (12_000, 42_000, 30_000))


class ReportWindowTest(unittest.TestCase):
    """Reports retain the requested window, mode and measurement uncertainty."""

    CHECK = {'duration_ms': 15_000, 'has_audio': True, 'has_video': True, 'width': 1920, 'height': 1080}

    def report(self, **over):
        payload = dict(
            kind='studio',
            mode='preview',
            quality='full',
            version=3,
            title='Programme 12',
            check=self.CHECK,
            measured={'integrated_lufs': -16.2, 'true_peak_dbtp': -1.4, 'loudness_range_lu': 7.0},
            target_lufs=-16,
            mastered=True,
            total_ms=15_000,
            body_ms=15_000,
            files={'preview': 'x.mp4'},
            fps=30,
            warnings=[],
            seconds=12.0,
        )
        payload.update(over)
        return report_lib.build_render_report(**payload)

    def test_r08_a_range_preview_records_where_its_clock_starts(self):
        window = self.report(window=[30_000, 45_000], preview_output_start_ms=30_000)
        self.assertEqual(
            window['clock'],
            {'mode': 'range_preview', 'quality': 'full', 'range': [30_000, 45_000], 'preview_output_start_ms': 30_000},
        )
        self.assertEqual(window['range'], [30_000, 45_000])

    def test_r08_a_whole_programme_preview_has_no_window(self):
        whole = self.report()
        self.assertIsNone(whole['range'])
        self.assertEqual(whole['clock']['mode'], 'rough_preview')
        self.assertEqual(whole['clock']['preview_output_start_ms'], 0)

    def test_r08_an_export_says_export(self):
        export = self.report(mode='export', quality='export')
        self.assertEqual(export['mode'], 'export')
        self.assertEqual(export['clock']['mode'], 'export')
        self.assertFalse(export['unmastered_preview'])

    def test_r08_an_unmeasurable_file_is_null_not_a_pass(self):
        blind = self.report(measured=None, measurements={})
        self.assertIsNone(blind['loudness']['integrated_lufs'])
        self.assertIsNone(blind['loudness']['loudness_ok'])
        self.assertIsNone(blind['validation']['loudness_ok'])

    def test_r08_the_node_passes_its_window_through(self):
        """The spec's window reaches `resolve_keep`, and the report says so."""
        spec = {
            'source': 'a.mp4',
            'keep': [[0, 10_000], [15_000, 20_000]],
            'map': [[0, 10_000, 0], [15_000, 20_000, 10_000]],
            'window': [9_000, 11_000],
            'outputs': [{'key': 'preview'}],
            'write_to': 'out',
        }
        resolved = plan_lib.resolve_keep(spec)
        self.assertEqual(resolved['window'], [9_000, 11_000])
        report = self.report(
            window=resolved['window'], preview_output_start_ms=resolved['offset_ms'], total_ms=resolved['body_ms']
        )
        self.assertEqual(report['range'], [9_000, 11_000])
        self.assertEqual(report['clock']['preview_output_start_ms'], 9_000)


class WarningDedupeTest(unittest.TestCase):
    """The measured sentence and the spec's own are one sentence in the report."""

    CHECK = {'duration_ms': 57_000, 'has_audio': True, 'has_video': True, 'width': 1920, 'height': 1080}
    SHORT = 'The finished file is -3.0s off the planned length.'

    def test_a_sentence_the_spec_already_carried_is_not_repeated_by_the_measurement(self):
        carried = ['An edit was moved to the nearer word edge.', self.SHORT]
        report = report_lib.build_render_report(
            kind='studio',
            mode='export',
            quality='export',
            check=self.CHECK,
            total_ms=60_000,
            mastered=False,
            warnings=carried,
        )
        self.assertEqual(report['warnings'], ['An edit was moved to the nearer word edge.', self.SHORT])
        self.assertIs(report['warnings'], carried)  # still the caller's own list

    def test_blank_and_missing_warnings_are_dropped(self):
        self.assertEqual(report_lib.dedupe(['a', ' a ', '', None, 'b']), ['a', 'b'])
        self.assertEqual(report_lib.dedupe(None), [])

    def test_carrying_warnings_never_invalidates_a_finished_render(self):
        """The new field must not reach the cache key: every part of every
        export already on disk is keyed by this hash.
        """
        spec = {'source': 'a.mp4', 'keep': [[0, 5_000]], 'outputs': [{'key': 'v'}], 'write_to': 'o'}
        self.assertEqual(plan_lib.spec_identity(spec), plan_lib.spec_identity({**spec, 'warnings': ['one', 'two']}))


# ---------------------------------------------------------------- the fixes
#
# One class per defect in the register, named after it. Each of these fails on
# the base commit (4e8c3f3) and passes here.


class FramingOffsetTest(unittest.TestCase):
    """Map framing times from the requested range onto the source clock before intersecting cuts."""

    PLAN = {
        'canvas': {'width': 1080, 'height': 1920},
        'source': {'width': 1280, 'height': 720},
        'segments': [
            {'start_ms': 0, 'end_ms': 4_000, 'layout': 'solo_follow', 'subjects': ['p1']},
            {'start_ms': 4_000, 'end_ms': 10_000, 'layout': 'stacked_two', 'subjects': ['p1', 'p2']},
        ],
        'paths': [
            {
                'segment': 0,
                'subject': 'p1',
                'panel': 'a',
                'w': 405,
                'h': 720,
                'keyframes': [[0, 100, 0], [4_000, 140, 0]],
            },
            {
                'segment': 1,
                'subject': 'p1',
                'panel': 'a',
                'w': 640,
                'h': 570,
                'keyframes': [[4_000, 0, 0], [10_000, 20, 10]],
            },
            {
                'segment': 1,
                'subject': 'p2',
                'panel': 'b',
                'w': 640,
                'h': 570,
                'keyframes': [[4_000, 600, 0], [10_000, 620, 10]],
            },
        ],
        'speaking': [{'start_ms': 500, 'end_ms': 900, 'track': 'p1'}],
    }

    def test_r01_framing_offset_applied(self):
        """The shifted plan covers the keep list with the layouts it planned."""
        shifted = plan_lib.shift_framing(self.PLAN, 5_000)
        self.assertEqual([(s['start_ms'], s['end_ms']) for s in shifted['segments']], [(5_000, 9_000), (9_000, 15_000)])
        self.assertEqual(shifted['paths'][0]['keyframes'], [[5_000, 100, 0], [9_000, 140, 0]])
        self.assertEqual(shifted['speaking'][0]['start_ms'], 5_500)

        pieces = layout_pieces([(5_000, 15_000)], shifted['segments'])
        self.assertEqual(
            [(p['start_ms'], p['end_ms'], p['segment']['layout']) for p in pieces],
            [(5_000, 9_000, 'solo_follow'), (9_000, 15_000, 'stacked_two')],
        )
        self.assertEqual([p['segment_index'] for p in pieces], [0, 1])
        self.assertEqual(sum(p['end_ms'] - p['start_ms'] for p in pieces), 10_000)  # the whole keep
        self.assertFalse(any(p.get('fallback') for p in pieces))
        # the original plan is untouched: the node may hand it to the report
        self.assertEqual(self.PLAN['segments'][0]['start_ms'], 0)

    def test_r01_a_clip_that_starts_at_zero_is_unchanged(self):
        """An unshifted plan (offset 0) still lines up with its keep list."""
        same = plan_lib.shift_framing(self.PLAN, 0)
        self.assertIs(same, self.PLAN)
        pieces = layout_pieces([(0, 10_000)], same['segments'])
        self.assertEqual([(p['start_ms'], p['end_ms']) for p in pieces], [(0, 4_000), (4_000, 10_000)])
        self.assertIsNone(plan_lib.shift_framing(None, 5_000))

    def test_r01_a_plan_that_does_not_cover_the_clip_says_so(self):
        """The silent full-frame fallback is what shipped the wrong footage."""
        pieces = layout_pieces([(394_978, 439_348)], self.PLAN['segments'])
        self.assertEqual(len(pieces), 1)
        self.assertTrue(pieces[0]['fallback'])
        self.assertEqual(pieces[0]['segment']['layout'], 'full_frame')
        self.assertEqual((pieces[0]['start_ms'], pieces[0]['end_ms']), (394_978, 439_348))

    def test_r01_the_trims_follow_the_decode_window(self):
        """With a source_range the decode starts at the clip, so the graph's trims
        are relative to it — the times in the plan stay on the recording's clock.
        """
        graph = build_video_filter([(60_000, 70_000)], 'wide', 320, 180, 30, None, base_ms=60_000)
        self.assertIn('trim=start=0.000:end=10.000', graph)
        shifted = plan_lib.shift_framing(self.PLAN, 60_000)
        work = Path(tempfile.mkdtemp(prefix='layout_graph_'))
        self.addCleanup(shutil.rmtree, work, True)
        pieces = layout_pieces([(60_000, 70_000)], shifted['segments'])
        layout = build_layout_graph(pieces, shifted, 1280, 720, 30, None, work, base_ms=60_000)
        self.assertIn('trim=start=0.000:end=4.000', layout)
        self.assertIn('trim=start=4.000:end=10.000', layout)
        # …and the sendcmd files are written from the piece start, not from 0
        commands = (work / 'pan_0_p0a.cmd').read_text().splitlines()
        self.assertTrue(commands[0].startswith('0.0000 crop@p0a x 100'))


class SquarePixelTest(unittest.TestCase):
    """R03 — the pixel aspect ratio was never probed, so a 32:27 recording was
    letterboxed as if it were 1.51:1 and 15 % of every frame was a blurred bar
    [B-D4]; non-framed clip outputs came out SAR 5120:5121 [C-D14].
    """

    NON_SQUARE = {'sar': 32 / 27, 'width': 770, 'height': 430, 'coded_width': 650, 'coded_height': 430}

    def test_r03_display_dimensions_are_the_picture_you_see(self):
        self.assertEqual(display_dims(650, 430, 32 / 27), (770, 430))
        self.assertEqual(display_dims(650, 430, '32:27'), (770, 430))
        self.assertEqual(display_dims(1280, 720, 1.0), (1280, 720))
        self.assertEqual(display_dims(720, 576, '16:15'), (768, 576))  # PAL 4:3
        self.assertEqual(display_dims(0, 0, 2.0), (0, 0))
        self.assertEqual(sar_of(None), 1.0)
        self.assertEqual(sar_of('0:1'), 1.0)  # "unknown", not a squeeze
        self.assertEqual(sar_of(0), 1.0)

    def test_r03_every_decode_is_squared_up_before_anything_is_cropped(self):
        prefix = square_pixels(self.NON_SQUARE)
        self.assertEqual(prefix, 'scale=770:430,setsar=1,')
        self.assertEqual(square_pixels({'sar': 1.0, 'width': 650, 'height': 430}), '')
        self.assertEqual(square_pixels(None), '')
        clip = build_video_filter([(0, 5_000)], 'vertical', 540, 960, 30, None, source=self.NON_SQUARE)
        self.assertTrue(clip.startswith('[0:v]scale=770:430,setsar=1,fps=30'))
        part = programme_part_graph([(0, 5_000)], 1920, 1080, 30, source=self.NON_SQUARE)
        self.assertTrue(part.startswith('[0:v]scale=770:430,setsar=1,fps=30'))
        work = Path(tempfile.mkdtemp(prefix='layout_graph_'))
        self.addCleanup(shutil.rmtree, work, True)
        plan = {
            'canvas': {'width': 1080, 'height': 1920},
            'segments': [{'start_ms': 0, 'end_ms': 5_000, 'layout': 'full_frame'}],
            'paths': [],
        }
        graph = build_layout_graph(
            layout_pieces([(0, 5_000)], plan['segments']), plan, 770, 430, 30, None, work, source=self.NON_SQUARE
        )
        self.assertTrue(graph.startswith('[0:v]scale=770:430,setsar=1,fps=30'))

    def test_r03_non_framed_clip_outputs_end_in_square_pixels(self):
        """Both reframe styles: concat refuses pieces whose SARs differ."""
        for layout, width, height in (('vertical', 540, 960), ('wide', 960, 540), ('original', 540, 960)):
            graph = build_video_filter([(0, 5_000)], layout, width, height, 30, None)
            self.assertIn('setsar=1[framed]', graph, layout)


class PanelTest(unittest.TestCase):
    """R05 — the screen_share speaker panel was stretched 1.62x vertically [C-D4]."""

    def test_r05_a_crop_fits_its_panel_and_keeps_its_shape(self):
        # a 2:3 crop into the panel a stacked layout gives it
        out_w, out_h, dx, dy = panel_fit(400, 600, 1080, 806)
        self.assertLessEqual(out_w, 1080)
        self.assertLessEqual(out_h, 806)
        self.assertAlmostEqual(out_w / out_h, 2 / 3, delta=1 / 806)  # within a pixel of its aspect
        self.assertLess(abs(out_w - out_h * 2 / 3), 1.0)
        self.assertEqual((dx, dy), ((1080 - out_w) // 2, (806 - out_h) // 2))
        # a crop already the panel's shape fills it
        self.assertEqual(panel_fit(1080, 806, 1080, 806)[:2], (1080, 806))
        # and one wider than its panel is scaled down, never cropped
        wide_w, wide_h, _, _ = panel_fit(1920, 1080, 540, 960)
        self.assertEqual((wide_w, wide_h), (540, 304))

    def test_r05_the_screen_share_speaker_is_never_stretched(self):
        top_h, bot_h = screen_share_split(1080, 1920, 1280, 720)
        self.assertEqual(top_h + bot_h, 1920)
        self.assertLessEqual(top_h, int(1920 * 0.58))
        work = Path(tempfile.mkdtemp(prefix='layout_graph_'))
        self.addCleanup(shutil.rmtree, work, True)
        plan = {
            'canvas': {'width': 1080, 'height': 1920},
            'segments': [{'start_ms': 0, 'end_ms': 4_000, 'layout': 'screen_share', 'subjects': ['p1']}],
            'paths': [
                {
                    'segment': 0,
                    'subject': 'p1',
                    'panel': 'b',
                    'w': 432,
                    'h': 324,
                    'keyframes': [[0, 0, 0], [4_000, 0, 0]],
                }
            ],
        }
        graph = build_layout_graph(layout_pieces([(0, 4_000)], plan['segments']), plan, 1280, 720, 30, None, work)
        scaled = re.search(r'crop@p0b=432:324:0:0:exact=1,scale=(\d+):(\d+),pad=1080:(\d+):', graph)
        self.assertIsNotNone(scaled, graph)
        width, height = int(scaled.group(1)), int(scaled.group(2))
        self.assertAlmostEqual(width / height, 432 / 324, delta=0.01)  # 4:3 stays 4:3
        self.assertLessEqual(height, bot_h)

    def test_r05_panels_from_the_plan_are_honoured(self):
        rects = [
            {'subject': 'p1', 'x': 0, 'y': 0, 'w': 1080, 'h': 806},
            {'subject': 'p2', 'x': 0, 'y': 1114, 'w': 1080, 'h': 806},
        ]
        segment = {'start_ms': 0, 'end_ms': 4_000, 'layout': 'stacked_two', 'subjects': ['p1', 'p2'], 'panels': rects}
        self.assertEqual(len(panel_rects(segment, 1080, 1920)), 2)
        self.assertEqual(
            panel_rects({'panels': [{'subject': 'p1', 'x': 0, 'y': 0, 'w': 99_000, 'h': 10}]}, 1080, 1920), []
        )  # off the canvas: ignored
        self.assertEqual(panel_rects({}, 1080, 1920), [])
        work = Path(tempfile.mkdtemp(prefix='layout_graph_'))
        self.addCleanup(shutil.rmtree, work, True)
        plan = {
            'canvas': {'width': 1080, 'height': 1920},
            'segments': [segment],
            'paths': [
                {
                    'segment': 0,
                    'subject': 'p1',
                    'panel': 'a',
                    'w': 400,
                    'h': 600,
                    'keyframes': [[0, 0, 0], [4_000, 0, 0]],
                },
                {
                    'segment': 0,
                    'subject': 'p2',
                    'panel': 'b',
                    'w': 400,
                    'h': 600,
                    'keyframes': [[0, 100, 0], [4_000, 100, 0]],
                },
            ],
        }
        graph = build_layout_graph(layout_pieces([(0, 4_000)], plan['segments']), plan, 1280, 720, 30, None, work)
        self.assertIn('gblur=sigma=30', graph)  # the ground is the blurred frame
        self.assertIn('overlay=0:0', graph)  # …and each panel lands on its rect
        self.assertIn('overlay=0:1114', graph)
        for scaled in re.findall(r'crop@p0n\d=400:600:\d+:\d+:exact=1,scale=(\d+):(\d+)', graph):
            width, height = int(scaled[0]), int(scaled[1])
            self.assertAlmostEqual(width / height, 400 / 600, delta=0.01)
            self.assertLessEqual(width, 1080)
            self.assertLessEqual(height, 806)

    def test_r05_a_panel_with_no_crop_path_gets_the_whole_frame(self):
        segment = {
            'start_ms': 0,
            'end_ms': 4_000,
            'layout': 'screen_share',
            'subjects': ['p1'],
            'panels': [
                {'subject': 'screen', 'x': 0, 'y': 0, 'w': 1080, 'h': 608},
                {'subject': 'p1', 'x': 0, 'y': 608, 'w': 1080, 'h': 1312},
            ],
        }
        work = Path(tempfile.mkdtemp(prefix='layout_graph_'))
        self.addCleanup(shutil.rmtree, work, True)
        plan = {
            'canvas': {'width': 1080, 'height': 1920},
            'segments': [segment],
            'paths': [
                {
                    'segment': 0,
                    'subject': 'p1',
                    'panel': 'b',
                    'w': 432,
                    'h': 324,
                    'keyframes': [[0, 0, 0], [4_000, 0, 0]],
                }
            ],
        }
        graph = build_layout_graph(layout_pieces([(0, 4_000)], plan['segments']), plan, 1280, 720, 30, None, work)
        self.assertIn('scale=1080:608,pad=1080:608:0:0', graph)  # 1280x720 fits exactly
        self.assertIn('overlay=0:608', graph)


class VolatileIdentityTest(unittest.TestCase):
    """R06 — the framing node's own runtime was hashed into the render's
    identity, so two identical renders never looked identical [A-D4, C-D9].
    """

    SPEC = {
        'source': 'media/in.mp4',
        'keep': [[0, 10_000]],
        'write_to': 'out',
        'outputs': [{'key': 'vertical', 'layout': 'vertical'}],
        'framing_plan': {'segments': [{'start_ms': 0, 'end_ms': 10_000, 'layout': 'solo_follow'}], 'seconds': 22.8},
        'meta': {'clip_id': 'c01', 'seconds': 3.1},
    }

    def test_r06_a_runtime_measurement_does_not_change_the_key(self):
        slower = {
            **self.SPEC,
            'framing_plan': {**self.SPEC['framing_plan'], 'seconds': 26.2},
            'meta': {'clip_id': 'c01', 'seconds': 91.4},
            'prepared_at': 1_700_000_000.0,
        }
        self.assertEqual(spec_hash(self.SPEC), spec_hash(slower))
        self.assertEqual(plan_lib.spec_identity(self.SPEC), plan_lib.spec_identity(slower))

    def test_r06_an_edit_still_changes_the_key(self):
        edited = {**self.SPEC, 'keep': [[0, 9_000]]}
        self.assertNotEqual(spec_hash(self.SPEC), spec_hash(edited))
        self.assertNotEqual(plan_lib.spec_identity(self.SPEC), plan_lib.spec_identity(edited))
        # a card's `seconds` is how long it is on screen, not how long a node ran
        card = {**self.SPEC, 'cards': [{'text': 'Hi', 'seconds': 3}]}
        longer = {**self.SPEC, 'cards': [{'text': 'Hi', 'seconds': 5}]}
        self.assertNotEqual(spec_hash(card), spec_hash(longer))


class SpecValidationTest(unittest.TestCase):
    """R12 — every value in a spec is data: a path, a time or a word from a
    known list. Nothing in it may become an ffmpeg argument or a file outside
    the account store, and a spec that breaks a rule is refused whole.
    """

    SPEC = {
        'schema_version': 1,
        'source': 'projects/ep1/source/a.mp4',
        'write_to': 'projects/ep1/previews',
        'report_to': 'projects/ep1/previews/c01.json',
        'keep': [[0, 5_000]],
        'outputs': [{'key': 'vertical', 'name': 'c01', 'file': 'c01.mp4', 'layout': 'vertical'}],
    }

    def refuse(self, message_part: str, **over):
        with self.assertRaises(plan_lib.SpecError) as caught:
            plan_lib.validate_spec({**self.SPEC, **over})
        self.assertIn(message_part, str(caught.exception).lower())
        return str(caught.exception)

    def test_r12_a_good_spec_passes(self):
        self.assertIsNotNone(plan_lib.validate_spec(self.SPEC))

    def test_r12_paths_may_not_step_outside_the_store(self):
        self.refuse('inside the temporary workspace', write_to='projects/ep1/../../etc')
        self.refuse('inside the temporary workspace', source='../x.mp4')
        self.refuse('inside the temporary workspace', outputs=[{'key': 'v', 'file': '../x.mp4'}])
        # the wording comes from the package's own store rules — the single definition (N10)
        self.refuse('inside the temporary workspace', source='/etc/passwd')
        self.refuse('inside the temporary workspace', write_to='/tmp/out')
        self.refuse('inside the temporary workspace', write_to='projects//previews')
        self.refuse('is empty', write_to='')
        self.refuse('file name', source='https://example.com/a.mp4')

    def test_r12_output_paths_may_not_carry_filter_syntax(self):
        self.refuse('file name', outputs=[{'key': 'v', 'file': "a'; rm -rf /.mp4"}])
        self.refuse('file name', outputs=[{'key': 'v', 'file': 'c01:1.mp4'}])
        self.refuse('file name', report_to='out/a=b.json')

    def test_r12_times_are_whole_milliseconds_in_order(self):
        self.refuse('ends at or before it starts', keep=[[5_000, 5_000]])
        self.refuse('ends at or before it starts', keep=[[9_000, 1_000]])
        self.refuse('not a whole number', keep=[['start', 10]])
        self.refuse('negative time', mutes=[[-5, 10]])
        self.refuse('is empty', keep=[])
        self.refuse('ends at or before it starts', window=[3_000, 3_000])
        self.refuse('different clock', keep=[[60_000, 70_000]], media={'duration_ms': 30_000, 'has_video': True})

    def test_r12_nothing_is_written_over_the_recording(self):
        self.refuse('over the recording', source='projects/ep1/previews/c01.mp4')
        self.refuse('same file', outputs=[{'key': 'a', 'file': 'c01.mp4'}, {'key': 'b', 'file': 'c01.mp4'}])

    def test_r12_only_known_words_reach_ffmpeg(self):
        self.refuse('encoder preset', outputs=[{'key': 'v', 'preset': 'veryfast -y /etc/passwd'}])
        self.refuse('is not a colour', outputs=[{'key': 'v', 'background': 'black,drawbox=c=red'}])
        self.refuse('has to be one of', outputs=[{'key': 'v', 'fit': 'squeeze'}])
        plan_lib.validate_spec(
            {**self.SPEC, 'outputs': [{'key': 'v', 'preset': 'medium', 'fit': 'fill', 'background': '#101010'}]}
        )

    def test_r12_the_schema_version_is_checked(self):
        self.refuse('schema version 99', schema_version=99)
        self.refuse('whole number', schema_version='1')

    def test_r12_the_files_a_spec_names_are_checked_too(self):
        self.refuse('named in overlays', overlays=[{'image': '../../brand/logo.png'}])
        self.refuse('music file', music={'source': '/etc/passwd'})
        self.refuse('srt sidecar', subtitles={'files': {'srt': '../c01.srt'}})
        self.refuse('thumbnail file', thumbnail={'file': '/tmp/x.jpg'})

    def test_r12_caption_and_card_text_is_escaped_not_refused(self):
        """Text is the one thing a producer types; it is escaped, never rejected."""
        words = [{'word': "it's {\\an5} 50%: done", 'start_ms': 0, 'end_ms': 900}]
        ass = build_ass([words], 'vertical', 'classic')
        line = [row for row in ass.splitlines() if row.startswith('Dialogue:')][0]
        self.assertIn("it's", line)  # the apostrophe is fine inside an ASS line
        self.assertNotIn('{\\an5}', line)  # …an override block is not
        self.assertIn('(/an5)', line)
        card = render_lib_module.card_graph("Tom's 50%: show", 'a:b', 1920, 1080)
        # drawtext reads ' : % — the quote closes, escapes and reopens; % needs a doubled backslash
        self.assertIn(r"Tom'\\\''s 50\\%\: show", card)
        self.assertIn(r'a\:b', card)
        # and the spec itself is happy to carry them
        plan_lib.validate_spec(
            {
                **self.SPEC,
                'cards': [{'text': "Tom's 50%: show"}],
                'subtitles': {'words': [{'w': "it's", 's': 0, 'e': 100}]},
            }
        )


# ---------------------------------------------------------- W7: the programme
# path learns the framing plan
#
# A clip that carries a brand's intro / outro is a PROGRAMME (`plan.choose_
# pipeline`), and the programme path had no framing argument at all: every such
# export letterboxed the speakers and reported `layout.applied: false`. So a
# producer could have the intro OR the framing, never both.


class ProgrammeLayoutPartTest(unittest.TestCase):
    """`render_layout_part` — `render_layout_video` for one resumable part."""

    PLAN = {
        'canvas': {'width': 1080, 'height': 1920},
        'source': {'width': 1280, 'height': 720},
        'segments': [
            {'start_ms': 60_000, 'end_ms': 64_000, 'layout': 'solo_follow', 'subjects': ['p1']},
            {'start_ms': 64_000, 'end_ms': 70_000, 'layout': 'stacked_two', 'subjects': ['p1', 'p2']},
        ],
        'paths': [
            {
                'segment': 0,
                'subject': 'p1',
                'panel': 'a',
                'w': 405,
                'h': 720,
                'keyframes': [[60_000, 100, 0], [64_000, 140, 0]],
            },
            {
                'segment': 1,
                'subject': 'p1',
                'panel': 'a',
                'w': 640,
                'h': 570,
                'keyframes': [[64_000, 0, 0], [70_000, 20, 10]],
            },
            {
                'segment': 1,
                'subject': 'p2',
                'panel': 'b',
                'w': 640,
                'h': 570,
                'keyframes': [[64_000, 600, 0], [70_000, 620, 10]],
            },
        ],
    }
    KEEP = [(60_000, 64_000), (66_000, 70_000)]

    def setUp(self):
        self.work = Path(tempfile.mkdtemp(prefix='layout_part_'))
        self.addCleanup(shutil.rmtree, self.work, True)
        self.calls: list[list[str]] = []
        original = render_lib_module.run_ffmpeg
        render_lib_module.run_ffmpeg = lambda args: self.calls.append(list(args))
        self.addCleanup(setattr, render_lib_module, 'run_ffmpeg', original)

    def _run(self, **over) -> list[str]:
        render_layout_part(
            'in.mp4',
            self.KEEP,
            over.pop('layout', self.PLAN),
            self.work / 'part-001.mp4',
            self.work,
            fps=30,
            crf=20,
            preset='veryfast',
            **over,
        )
        return self.calls[-1]

    @staticmethod
    def _graph(args: list[str]) -> str:
        return args[args.index('-filter_complex') + 1]

    def test_the_part_goes_through_the_framing_plan_not_a_letterbox(self):
        graph = self._graph(self._run())
        self.assertIn('sendcmd', graph)  # the crop is driven per frame
        self.assertIn('crop@p0a=405:720:100:0:exact=1', graph)
        self.assertIn('vstack[v1]', graph)  # …and the stacked segment is stacked
        self.assertIn('concat=n=2:v=1:a=0[joined]', graph)  # one piece per keep x segment overlap
        self.assertTrue(graph.endswith(f'format=yuv420p,{HOUSE_TAGS}[vout]'))
        # what the old call did instead: fit the whole frame onto a blurred copy
        self.assertNotIn('force_original_aspect_ratio=decrease[rf_fgo]', graph)

    def test_the_decode_is_seeked_to_the_parts_own_base(self):
        """The plan stays on the source clock; the graph's trims are relative."""
        args = self._run()
        self.assertEqual(args[args.index('-ss') + 1], '60.000')
        self.assertEqual(args[args.index('-t') + 1], '10.000')  # 60 s -> 70 s of recording
        graph = self._graph(args)
        self.assertIn('trim=start=0.000:end=4.000', graph)  # the first keep
        self.assertIn('trim=start=6.000:end=10.000', graph)  # the second, after the cut
        commands = (self.work / 'pan_0_p0a.cmd').read_text().splitlines()
        self.assertTrue(commands[0].startswith('0.0000 crop@p0a x 100'))

    def test_the_picture_is_video_only_because_a_programme_masters_its_own_sound(self):
        args = self._run()
        self.assertIn('-an', args)
        self.assertEqual(args[args.index('-map') + 1], '[vout]')
        self.assertNotIn('1:a', args)
        self.assertIn('+faststart', args)

    def test_the_logo_is_the_second_input_and_is_bounded_by_the_picture(self):
        args = self._run(logo={'corner': 'tr', 'height': 0.12, 'opacity': 1.0}, logo_path='logo.png')
        graph = self._graph(args)
        self.assertIn('[1:v]scale=-1:230,format=rgba', graph)  # input 1: there is no audio input
        self.assertIn('-loop', args)
        self.assertEqual(args.count('-t'), 2)  # the looped still ends with the part
        self.assertIn('[logoed]', graph)

    def test_the_captions_are_burned_in_after_the_logo(self):
        graph = self._graph(self._run(ass_path=self.work / 'c.ass', logo={'corner': 'tr'}, logo_path='logo.png'))
        self.assertLess(graph.index('[logoed]'), graph.index('subtitles'))

    def test_a_plan_that_never_said_how_big_the_recording_is_reads_the_probe(self):
        plan = {k: v for k, v in self.PLAN.items() if k != 'source'}
        graph = self._graph(self._run(layout=plan, source={'width': 1280, 'height': 720, 'sar': 1.0}))
        self.assertIn('crop@p0a=405:720:100:0:exact=1', graph)
        with self.assertRaises(ValueError):
            render_layout_part('in.mp4', self.KEEP, plan, self.work / 'x.mp4', self.work)


class ProgrammeLoudnessRangeTest(unittest.TestCase):
    """The programme path missed -16 LUFS by ~1.2 LU on a short programme. Cause:
    loudnorm only honours `linear=true` while the material already fits the
    requested loudness range, and a brand intro at -10 LUFS around a quieter
    body measures far more range than the 11 LU the filter asked for — so the
    second pass silently ran in dynamic mode and landed where it liked.
    """

    WIDE = {
        'input_i': '-13.43',
        'input_tp': '-3.45',
        'input_lra': '13.40',
        'input_thresh': '-24.1',
        'target_offset': '0.6',
    }
    NARROW = {
        'input_i': '-23.4',
        'input_tp': '-4.1',
        'input_lra': '6.2',
        'input_thresh': '-33.9',
        'target_offset': '0.3',
    }

    def test_the_second_pass_asks_for_the_range_the_programme_actually_has(self):
        wide = loudnorm_filter(-16, self.WIDE)
        self.assertIn('LRA=13.4:', wide)
        self.assertIn('measured_LRA=13.40', wide)
        self.assertTrue(wide.endswith(':linear=true'))

    def test_material_inside_the_range_is_untouched(self):
        self.assertIn('LRA=11.0:', loudnorm_filter(-16, self.NARROW))
        self.assertEqual(loudnorm_filter(-16), f'loudnorm=I=-16.0:TP={TRUE_PEAK_DBTP}:LRA=11.0')

    def test_a_measurement_that_makes_no_sense_falls_back_to_the_plain_filter(self):
        self.assertEqual(loudnorm_filter(-16, {**self.WIDE, 'input_lra': 'n/a'}), loudnorm_filter(-16))

    def test_the_mastering_pass_sees_the_layout_the_file_ships_in(self):
        self.assertEqual(channel_filter(1), 'aformat=channel_layouts=mono,')
        self.assertEqual(channel_filter(2), 'aformat=channel_layouts=stereo,')


@unittest.skipUnless(_ffmpeg_available(), 'no ffmpeg binary reachable')
@unittest.skipIf(os.environ.get('MEDIA_TOOLKIT_SKIP_FFMPEG'), 'ffmpeg smoke test disabled')
class CameraSourceSmokeTest(unittest.TestCase):
    """A real render of a 10-bit 4:2:2 FULL-RANGE recording, through a layout plan
    whose crop sits on an ODD x — the shape that shipped a solid magenta panel.

    The fixture is half colour detail and half flat neutral grey on purpose. A
    chroma plane read one byte out of phase needs neighbouring samples that
    DIFFER to go wrong, and the grey half is where "went wrong" can be
    measured against a number: mid grey is U=V=128 and nothing else is.
    """

    @classmethod
    def setUpClass(cls):
        cls.work = Path(tempfile.mkdtemp(prefix='camera_colour_'))
        cls.addClassCleanup(shutil.rmtree, cls.work, ignore_errors=True)
        cls.source = cls._camera_file(cls.work / 'camera')

    @staticmethod
    def _camera_file(stem: Path) -> Path:
        """640x360 at 15 fps: testsrc2 on the left, flat mid grey on the right,
        carried as yuv422p10le tagged full range. HEVC when the build has
        x265 — what the camera actually writes — and lossless ffv1 otherwise,
        which decodes to the same samples.
        """
        graph = '[0:v][1:v]hstack,scale=in_range=pc:out_range=pc,format=yuv422p10le,setparams=range=pc[v]'
        inputs = [
            '-f',
            'lavfi',
            '-i',
            'testsrc2=s=320x360:r=15:d=2',
            '-f',
            'lavfi',
            '-i',
            'color=c=0x808080:s=320x360:r=15:d=2',
        ]
        for encode, suffix in (
            (['-c:v', 'libx265', '-x265-params', 'log-level=error', '-tag:v', 'hvc1'], '.mp4'),
            (['-c:v', 'ffv1'], '.mkv'),
        ):
            out = stem.with_suffix(suffix)
            done = subprocess.run(
                [
                    ffmpeg_exe(),
                    '-hide_banner',
                    '-nostdin',
                    '-y',
                    *inputs,
                    '-filter_complex',
                    graph,
                    '-map',
                    '[v]',
                    '-pix_fmt',
                    'yuv422p10le',
                    '-color_range',
                    'pc',
                    *encode,
                    str(out),
                ],
                capture_output=True,
                text=True,
            )
            if done.returncode == 0 and out.exists():
                return out
        raise unittest.SkipTest('this ffmpeg cannot write a 10-bit 4:2:2 file')

    @staticmethod
    def _plan():
        """solo_follow on an ODD crop x — the c03 panel that came out magenta."""
        return {
            'source': {'width': 640, 'height': 360},
            'canvas': {'width': 320, 'height': 180},
            'segments': [{'layout': 'solo_follow', 'start_ms': 0, 'end_ms': 2_000, 'subjects': ['p1']}],
            'paths': [
                {
                    'segment': 0,
                    'subject': 'p1',
                    'panel': 'a',
                    'w': 512,
                    'h': 360,
                    'keyframes': [[0, 101, 0], [2_000, 101, 0]],
                }
            ],
        }

    def _chroma(self, path: Path, box: str) -> tuple[float, float]:
        """Mean U and V of one box of the first frame, in an 8-bit decode."""
        done = subprocess.run(
            [
                ffmpeg_exe(),
                '-hide_banner',
                '-nostdin',
                '-v',
                'error',
                '-i',
                str(path),
                '-vf',
                f'crop={box}',
                '-frames:v',
                '1',
                '-f',
                'rawvideo',
                '-pix_fmt',
                'yuv420p',
                '-',
            ],
            capture_output=True,
        )
        w, h = (int(n) for n in box.split(':')[:2])
        blob, luma, plane = done.stdout, w * h, (w // 2) * (h // 2)
        self.assertEqual(len(blob), luma + 2 * plane, done.stderr[-400:])
        u = blob[luma : luma + plane]
        v = blob[luma + plane :]
        return sum(u) / len(u), sum(v) / len(v)

    def _render(self, source: dict | None, name: str) -> Path:
        out = self.work / name
        render_layout_part(
            self.source, [(0, 2_000)], self._plan(), out, self.work, fps=15, crf=28, preset='ultrafast', source=source
        )
        return out

    def test_the_probe_reads_what_the_recording_is(self):
        info = probe(self.source)
        self.assertEqual(info['pix_fmt'], 'yuv422p10le')
        self.assertEqual(info['color_range'], 'pc')
        self.assertTrue(source_normalize(info).startswith('scale=in_range=pc:out_range=tv,format=yuv420p,'))

    def test_a_ten_bit_full_range_source_renders_with_neutral_grey(self):
        out = self._render(probe(self.source), 'fixed.mp4')
        # the flat grey half of the picture, well inside the crop
        u, v = self._chroma(out, '100:160:200:10')
        self.assertAlmostEqual(u, 128, delta=2, msg=f'U={u}')
        self.assertAlmostEqual(v, 128, delta=2, msg=f'V={v}')

    def test_the_deliverable_says_what_it_is(self):
        out = self._render(probe(self.source), 'tagged.mp4')
        info = probe(out)
        self.assertEqual(info['pix_fmt'], 'yuv420p')
        self.assertEqual(info['color_range'], 'tv')
        self.assertEqual(info['color_space'], 'bt709')
        self.assertEqual(info['color_primaries'], 'bt709')
        self.assertEqual(info['color_transfer'], 'bt709')
        text = subprocess.run(
            [ffmpeg_exe(), '-hide_banner', '-nostdin', '-i', str(out)], capture_output=True, text=True
        ).stderr
        # ffmpeg collapses the three to one name when they agree
        self.assertIn('yuv420p(tv, bt709', text)

    def test_an_ordinary_eight_bit_recording_comes_out_pixel_for_pixel_the_same(self):
        """The promise to every recording already in the system: the same frames.

        "The way it was" is rebuilt here rather than remembered — the graph
        with the colour statement taken out of it and no `-color_range` on the
        command line, which is exactly what this renderer emitted before.
        """
        eight = self.work / 'eight.mp4'
        subprocess.run(
            [
                ffmpeg_exe(),
                '-hide_banner',
                '-nostdin',
                '-y',
                '-f',
                'lavfi',
                '-i',
                'testsrc2=s=640x360:r=15:d=2',
                '-c:v',
                'libx264',
                '-preset',
                'ultrafast',
                '-pix_fmt',
                'yuv420p',
                str(eight),
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        info = probe(eight)
        self.assertEqual(source_normalize(info), '')  # nothing to convert

        plan, keep = self._plan(), [(0, 2_000)]
        now = self.work / 'now.mp4'
        render_layout_part(eight, keep, plan, now, self.work, fps=15, crf=28, preset='ultrafast', source=info)
        graph = build_layout_graph(
            layout_pieces(keep, plan['segments']), plan, 640, 360, 15, None, self.work, base_ms=0, source=info
        )
        before = self.work / 'before.mp4'
        subprocess.run(
            [
                ffmpeg_exe(),
                '-hide_banner',
                '-nostdin',
                '-y',
                '-ss',
                '0.000',
                '-t',
                '2.000',
                '-i',
                str(eight),
                '-filter_complex',
                graph.replace(',' + HOUSE_TAGS, ''),
                '-map',
                '[vout]',
                '-an',
                '-c:v',
                'libx264',
                '-preset',
                'ultrafast',
                '-crf',
                '28',
                '-r',
                '15',
                '-pix_fmt',
                'yuv420p',
                '-movflags',
                '+faststart',
                str(before),
            ],
            check=True,
            capture_output=True,
            text=True,
        )

        def frames(path: Path) -> str:
            out = subprocess.run(
                [ffmpeg_exe(), '-hide_banner', '-nostdin', '-v', 'error', '-i', str(path), '-f', 'framemd5', '-'],
                capture_output=True,
                text=True,
            ).stdout
            return '\n'.join(line for line in out.splitlines() if not line.startswith('#'))

        self.assertTrue(frames(before))
        self.assertEqual(frames(now), frames(before))
        self.assertEqual(probe(now)['color_range'], 'tv')  # …and it now SAYS what it is

    def test_without_the_conversion_the_same_render_is_magenta(self):
        """The guard on the guard: with the source unprobed nothing is converted,
        the odd crop runs on 10-bit chroma and the grey half comes out nowhere
        near neutral. If this ever passes, the test above stopped proving
        anything.
        """
        out = self._render(None, 'broken.mp4')
        u, v = self._chroma(out, '100:160:200:10')
        self.assertGreater(abs(u - 128) + abs(v - 128), 30, f'U={u} V={v}')


if __name__ == '__main__':
    unittest.main()
