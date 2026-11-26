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
Regressions for six confirmed render defects: filtergraph quoting (a title
with an apostrophe rendered a blank card), silent audio (the second loudnorm
pass was fed `-inf` and the report carried `-Infinity`), windowed renders
burning in the wrong captions, the clip path squeezing wide-range material to
11 LU, a poster time past the end failing the whole render, and card fonts on
Windows / a toolchain without fontconfig.
"""

from __future__ import annotations

import importlib
import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest
import unittest.mock
from pathlib import Path
from types import SimpleNamespace

from media_render import plan as plan_lib
from media_render import render_lib as render_lib_module
from media_render import report as report_lib
from media_render._support.paths import SpecError
from media_render._support.workspace import Workspace, write_json
from media_render.captions import build_ass
from media_render.render_lib import (
    BLANK_CARD_WARNING,
    SILENT_AUDIO_WARNING,
    _CARD_FONTS,
    _escape_drawtext,
    _escape_filter_path,
    build_video_filter,
    card_font_file,
    card_graph,
    card_text_unavailable,
    ffmpeg_exe,
    loudness_measurable,
    loudnorm_filter,
    master_wav,
    mastering_pass,
    measure_loudness,
    probe,
    render_audio,
    render_card,
    render_programme_audio,
    thumbnail,
    thumbnail_at_ms,
)

from .test_streams import feed, node

# the module, not the class the package re-exports under the same name
instance_module = importlib.import_module('media_render.IInstance')

SPEC = {'source': 'in.mp4', 'write_to': 'out', 'keep': [[0, 10_000]], 'outputs': [{'key': 'wide', 'layout': 'wide'}]}

# what loudnorm's first pass prints for five seconds of silence (verbatim)
SILENT_STATS = {
    'input_i': '-inf',
    'input_tp': '-inf',
    'input_lra': '0.00',
    'input_thresh': '-70.00',
    'output_i': '-inf',
    'output_tp': '-inf',
    'output_lra': '0.00',
    'output_thresh': '-70.00',
    'normalization_type': 'dynamic',
    'target_offset': 'inf',
}
# …and for a 30 s tone whose first ten seconds sit 14 dB above the rest
WIDE_STATS = {
    'input_i': '-39.90',
    'input_tp': '-34.70',
    'input_lra': '14.00',
    'input_thresh': '-50.10',
    'output_i': '-16.00',
    'output_tp': '-11.90',
    'output_lra': '9.70',
    'output_thresh': '-26.20',
    'normalization_type': 'dynamic',
    'target_offset': '0.10',
}


def _ffmpeg_available() -> bool:
    exe = ffmpeg_exe()
    return bool(shutil.which(exe) or os.path.exists(exe))


def _ffmpeg(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [ffmpeg_exe(), '-hide_banner', '-nostdin', '-y', *args], capture_output=True, text=True, timeout=300
    )


def _first_pass(stats: dict):
    """A fake `_run_process` whose stderr carries loudnorm's JSON."""
    return lambda *args, **kwargs: SimpleNamespace(stderr=json.dumps(stats), stdout='', returncode=0)


class FiltergraphQuotingTest(unittest.TestCase):
    """ffmpeg unescapes an option value twice; the escapers have to survive both."""

    def test_an_apostrophe_steps_outside_the_quotes_and_back(self):
        # close the quote, `\\` -> `\`, `\'` -> `'`, reopen: the option parser
        # then sees `\'`, which is the one spelling it reads as a literal quote
        self.assertEqual(_escape_drawtext("Don't"), "Don'\\\\\\''t")
        self.assertEqual(_escape_filter_path("/tmp/o'brien/cap.ass"), "/tmp/o'\\\\\\''brien/cap.ass")
        # the other three: `:` once, `%` and `\` twice (drawtext expands them again)
        self.assertEqual(_escape_drawtext('a:b'), 'a\\:b')
        self.assertEqual(_escape_drawtext('100%'), '100\\\\%')
        self.assertEqual(_escape_drawtext('a\\b'), 'a\\\\\\\\b')
        self.assertEqual(_escape_filter_path('C:\\Fonts\\a.ttf'), 'C\\:\\\\Fonts\\\\a.ttf')
        graph = card_graph("Don't Panic", '', 320, 180)
        self.assertIn("text='Don'\\\\\\''t Panic'", graph)
        self.assertNotIn("\\'t", graph.replace("\\\\\\'", ''))  # never the lone `\'` that closed the quote

    def test_an_output_key_is_held_to_the_file_name_rule(self):
        with self.assertRaisesRegex(SpecError, 'the key of output 1'):
            plan_lib.normalize_outputs({**SPEC, 'outputs': [{'key': "don't", 'file': 'a.mp4'}]})
        with self.assertRaisesRegex(SpecError, r'a key is a name, not a path'):
            plan_lib.normalize_outputs({**SPEC, 'outputs': [{'key': 'a/b', 'file': 'a.mp4'}]})
        with self.assertRaisesRegex(SpecError, 'the key of output 2'):
            plan_lib.normalize_outputs({**SPEC, 'outputs': ['wide', {'key': 'a;b', 'file': 'a.mp4'}]})
        with self.assertRaises(SpecError):
            plan_lib.normalize_outputs({**SPEC, 'outputs': [{'key': '..', 'file': 'a.mp4'}]})
        # the aspect aliases stay the valid keys they always were
        outs = plan_lib.normalize_outputs({**SPEC, 'outputs': ['9:16', {'key': 'feed', 'aspect': '4:5'}]})
        self.assertEqual([o['key'] for o in outs], ['9:16', 'feed'])
        # and `validate_spec` refuses the document before anything is rendered
        with self.assertRaises(SpecError):
            plan_lib.validate_spec({**SPEC, 'outputs': [{'key': "don't", 'file': 'a.mp4'}]})

    def test_a_blank_card_is_only_for_a_toolchain_that_cannot_draw_text(self):
        no_filter = "ffmpeg failed (8): [AVFilterGraph @ 0x1] No such filter: 'drawtext' Error : Filter not found"
        bad_graph = (
            'ffmpeg failed (8): [Parsed_drawtext_0 @ 0x1] Error applying option '
            "'color_primaries' to filter 'drawtext': Option not found"
        )
        timeout = 'ffmpeg timed out after 5 seconds'
        # the command line is NOT evidence: it names drawtext and the font file itself
        tail = "\ncommand: ffmpeg -filter_complex [0:v]drawtext=text='x':fontfile='/x/Arial.ttf'[vout]"
        self.assertTrue(card_text_unavailable(RuntimeError(no_filter + tail)))
        self.assertTrue(card_text_unavailable(RuntimeError('ffmpeg failed (8): Cannot find a valid font' + tail)))
        self.assertFalse(card_text_unavailable(RuntimeError(bad_graph + tail)))
        self.assertFalse(card_text_unavailable(RuntimeError(timeout + tail)))

        work = Path(tempfile.mkdtemp(prefix='card_fallback_'))
        try:
            for message, falls_back in ((no_filter, True), (bad_graph, False), (timeout, False)):
                calls: list[list[str]] = []
                warnings: list[str] = []

                def fake_run(args, _message=message, _calls=calls):
                    _calls.append(list(args))
                    if len(_calls) == 1:
                        raise RuntimeError(_message + tail)
                    return SimpleNamespace(returncode=0)

                with unittest.mock.patch.object(render_lib_module, 'run_ffmpeg', fake_run):
                    if falls_back:
                        render_card('Title', '', 1.0, work / 'card.mp4', 320, 180, warnings=warnings)
                        self.assertEqual(len(calls), 2, message)
                        self.assertNotIn('drawtext', ' '.join(calls[1]))
                        self.assertEqual(warnings, [BLANK_CARD_WARNING])
                    else:
                        with self.assertRaises(RuntimeError):
                            render_card('Title', '', 1.0, work / 'card.mp4', 320, 180, warnings=warnings)
                        self.assertEqual(len(calls), 1, message)  # no second full timeout
                        self.assertEqual(warnings, [])
        finally:
            shutil.rmtree(work, ignore_errors=True)


class SilentAudioTest(unittest.TestCase):
    """Silence measures `-inf`: no second pass, null in the report, strict JSON."""

    def test_a_silent_first_pass_is_never_copied_into_the_second(self):
        self.assertFalse(loudness_measurable(SILENT_STATS))
        self.assertTrue(loudness_measurable(WIDE_STATS))
        self.assertFalse(loudness_measurable(None))
        warnings: list[str] = []
        self.assertIsNone(mastering_pass(-16.0, SILENT_STATS, -1.0, warnings))
        self.assertEqual(warnings, [SILENT_AUDIO_WARNING])
        mastering_pass(-16.0, SILENT_STATS, -1.0, warnings)
        self.assertEqual(warnings, [SILENT_AUDIO_WARNING])  # said once
        self.assertIn('linear=true', mastering_pass(-16.0, WIDE_STATS, -1.0, warnings))
        # a caller that only has the filter string still gets one loudnorm accepts
        self.assertNotIn('measured_I', loudnorm_filter(-16.0, SILENT_STATS))
        self.assertNotIn('inf', loudnorm_filter(-16.0, SILENT_STATS))

    def test_render_audio_passes_silence_through(self):
        for renderer, source in ((render_audio, 'in.wav'), (render_programme_audio, 'in.mp4')):
            encodes: list[list[str]] = []
            warnings: list[str] = []
            work = Path(tempfile.mkdtemp(prefix='silent_'))
            try:
                with (
                    unittest.mock.patch.object(render_lib_module, '_run_process', _first_pass(SILENT_STATS)),
                    unittest.mock.patch.object(render_lib_module, 'run_ffmpeg', lambda a: encodes.append(list(a))),
                ):
                    renderer(source, [(0, 5_000)], work / 'out.wav', master=True, warnings=warnings)
            finally:
                shutil.rmtree(work, ignore_errors=True)
            graph = encodes[-1][encodes[-1].index('-filter_complex') + 1]
            self.assertNotIn('loudnorm', graph, renderer.__name__)
            self.assertNotIn('inf', graph, renderer.__name__)
            self.assertEqual(warnings, [SILENT_AUDIO_WARNING], renderer.__name__)

    def test_the_report_and_its_file_never_carry_infinity(self):
        silent = {'integrated_lufs': float('-inf'), 'true_peak_dbtp': float('-inf'), 'loudness_range_lu': 0.0}
        block = report_lib.loudness_block(silent, -16.0)
        self.assertEqual((block['integrated_lufs'], block['true_peak_dbtp'], block['loudness_ok']), (None, None, None))
        self.assertEqual(
            report_lib.finite({'a': [float('nan'), 1.5, {'b': float('inf')}]}), {'a': [None, 1.5, {'b': None}]}
        )
        report = report_lib.build_render_report(
            check={'duration_ms': 5_000, 'has_audio': True, 'has_video': False},
            measured=silent,
            measurements={'audio': silent},
            detail={'bitrate': float('nan')},
            target_lufs=-16.0,
            total_ms=5_000,
            expect_video=False,
        )
        text = json.dumps(report, allow_nan=False)  # would raise on any non-finite number
        self.assertNotIn('Infinity', text)
        self.assertNotIn('NaN', text)
        self.assertIsNone(report['measurements']['audio']['integrated_lufs'])
        self.assertIsNone(report['quality']['bitrate'])

        store = Workspace()
        try:
            with self.assertRaises(ValueError):
                write_json(store, 'report.json', {'loudness': silent})
            write_json(store, 'report.json', report)
            self.assertIsNone(json.loads(store.resolve('report.json').read_text())['loudness']['integrated_lufs'])
        finally:
            store.close()


class WindowedCaptionsTest(unittest.TestCase):
    """A `window` renders a slice of the output timeline; the captions are that slice's."""

    @staticmethod
    def _words(seconds: int) -> list[dict]:
        return [{'w': f'w{i}', 's': i * 1_000, 'e': i * 1_000 + 400} for i in range(seconds)]

    @staticmethod
    def _said(caps: dict) -> list[tuple[str, int, int]]:
        return [(w['word'], w['start_ms'], w['end_ms']) for group in caps['groups'] for w in group]

    def test_a_window_carries_the_words_spoken_inside_it(self):
        spec = {**SPEC, 'keep': [[0, 60_000]], 'window': [30_000, 40_000], 'subtitles': {'words': self._words(60)}}
        keep = plan_lib.resolve_keep(spec)
        self.assertEqual((keep['offset_ms'], keep['body_ms']), (30_000, 10_000))
        caps = plan_lib.caption_plan(spec, keep['full_keep'], offset_ms=keep['offset_ms'], body_ms=keep['body_ms'])
        said = self._said(caps)
        self.assertEqual(said[0], ('w30', 0, 400))  # the word spoken at 30 s opens the slice, at its zero
        self.assertEqual(said[-1][0], 'w39')
        self.assertEqual([w for w, _, _ in said], [f'w{i}' for i in range(30, 40)])
        self.assertTrue(all(0 <= s < e <= 10_000 for _, s, e in said))
        # without a window nothing moves
        whole = plan_lib.caption_plan(spec, keep['full_keep'])
        self.assertEqual(self._said(whole)[0], ('w0', 0, 400))
        self.assertEqual(len(self._said(whole)), 60)

    def test_the_slice_is_taken_after_the_cuts(self):
        # output 0-20 s is source 0-20 s, output 20-60 s is source 25-65 s; the
        # window 30-40 s of OUTPUT is source 35-45 s
        spec = {
            **SPEC,
            'keep': [[0, 20_000], [25_000, 65_000]],
            'window': [30_000, 40_000],
            'subtitles': {'words': self._words(65)},
        }
        keep = plan_lib.resolve_keep(spec)
        self.assertEqual(keep['keep'], [(35_000, 45_000)])
        caps = plan_lib.caption_plan(spec, keep['full_keep'], offset_ms=keep['offset_ms'], body_ms=keep['body_ms'])
        said = self._said(caps)
        self.assertEqual([w for w, _, _ in said], [f'w{i}' for i in range(35, 45)])
        self.assertEqual(said[0][1:], (0, 400))
        # ready-made lines on the output timeline move the same way
        lines = {'groups': [[{'w': 'early', 's': 1_000, 'e': 1_500}], [{'w': 'inside', 's': 31_000, 'e': 31_500}]]}
        caps = plan_lib.caption_plan({**spec, 'subtitles': lines}, keep['full_keep'], offset_ms=30_000, body_ms=10_000)
        self.assertEqual(self._said(caps), [('inside', 1_000, 1_500)])


class ThumbnailClampTest(unittest.TestCase):
    def test_a_poster_time_past_the_end_is_pulled_inside_the_picture(self):
        self.assertEqual(thumbnail_at_ms(10_000, 2_000, 10), 1_800)  # two frame periods before the end
        self.assertEqual(thumbnail_at_ms(1_999, 2_000, 30), 1_932)
        self.assertEqual(thumbnail_at_ms(500, 2_000, 10), 500)  # inside: untouched
        self.assertEqual(thumbnail_at_ms(-5, 2_000, 10), 0)
        self.assertEqual(thumbnail_at_ms(150, 50, 30), 0)  # shorter than two frames: the first frame
        self.assertEqual(thumbnail_at_ms(10_000, 0, 30), 10_000)  # unknown length changes nothing

    def test_the_node_clamps_a_caller_value_and_says_so(self):
        taken: list[int] = []
        warnings: list[str] = []
        work = Path(tempfile.mkdtemp(prefix='thumb_'))

        def fake_thumbnail(media_path, out_jpg, at_ms=1000, source=None):
            taken.append(at_ms)
            Path(out_jpg).write_bytes(b'jpg')
            return Path(out_jpg)

        try:
            instance = instance_module.IInstance.__new__(instance_module.IInstance)
            ctx = {'spec': {'thumbnail': {'at_ms': 10_000}}, 'outputs': [{'name': 'clip', 'fps': 10}], 'write_to': 'o'}
            check = {'duration_ms': 2_000, 'fps': 10.0}
            with (
                unittest.mock.patch.object(instance_module, 'thumbnail', fake_thumbnail),
                unittest.mock.patch.object(instance_module, 'write_file', lambda store, name, local: name),
            ):
                name = instance._write_thumbnail(None, ctx, work / 'clip.mp4', work, 700, check, warnings)
                self.assertEqual(name, 'o/clip.jpg')
                self.assertEqual(taken, [1_800])
                self.assertEqual(len(warnings), 1)
                self.assertIn('10.0s', warnings[0])
                self.assertIn('1.8s', warnings[0])
                # a value inside the file is taken as it is, without a word
                ctx['spec']['thumbnail'] = {'at_ms': 500}
                instance._write_thumbnail(None, ctx, work / 'clip.mp4', work, 700, check, warnings)
                self.assertEqual(taken, [1_800, 500])
                self.assertEqual(len(warnings), 1)
        finally:
            shutil.rmtree(work, ignore_errors=True)


class CardFontTest(unittest.TestCase):
    def test_windows_system_fonts_are_looked_for(self):
        self.assertTrue(any(path.endswith('/Fonts/arial.ttf') for path in _CARD_FONTS))
        self.assertTrue(any(path.endswith('/Fonts/segoeui.ttf') for path in _CARD_FONTS))
        self.assertTrue(all('\\' not in path for path in _CARD_FONTS))  # forward slashes, whatever the host

    def test_no_font_at_all_is_said_once(self):
        render_lib_module._note_no_card_font.cache_clear()
        try:
            with (
                unittest.mock.patch.object(render_lib_module, '_CARD_FONTS', ()),
                unittest.mock.patch.object(render_lib_module, '_matplotlib_font', lambda: None),
                unittest.mock.patch('rocketlib.warning') as warned,
            ):
                self.assertIsNone(card_font_file())
                self.assertIsNone(card_font_file())
                self.assertEqual(warned.call_count, 1)
                self.assertIn('fontconfig', warned.call_args[0][0])
        finally:
            render_lib_module._note_no_card_font.cache_clear()


class LoudnessRangeTest(unittest.TestCase):
    """The clip path's second pass is `loudnorm_filter`'s: the range the material has, linear."""

    def test_the_clip_second_pass_asks_for_the_range_the_material_has(self):
        for renderer, source in ((render_audio, 'in.wav'), (render_programme_audio, 'in.mp4')):
            encodes: list[list[str]] = []
            work = Path(tempfile.mkdtemp(prefix='lra_'))
            try:
                with (
                    unittest.mock.patch.object(render_lib_module, '_run_process', _first_pass(WIDE_STATS)),
                    unittest.mock.patch.object(render_lib_module, 'run_ffmpeg', lambda a: encodes.append(list(a))),
                ):
                    renderer(source, [(0, 30_000)], work / 'out.wav', master=True)
            finally:
                shutil.rmtree(work, ignore_errors=True)
            graph = encodes[-1][encodes[-1].index('-filter_complex') + 1]
            second = graph[graph.index('loudnorm=') :].removesuffix('[out]')
            self.assertIn(':LRA=14.0:', second, renderer.__name__)
            self.assertNotIn(':LRA=11.0:', second, renderer.__name__)
            self.assertIn('measured_LRA=14.00', second, renderer.__name__)
            self.assertIn('linear=true', second, renderer.__name__)
            self.assertEqual(second, loudnorm_filter(-16.0, WIDE_STATS) + ',aresample=48000', renderer.__name__)


@unittest.skipUnless(_ffmpeg_available(), 'no ffmpeg binary reachable')
@unittest.skipIf(os.environ.get('MEDIA_TOOLKIT_SKIP_FFMPEG'), 'ffmpeg smoke test disabled')
class RenderFixesSmokeTest(unittest.TestCase):
    """The same six defects against the real ffmpeg, on synthetic material (a few seconds)."""

    @classmethod
    def setUpClass(cls):
        cls.work = Path(tempfile.mkdtemp(prefix='render_fixes_'))

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.work, ignore_errors=True)

    @staticmethod
    def _ymax(video: Path) -> float:
        """The brightest luma of the first frame: white text on a dark card is ~235, a blank card ~31."""
        out = _ffmpeg('-i', str(video), '-frames:v', '1', '-vf', 'signalstats,metadata=print:file=-', '-f', 'null', '-')
        m = re.search(r'lavfi\.signalstats\.YMAX=(\d+)', out.stdout + out.stderr)
        assert m, out.stderr[-400:]
        return float(m.group(1))

    @unittest.skipUnless(card_font_file(), 'no font file on this machine for drawtext')
    def test_a_title_with_an_apostrophe_or_a_percent_is_drawn(self):
        filters = _ffmpeg('-filters')
        self.assertEqual(filters.returncode, 0, filters.stderr)
        draws_text = bool(re.search(r'\bdrawtext\s+V->V\b', filters.stdout))
        for title in ("Don't Panic", '100% Real', 'A:B', 'back\\slash'):
            warnings: list[str] = []
            card = render_card(title, 'sub', 0.5, self.work / 'card.mp4', 320, 180, fps=10, warnings=warnings)
            if draws_text:
                self.assertEqual(warnings, [], title)
                self.assertGreater(self._ymax(card), 200, title)
            else:
                self.assertEqual(len(warnings), 1, title)
                self.assertIn('cannot draw text', warnings[0])
                self.assertLess(self._ymax(card), 80, title)

    def test_a_subtitle_file_in_a_folder_with_an_apostrophe_is_found(self):
        folder = self.work / "o'brien"
        folder.mkdir(exist_ok=True)
        ass = folder / 'cap.ass'
        ass.write_text(build_ass([[{'word': 'hello', 'start_ms': 0, 'end_ms': 500}]], 'wide'), encoding='utf-8')
        graph = build_video_filter([(0, 500)], 'wide', 320, 180, 10, ass)
        self.assertIn("subtitles='", graph)
        out = _ffmpeg(
            '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=10:duration=1', '-filter_complex', graph,
            '-map', '[vout]', '-frames:v', '1', '-f', 'null', '-',
        )  # fmt: skip
        self.assertEqual(out.returncode, 0, out.stderr[-600:])

    def test_five_seconds_of_silence_render_with_a_warning(self):
        silent = self.work / 'silent.wav'
        _ffmpeg('-f', 'lavfi', '-t', '5', '-i', 'anullsrc=r=48000:cl=stereo', '-c:a', 'pcm_s16le', str(silent))
        warnings: list[str] = []
        out = render_audio(silent, [(0, 5_000)], self.work / 'silent_out.wav', master=True, warnings=warnings)
        self.assertTrue(out.exists() and out.stat().st_size > 900_000)
        self.assertEqual(warnings, [SILENT_AUDIO_WARNING])
        measured = measure_loudness(out)
        self.assertEqual((measured['integrated_lufs'], measured['true_peak_dbtp']), (None, None))
        report = report_lib.build_render_report(
            check=probe(out), measured=measured, measurements={'audio': measured}, target_lufs=-16.0, total_ms=5_000
        )
        self.assertNotIn('Infinity', json.dumps(report, allow_nan=False))
        self.assertIsNone(report['loudness']['loudness_ok'])
        # the programme path's twin, and the whole-programme master, survive it too
        twin: list[str] = []
        render_programme_audio(silent, [(0, 5_000)], self.work / 'silent_body.wav', master=True, warnings=twin)
        self.assertEqual(twin, [SILENT_AUDIO_WARNING])
        self.assertTrue(master_wav(silent, self.work / 'silent_master.wav').exists())

    def test_wide_range_material_keeps_its_range_on_the_clip_path(self):
        # 10 s at -14 dB then 20 s at -28 dB: 14 LU of range that stays inside the gate
        tone = self.work / 'wide.wav'
        _ffmpeg(
            '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000:duration=30',
            '-af', "volume=enable='lt(t,10)':volume=-14dB,volume=enable='gte(t,10)':volume=-28dB",
            '-ac', '2', '-c:a', 'pcm_s16le', str(tone),
        )  # fmt: skip
        self.assertAlmostEqual(measure_loudness(tone)['loudness_range_lu'], 14.0, delta=1.0)
        out = render_audio(
            tone, [(0, 30_000)], self.work / 'wide_out.wav', master=True, denoise=False, highpass=False, compress=False
        )
        measured = measure_loudness(out)
        self.assertAlmostEqual(measured['integrated_lufs'], -16.0, delta=1.0)
        # linear gain preserves the range; the dynamic mode the fixed LRA=11 forced squeezed it to ~9.7
        self.assertAlmostEqual(measured['loudness_range_lu'], 14.0, delta=1.0)

    def test_the_last_frame_is_reachable_at_the_clamped_time(self):
        short = self.work / 'short.mp4'
        _ffmpeg('-f', 'lavfi', '-i', 'testsrc2=size=64x36:rate=10:duration=2', '-pix_fmt', 'yuv420p', str(short))
        info = probe(short)
        # Beyond-EOF seeks differ by FFmpeg version: validate the clamped
        # output itself rather than expecting an unclamped seek to fail.
        at_ms = thumbnail_at_ms(10_000, info['duration_ms'], info['fps'])
        self.assertLess(at_ms, info['duration_ms'])
        poster = thumbnail(short, self.work / 'poster.jpg', at_ms=at_ms)
        self.assertTrue(poster.exists() and poster.stat().st_size > 0)

    def test_the_node_burns_in_and_writes_the_captions_of_the_rendered_slice(self):
        source = self.work / 'source.mp4'
        _ffmpeg(
            '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
            '-t', '6', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', str(source),
        )  # fmt: skip
        spec = {
            'kind': 'media_render_spec',
            'keep': [[0, 6_000]],
            'window': [3_000, 4_500],
            'thumbnail': False,
            'outputs': [{'key': 'wide', 'file': 'render.mp4', 'aspect': '16:9', 'width': 320, 'height': 180}],
            'audio': {'master': False},
            'subtitles': {
                'words': [{'w': f'w{i}', 's': i * 500, 'e': i * 500 + 300} for i in range(12)],
                'sidecars': True,
            },
        }
        burned: list[list[list[dict]]] = []
        original = instance_module.build_ass

        def capture(groups, *args, **kwargs):
            burned.append(groups)
            return original(groups, *args, **kwargs)

        instance = node({'mode': 'render', 'spec': spec})
        with unittest.mock.patch.object(instance_module, 'build_ass', capture):
            feed(instance, source)
            instance.closing()
        answer = instance.instance.answers[-1]
        said = [(w['word'], w['start_ms']) for group in burned[0] for w in group]
        # the words spoken at 3.0, 3.5 and 4.0 s of the output, on the slice's own clock
        self.assertEqual(said, [('w6', 0), ('w7', 500), ('w8', 1_000)])
        self.assertEqual(answer['caption_lines'], len(burned[0]))
        self.assertEqual(answer['clock']['preview_output_start_ms'], 3_000)
        srt = next(item['text'] for item in answer['artifacts'] if item['name'].endswith('.srt'))
        # the sidecar is on the same clock: its first line opens at the slice's zero with the word spoken at 3 s
        self.assertRegex(srt, r'1\n00:00:00,000 --> 00:00:0[01],\d{3}\nw6')
        self.assertNotIn('w0', srt)
        self.assertNotIn('w9', srt)
