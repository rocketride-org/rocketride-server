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
media_render caption style tests.

Ported from test_captions_style.py — the same cases against the folded-in
`media_render.captions`, with every assertion value unchanged, so the move
is a behaviour-preservation proof.

The first class is the contract that matters most: every legacy preset name
(`classic`, `yellow-bold`, `white-outline`, `minimal`) must still produce
BYTE-IDENTICAL ASS after the CaptionStyle rework. `_legacy_build_ass` below is
the builder exactly as it stood before the gallery existed — the new one is
compared against it word for word, plus one absolute golden string so the two
implementations can never drift together.

The rest covers the CaptionStyle model: resolution from strings/dicts and the
ASS features a style can switch on (weight, case, colours, outline, shadow,
box, position, alignment, line length, karaoke off, per-word emphasis,
keywords, speaker colours). SRT/VTT are unaffected by style and are checked
here too.
"""

from __future__ import annotations
import unittest


from media_render.captions import (  # noqa: E402
    CAPTION_LAYOUTS,
    build_ass,
    build_srt,
    build_vtt,
    group_words_for,
    resolve_caption_style,
    seam_placement,
    style_is_off,
)

GROUPS = [
    [
        {'word': 'Hello', 'start_ms': 0, 'end_ms': 400, 'speaker': 'A'},
        {'word': 'there', 'start_ms': 420, 'end_ms': 900, 'speaker': 'A'},
    ],
    [
        {'word': 'we', 'start_ms': 1500, 'end_ms': 1700, 'speaker': 'B'},
        {'word': '{go}', 'start_ms': 1700, 'end_ms': 2100, 'speaker': 'B'},
        {'word': 'now.', 'start_ms': 2150, 'end_ms': 2600, 'speaker': 'B'},
    ],
]


# --------------------------------------------------------------------------
# the builder as it was, frozen (do not "improve" it — it is the reference)

_LEGACY_PRESETS = {
    'classic': {
        'highlight': '&H004A6BFF',
        'text': '&H00FFFFFF',
        'outline': '&H00000000',
        'back': '&H80000000',
        'bold': -1,
        'outline_px': 4,
        'shadow': 0,
        'scale': 1.0,
    },
    'yellow-bold': {
        'highlight': '&H0000D4FF',
        'text': '&H00FFFFFF',
        'outline': '&H00402010',
        'back': '&H80000000',
        'bold': -1,
        'outline_px': 5,
        'shadow': 1,
        'scale': 1.12,
    },
    'white-outline': {
        'highlight': '&H00FFFFFF',
        'text': '&H00E6E6E6',
        'outline': '&H00000000',
        'back': '&HFF000000',
        'bold': -1,
        'outline_px': 5,
        'shadow': 0,
        'scale': 1.0,
    },
    'minimal': {
        'highlight': '&H00FFFFFF',
        'text': '&H00E6E6E6',
        'outline': '&H00000000',
        'back': '&HFF000000',
        'bold': 0,
        'outline_px': 2,
        'shadow': 0,
        'scale': 0.9,
    },
}


def _legacy_time(ms: int) -> str:
    ms = max(0, int(ms))
    cs = (ms % 1000) // 10
    s = ms // 1000
    h, rem = divmod(s, 3600)
    m, sec = divmod(rem, 60)
    return f'{h}:{m:02d}:{sec:02d}.{cs:02d}'


def _legacy_clean(word: str) -> str:
    return word.replace('{', '(').replace('}', ')').replace('\n', ' ').strip()


def _legacy_build_ass(groups, layout='vertical', preset='classic', font_name='DejaVu Sans', placement=None) -> str:
    play_w, play_h, font_size, margin_v = CAPTION_LAYOUTS[layout]
    style = _LEGACY_PRESETS.get(preset) or _LEGACY_PRESETS['classic']
    font_size = int(round(font_size * style['scale']))
    header = '\n'.join(
        [
            '[Script Info]',
            'ScriptType: v4.00+',
            f'PlayResX: {play_w}',
            f'PlayResY: {play_h}',
            'WrapStyle: 2',
            'ScaledBorderAndShadow: yes',
            '',
            '[V4+ Styles]',
            'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, '
            'Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, '
            'Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
            f'Style: Default,{font_name},{font_size},{style["highlight"]},{style["text"]},{style["outline"]},{style["back"]},'
            f'{style["bold"]},0,0,0,100,100,0,0,1,{style["outline_px"]},{style["shadow"]},2,60,60,{margin_v},1',
            '',
            '[Events]',
            'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
        ]
    )
    events = []
    for group in groups:
        line_start = group[0]['start_ms']
        line_end = group[-1]['end_ms']
        parts = []
        for i, w in enumerate(group):
            next_start = group[i + 1]['start_ms'] if i + 1 < len(group) else line_end
            duration_cs = max(1, (next_start - w['start_ms']) // 10)
            parts.append(f'{{\\k{duration_cs}}}{_legacy_clean(w["word"])}')
        text = ' '.join(parts)
        if placement is not None and placement(line_start) == 'seam':
            text = f'{{\\an5\\pos({play_w // 2},{play_h // 2})}}' + text
        events.append(f'Dialogue: 0,{_legacy_time(line_start)},{_legacy_time(line_end)},Default,,0,0,0,,{text}')
    return header + '\n' + '\n'.join(events) + '\n'


CLASSIC_VERTICAL_GOLDEN = (
    '[Script Info]\n'
    'ScriptType: v4.00+\n'
    'PlayResX: 1080\n'
    'PlayResY: 1920\n'
    'WrapStyle: 2\n'
    'ScaledBorderAndShadow: yes\n'
    '\n'
    '[V4+ Styles]\n'
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, '
    'Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, '
    'Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n'
    'Style: Default,DejaVu Sans,64,&H004A6BFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,4,0,2,60,60,520,1\n'
    '\n'
    '[Events]\n'
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n'
    'Dialogue: 0,0:00:00.00,0:00:00.90,Default,,0,0,0,,{\\k42}Hello {\\k48}there\n'
    'Dialogue: 0,0:00:01.50,0:00:02.60,Default,,0,0,0,,{\\k20}we {\\k45}(go) {\\k45}now.\n'
)


class LegacyPresetParityTest(unittest.TestCase):
    """Nothing a producer already asked for may look different after the rework."""

    PRESETS = ('classic', 'yellow-bold', 'white-outline', 'minimal')

    def test_every_legacy_preset_is_byte_identical_in_both_layouts(self):
        for preset in self.PRESETS:
            for layout in ('vertical', 'wide'):
                with self.subTest(preset=preset, layout=layout):
                    self.assertEqual(build_ass(GROUPS, layout, preset), _legacy_build_ass(GROUPS, layout, preset))

    def test_seam_placement_still_lands_on_the_same_bytes(self):
        place = seam_placement([{'start_ms': 0, 'end_ms': 1000, 'layout': 'stacked_two'}])
        self.assertEqual(
            build_ass(GROUPS, 'vertical', 'classic', placement=place),
            _legacy_build_ass(GROUPS, 'vertical', 'classic', placement=place),
        )

    def test_an_unknown_preset_still_falls_back_to_classic(self):
        self.assertEqual(build_ass(GROUPS, 'vertical', 'nonsense'), _legacy_build_ass(GROUPS, 'vertical', 'classic'))

    def test_a_custom_font_name_is_honoured_as_before(self):
        self.assertEqual(
            build_ass(GROUPS, 'wide', 'minimal', font_name='Inter'),
            _legacy_build_ass(GROUPS, 'wide', 'minimal', font_name='Inter'),
        )

    def test_the_absolute_golden_pins_both_implementations(self):
        self.assertEqual(build_ass(GROUPS, 'vertical', 'classic'), CLASSIC_VERTICAL_GOLDEN)

    def test_a_style_object_naming_only_a_legacy_preset_changes_nothing(self):
        self.assertEqual(
            build_ass(GROUPS, 'vertical', style={'preset': 'yellow-bold'}),
            _legacy_build_ass(GROUPS, 'vertical', 'yellow-bold'),
        )

    def test_sidecars_ignore_the_style_entirely(self):
        self.assertIn('Hello there', build_srt(GROUPS))
        self.assertIn('WEBVTT', build_vtt(GROUPS))
        self.assertNotIn('HELLO', build_srt(GROUPS))


class ResolveStyleTest(unittest.TestCase):
    def test_a_string_becomes_the_full_object(self):
        style = resolve_caption_style('yellow-bold')
        self.assertEqual(style['preset'], 'yellow-bold')
        self.assertEqual(style['highlight_color'], '#FFD400')
        self.assertTrue(style['karaoke'])
        for key in (
            'font',
            'weight',
            'size',
            'case',
            'color',
            'outline',
            'shadow',
            'box',
            'position',
            'alignment',
            'max_words',
            'max_lines',
            'emphasis',
            'keywords',
            'speaker_colors',
        ):
            self.assertIn(key, style)

    def test_aliases_and_studio_vocabulary_map_onto_presets(self):
        self.assertEqual(resolve_caption_style('clean')['preset'], 'minimal')
        self.assertEqual(resolve_caption_style('yellow')['preset'], 'yellow-bold')
        self.assertEqual(resolve_caption_style('outline')['preset'], 'white-outline')
        self.assertEqual(resolve_caption_style(None)['preset'], 'classic')
        self.assertEqual(resolve_caption_style(True)['preset'], 'classic')
        self.assertEqual(resolve_caption_style(False)['preset'], 'off')

    def test_the_nine_gallery_presets_all_resolve(self):
        for name in (
            'none',
            'clean-karaoke',
            'bold-impact',
            'yellow-punch',
            'white-outline',
            'boxed-focus',
            'color-pop',
            'minimal',
            'two-line-social',
        ):
            with self.subTest(name=name):
                self.assertEqual(resolve_caption_style(name)['preset'], name)

    def test_overrides_win_over_the_preset_and_rubbish_is_ignored(self):
        style = resolve_caption_style(
            {
                'preset': 'minimal',
                'color': '#123456',
                'weight': 'black',
                'case': 'upper',
                'max_words': 6,
                'karaoke': False,
                'position': 'top',
                'outline': {'width': 7},
                'font': ' Inter ',
            }
        )
        self.assertEqual(style['color'], '#123456')
        self.assertEqual(style['weight'], 'black')
        self.assertEqual(style['case'], 'upper')
        self.assertEqual(style['max_words'], 6)
        self.assertEqual(style['font'], 'Inter')
        self.assertEqual(style['outline'], {'width': 7.0, 'color': '#000000'})
        self.assertFalse(style['karaoke'])
        bad = resolve_caption_style({'preset': 'classic', 'color': 'purple', 'weight': 'ultra', 'max_lines': 'x'})
        self.assertEqual(bad['color'], '#FFFFFF')
        self.assertEqual(bad['weight'], 'bold')
        self.assertEqual(bad['max_lines'], 1)

    def test_off_and_none_are_recognised_as_no_captions(self):
        self.assertTrue(style_is_off('off'))
        self.assertTrue(style_is_off(resolve_caption_style('none')))
        self.assertFalse(style_is_off(resolve_caption_style('classic')))

    def test_the_studio_per_speaker_flag_is_accepted(self):
        self.assertTrue(resolve_caption_style({'preset': 'clean', 'per_speaker_colors': True})['speaker_colors'])

    def test_line_length_follows_the_style(self):
        words = [{'word': f'w{i}', 'start_ms': i * 200, 'end_ms': i * 200 + 150} for i in range(8)]
        self.assertEqual([len(g) for g in group_words_for(words, 'classic')], [4, 4])
        self.assertEqual([len(g) for g in group_words_for(words, {'preset': 'classic', 'max_words': 2})], [2, 2, 2, 2])
        self.assertEqual([len(g) for g in group_words_for(words, 'two-line-social')], [8])


class StyleToAssTest(unittest.TestCase):
    def _style_line(self, ass: str) -> str:
        return next(line for line in ass.splitlines() if line.startswith('Style: Default,'))

    def _dialogue(self, ass: str) -> list[str]:
        return [line for line in ass.splitlines() if line.startswith('Dialogue:')]

    def test_weight_case_and_size_reach_the_style_line_and_the_text(self):
        ass = build_ass(
            GROUPS, 'vertical', style={'preset': 'classic', 'weight': 'normal', 'case': 'upper', 'size': 96}
        )
        fields = self._style_line(ass).split(',')
        self.assertEqual(fields[2], '96')  # size is px at the 1080-wide reference
        self.assertEqual(fields[7], '0')  # Bold off
        self.assertIn('HELLO', ass)
        wide = build_ass(GROUPS, 'wide', style={'preset': 'classic', 'size': 96})
        self.assertEqual(self._style_line(wide).split(',')[2], '72')  # 48 * 96/64

    def test_colours_outline_and_shadow_are_converted_to_ass(self):
        ass = build_ass(
            GROUPS,
            'vertical',
            style={
                'preset': 'classic',
                'color': '#102030',
                'highlight_color': '#FFD400',
                'shadow': True,
                'outline': {'width': 8, 'color': '#FF0000'},
            },
        )
        fields = self._style_line(ass).split(',')
        self.assertEqual(fields[3], '&H0000D4FF')  # PrimaryColour = the karaoke highlight
        self.assertEqual(fields[4], '&H00302010')  # SecondaryColour = #102030 as BGR
        self.assertEqual(fields[5], '&H000000FF')  # outline red
        self.assertEqual(fields[16], '8')
        self.assertEqual(fields[17], '1')  # shadow on

    def test_a_box_switches_the_border_style_and_carries_its_opacity(self):
        ass = build_ass(GROUPS, 'vertical', style={'preset': 'classic', 'box': {'color': '#000000', 'opacity': 0.5}})
        fields = self._style_line(ass).split(',')
        self.assertEqual(fields[15], '3')  # BorderStyle 3 = opaque box
        self.assertEqual(fields[6], '&H80000000')  # half transparent black
        self.assertEqual(self._style_line(build_ass(GROUPS, 'vertical', 'classic')).split(',')[15], '1')

    def test_position_and_alignment_pick_the_ass_alignment(self):
        for position, alignment, expected in (
            ('bottom', 'center', '2'),
            ('bottom', 'left', '1'),
            ('middle', 'center', '5'),
            ('top', 'center', '8'),
            ('top', 'left', '7'),
        ):
            with self.subTest(position=position, alignment=alignment):
                fields = self._style_line(
                    build_ass(
                        GROUPS, 'vertical', style={'preset': 'classic', 'position': position, 'alignment': alignment}
                    )
                ).split(',')
                self.assertEqual(fields[18], expected)
        top = self._style_line(build_ass(GROUPS, 'vertical', style={'preset': 'classic', 'position': 'top'}))
        self.assertEqual(top.split(',')[21], '130')  # the bottom margin is pulled in at the top

    def test_karaoke_off_drops_every_k_tag_and_shows_the_base_colour(self):
        ass = build_ass(GROUPS, 'vertical', style={'preset': 'classic', 'karaoke': False})
        self.assertNotIn('\\k', ass)
        self.assertIn('Hello there', ass)
        self.assertEqual(self._style_line(ass).split(',')[3], '&H00FFFFFF')

    def test_two_lines_break_the_group_in_half(self):
        ass = build_ass(GROUPS, 'vertical', style={'preset': 'two-line-social'})
        self.assertIn('\\N', self._dialogue(ass)[1])
        self.assertNotIn('\\N', build_ass(GROUPS, 'vertical', 'classic'))

    def test_emphasis_gives_every_word_its_own_event(self):
        ass = build_ass(GROUPS, 'vertical', style={'preset': 'color-pop'})
        lines = self._dialogue(ass)
        self.assertEqual(len(lines), sum(len(g) for g in GROUPS))
        self.assertIn('\\fscx112', lines[0])
        self.assertNotIn('\\k', ass)
        self.assertIn('\\b900', lines[0])  # the "black" weight tag

    def test_keywords_are_coloured_wherever_they_appear(self):
        ass = build_ass(GROUPS, 'vertical', style={'preset': 'classic', 'keywords': ['now']})
        line = self._dialogue(ass)[1]
        self.assertIn('{\\1c&H004A6BFF}now.', line)
        self.assertNotIn('{\\1c&H004A6BFF}we', line)

    def test_speaker_colours_tint_the_line_when_the_style_asks_for_them(self):
        colours = {'A': '#00FF00', 'B': None}
        ass = build_ass(GROUPS, 'vertical', style={'preset': 'classic', 'speaker_colors': True}, speaker_colors=colours)
        lines = self._dialogue(ass)
        self.assertTrue(lines[0].endswith('{\\1c&H0000FF00}{\\k42}Hello {\\k48}there'))
        self.assertNotIn('\\1c', lines[1])
        off = build_ass(GROUPS, 'vertical', style={'preset': 'classic'}, speaker_colors=colours)
        self.assertNotIn('\\1c', off)


if __name__ == '__main__':
    unittest.main()
