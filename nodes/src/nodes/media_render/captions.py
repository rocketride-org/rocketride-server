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
Caption builders — word-level karaoke captions (ASS, burned in by ffmpeg's
libass) plus SRT / WebVTT sidecars, all generated from the source's aligned
word timestamps after they've been mapped onto the rendered timeline.

ASS `\\k` tags give each word its own duration so the highlight advances word
by word as it is spoken; the gap to the next word is folded into the current
word's duration to keep the running time in sync with the audio.

A caption look is a **CaptionStyle** — the same object the browser stores in a
brand template (`resolve_caption_style` turns a legacy preset name, a partial
dict or nothing at all into the full normalized shape):

    {preset, font, weight, size, case, color, highlight_color,
     outline {width, color}, shadow, box {color, opacity} | None,
     position, alignment, max_words, max_lines, karaoke, emphasis,
     keywords [], speaker_colors}

`size` is pixels at the 1080-wide portrait reference; other layouts scale by
their own base size so the balance between portrait and wide stays intact.
The legacy preset names (`classic`, `yellow-bold`, `white-outline`, `minimal`,
`off`) still work everywhere and produce byte-identical ASS to before.
"""

from __future__ import annotations

import re

MAX_WORDS_PER_LINE = 4
MAX_LINE_SPAN_MS = 2_500
MAX_GAP_MS = 700

# ASS colours are &HAABBGGRR. Highlight = the studio accent (coral #FF6B4A);
# not-yet-spoken words sit in white.
ACCENT_ASS = '&H004A6BFF'
WHITE_ASS = '&H00FFFFFF'
BLACK_ASS = '&H00000000'
BACK_ASS = '&H80000000'
YELLOW_ASS = '&H0000D4FF'  # #FFD400
SOFT_WHITE_ASS = '&H00E6E6E6'
NAVY_ASS = '&H00402010'  # #102040, a deep blue outline for the yellow preset
TRANSPARENT_ASS = '&HFF000000'

ACCENT = '#FF6B4A'
WHITE = '#FFFFFF'
SOFT_WHITE = '#E6E6E6'
BLACK = '#000000'
YELLOW = '#FFD400'
NAVY = '#102040'

# The reference the CaptionStyle `size` is expressed in: the portrait layout's
# own base font size on a 1080-wide frame.
SIZE_REFERENCE = 64

# Caption geometry per layout: (play_w, play_h, font_size, margin_v). libass
# scales the PlayRes coordinate system to the real frame, so a 540x960
# preview and a 1080x1920 export share one script. The vertical margin keeps
# text clear of the platform UI chrome while staying below the speaker's face.
CAPTION_LAYOUTS = {
    'vertical': (1080, 1920, 64, 520),
    'wide': (1920, 1080, 48, 90),
    # the feed shapes: the same 1080-wide script, the margin pulled in with the frame
    '4:5': (1080, 1350, 64, 300),
    '1:1': (1080, 1080, 60, 150),
}

DEFAULT_STYLE = {
    'preset': 'classic',
    'font': None,
    'weight': 'bold',
    'size': None,
    'case': 'none',
    'color': WHITE,
    'highlight_color': ACCENT,
    'outline': {'width': 4, 'color': BLACK},
    'shadow': False,
    'box': None,
    'position': 'bottom',
    'alignment': 'center',
    'max_words': MAX_WORDS_PER_LINE,
    'max_lines': 1,
    'karaoke': True,
    'emphasis': False,
    'keywords': [],
    'speaker_colors': False,
    # `back` is the ASS BackColour a preset was drawn with (the shadow tint in
    # BorderStyle 1). It is not part of the shared CaptionStyle schema — a `box`
    # always wins over it — but keeping it lets the legacy presets render byte
    # for byte as they always have.
    'back': BACK_ASS,
}

# The caption gallery. The four legacy names below (classic, yellow-bold,
# white-outline, minimal) MUST keep producing exactly the ASS they produced
# before the gallery existed — tests/test_captions_style.py pins that.
CAPTION_STYLES: dict[str, dict] = {
    'classic': {},
    'yellow-bold': {
        'highlight_color': YELLOW,
        'color': WHITE,
        'outline': {'width': 5, 'color': NAVY},
        'shadow': True,
        'back': BACK_ASS,
    },
    'white-outline': {
        'highlight_color': WHITE,
        'color': SOFT_WHITE,
        'outline': {'width': 5, 'color': BLACK},
        'back': TRANSPARENT_ASS,
    },
    'minimal': {
        'highlight_color': WHITE,
        'color': SOFT_WHITE,
        'outline': {'width': 2, 'color': BLACK},
        'weight': 'normal',
        'back': TRANSPARENT_ASS,
    },
    'off': {'karaoke': False},
    # ---- gallery presets (the ids the brand studio offers) ----
    'none': {'karaoke': False},
    'clean-karaoke': {},
    'yellow-punch': {
        'highlight_color': YELLOW,
        'color': WHITE,
        'outline': {'width': 5, 'color': NAVY},
        'shadow': True,
        'case': 'upper',
        'back': BACK_ASS,
    },
    'bold-impact': {
        'weight': 'black',
        'case': 'upper',
        'size': 76,
        'color': WHITE,
        'highlight_color': YELLOW,
        'outline': {'width': 6, 'color': BLACK},
        'shadow': True,
        'back': BACK_ASS,
        'max_words': 3,
    },
    'boxed-focus': {
        'color': WHITE,
        'highlight_color': YELLOW,
        'outline': {'width': 0, 'color': BLACK},
        'box': {'color': BLACK, 'opacity': 0.75},
        'max_words': 4,
    },
    'color-pop': {
        'color': WHITE,
        'highlight_color': ACCENT,
        'emphasis': True,
        'weight': 'black',
        'outline': {'width': 4, 'color': BLACK},
        'back': BACK_ASS,
    },
    'two-line-social': {
        'color': WHITE,
        'highlight_color': YELLOW,
        'max_lines': 2,
        'max_words': 4,
        'outline': {'width': 4, 'color': BLACK},
        'back': BACK_ASS,
    },
}

# Scale multipliers kept out of the public style: a preset without an explicit
# `size` renders at its layout's base font times this factor (what the old
# CAPTION_PRESETS table did).
PRESET_SCALE = {'yellow-bold': 1.12, 'yellow-punch': 1.12, 'minimal': 0.9}

# Everything a producer, a request spec or the studio's own vocabulary may say
# instead of a preset id.
STYLE_ALIASES = {
    'default': 'classic',
    'clean': 'minimal',
    'plain': 'minimal',
    'bold': 'yellow-bold',
    'yellow': 'yellow-bold',
    'outline': 'white-outline',
    'white': 'white-outline',
    'karaoke': 'clean-karaoke',
    'boxed': 'boxed-focus',
    'impact': 'bold-impact',
    'pop': 'color-pop',
    'two-line': 'two-line-social',
    'social': 'two-line-social',
    'no captions': 'off',
    'none': 'none',
}

WEIGHTS = ('normal', 'bold', 'black')
CASES = ('none', 'upper')
POSITIONS = ('bottom', 'middle', 'top')
ALIGNMENTS = ('center', 'left')

# position -> (centre alignment, left alignment)
_ALIGNMENT_NUMBERS = {'bottom': (2, 1), 'middle': (5, 4), 'top': (8, 7)}


def group_words(
    words: list[dict],
    max_words: int = MAX_WORDS_PER_LINE,
    max_span_ms: int = MAX_LINE_SPAN_MS,
    max_gap_ms: int = MAX_GAP_MS,
) -> list[list[dict]]:
    """Split the word stream into short caption lines on count, span and pauses."""
    groups: list[list[dict]] = []
    current: list[dict] = []
    for w in words:
        if current:
            span = w['end_ms'] - current[0]['start_ms']
            gap = w['start_ms'] - current[-1]['end_ms']
            if len(current) >= max_words or span > max_span_ms or gap > max_gap_ms:
                groups.append(current)
                current = []
        current.append(w)
    if current:
        groups.append(current)
    return groups


def group_words_for(words: list[dict], style: dict | str | None = None) -> list[list[dict]]:
    """`group_words` with the line length the style asks for (two-line styles hold twice as much)."""
    resolved = resolve_caption_style(style)
    per_line = max(1, int(resolved['max_words']))
    span = MAX_LINE_SPAN_MS * (2 if int(resolved['max_lines']) > 1 else 1)
    return group_words(words, max_words=per_line * max(1, int(resolved['max_lines'])), max_span_ms=span)


# ------------------------------------------------------------- caption style


def _hex_colour(value, fallback: str | None = None) -> str | None:
    if not isinstance(value, str):
        return fallback
    text = value.strip().lstrip('#')
    if len(text) != 6:
        return fallback
    try:
        int(text, 16)
    except ValueError:
        return fallback
    return '#' + text.upper()


def _ass_colour(value, alpha: float = 0.0, fallback: str = WHITE_ASS) -> str:
    """#RRGGBB (+ 0..1 transparency) -> &HAABBGGRR."""
    hexed = _hex_colour(value)
    if hexed is None:
        return fallback
    r, g, b = hexed[1:3], hexed[3:5], hexed[5:7]
    a = max(0, min(255, int(max(0.0, min(1.0, float(alpha))) * 255 + 0.5)))
    return f'&H{a:02X}{b}{g}{r}'.upper()


def resolve_caption_style(value=None) -> dict:
    """
    A legacy preset name, a partial CaptionStyle dict or None -> the full
    normalized CaptionStyle. Unknown names fall back to `classic`; unknown
    values inside a dict fall back to the preset's own value.
    """
    if isinstance(value, bool):
        value = 'classic' if value else 'off'
    name, overrides = None, {}
    if isinstance(value, str):
        name = value
    elif isinstance(value, dict):
        overrides = value
        name = value.get('preset') or value.get('style')
    key = str(name or 'classic').strip().lower()
    key = STYLE_ALIASES.get(key, key)
    if key not in CAPTION_STYLES:
        key = 'classic'
    style = {**DEFAULT_STYLE, **CAPTION_STYLES[key], 'preset': key}

    def take(field, allowed=None, cast=None):
        if field not in overrides or overrides[field] is None:
            return
        raw = overrides[field]
        if cast is not None:
            try:
                raw = cast(raw)
            except (TypeError, ValueError):
                return
        if allowed is not None and raw not in allowed:
            return
        style[field] = raw

    if isinstance(overrides.get('font'), str):
        # Fontname is one field in an ASS Style CSV record.
        font = overrides['font'].translate(str.maketrans({',': ' ', '\r': ' ', '\n': ' '})).strip()
        if font:
            style['font'] = font
    take('weight', WEIGHTS, str)
    take('case', CASES, lambda v: str(v).lower())
    take('position', POSITIONS, lambda v: {'center': 'middle'}.get(str(v).lower(), str(v).lower()))
    take('alignment', ALIGNMENTS, lambda v: str(v).lower())
    if overrides.get('size') is not None:
        try:
            size = float(overrides['size'])
            if size > 0:
                style['size'] = size
        except (TypeError, ValueError):
            pass
    for field in ('color', 'highlight_color'):
        colour = _hex_colour(overrides.get(field))
        if colour:
            style[field] = colour
    outline = overrides.get('outline')
    if isinstance(outline, dict):
        width = style['outline']['width']
        try:
            width = max(0, float(outline.get('width', width)))
        except (TypeError, ValueError):
            pass
        style['outline'] = {'width': width, 'color': _hex_colour(outline.get('color'), style['outline']['color'])}
    elif isinstance(outline, (int, float)) and not isinstance(outline, bool):
        style['outline'] = {'width': max(0, float(outline)), 'color': style['outline']['color']}
    elif outline is False:
        style['outline'] = {'width': 0, 'color': style['outline']['color']}
    if 'shadow' in overrides and overrides['shadow'] is not None:
        style['shadow'] = bool(overrides['shadow'])
    if 'box' in overrides:
        box = overrides['box']
        if isinstance(box, dict):
            try:
                opacity = max(0.0, min(1.0, float(box.get('opacity', 0.75))))
            except (TypeError, ValueError):
                opacity = 0.75
            style['box'] = {'color': _hex_colour(box.get('color'), BLACK), 'opacity': opacity}
        elif box in (False, None):
            style['box'] = None if box is False else style['box']
    if overrides.get('max_words') is not None:
        try:
            style['max_words'] = max(1, min(12, int(overrides['max_words'])))
        except (TypeError, ValueError):
            pass
    if overrides.get('max_lines') is not None:
        try:
            style['max_lines'] = 2 if int(overrides['max_lines']) > 1 else 1
        except (TypeError, ValueError):
            pass
    for flag, aliases in (('karaoke', ()), ('emphasis', ()), ('speaker_colors', ('per_speaker_colors',))):
        for field in (flag, *aliases):
            if field in overrides and overrides[field] is not None:
                style[flag] = bool(overrides[field])
                break
    keywords = overrides.get('keywords')
    if isinstance(keywords, (list, tuple)):
        style['keywords'] = [str(k).strip() for k in keywords if str(k).strip()]
    elif isinstance(keywords, str) and keywords.strip():
        style['keywords'] = [k.strip() for k in keywords.split(',') if k.strip()]
    back = overrides.get('back')
    if isinstance(back, str) and re.fullmatch(r'&H[0-9A-Fa-f]{8}', back):
        style['back'] = back.upper()
    return style


def style_is_off(style) -> bool:
    """True when the style means "no captions" (`off` / `none`)."""
    if isinstance(style, str):
        return str(style).strip().lower() in ('off', 'none', 'false', 'no')
    if isinstance(style, dict):
        return str(style.get('preset') or '').lower() in ('off', 'none')
    return False


def _ass_time(ms: int) -> str:
    ms = max(0, int(ms))
    cs = (ms % 1000) // 10
    s = ms // 1000
    h, rem = divmod(s, 3600)
    m, sec = divmod(rem, 60)
    return f'{h}:{m:02d}:{sec:02d}.{cs:02d}'


def _srt_time(ms: int, sep: str = ',') -> str:
    ms = max(0, int(ms))
    s, millis = divmod(ms, 1000)
    h, rem = divmod(s, 3600)
    m, sec = divmod(rem, 60)
    return f'{h:02d}:{m:02d}:{sec:02d}{sep}{millis:03d}'


def _clean(word: str) -> str:
    """
    One word, safe to put in an ASS dialogue line. Braces would open an
    override block (`{\\an5}` would move the caption) and a backslash is how
    ASS writes a line break, so neither survives: the text is data, never
    markup.
    """
    return word.replace('{', '(').replace('}', ')').replace('\\', '/').replace('\n', ' ').replace('\r', ' ').strip()


def _number(value) -> str:
    """4.0 -> '4' (the ASS style line has always carried plain integers)."""
    number = float(value)
    return str(int(number)) if number == int(number) else f'{number:g}'


def seam_placement(segments: list[dict] | None, canvas_h: int | None = None):
    """
    Caption placement per output time for a layout plan: lines that fall in a
    stacked segment sit on the seam between the two panels (both faces stay
    clear), everything else uses the bottom band.

    The answer is `'bottom'` or `'seam'`; when the segment states its panel
    rects and they do not meet in the middle of the canvas it is
    `'seam:<fraction>'` — the seam's height as a fraction of the frame — so the
    line still lands between the two pictures.
    """
    height = int(canvas_h or 0)

    def place(t_ms: int) -> str:
        for seg in segments or []:
            if not (seg.get('start_ms', 0) <= t_ms < seg.get('end_ms', 0)):
                continue
            if seg.get('layout') != 'stacked_two':
                continue
            panels = [p for p in (seg.get('panels') or []) if isinstance(p, dict)]
            if height > 0 and len(panels) >= 2:
                top = int(panels[0].get('y') or 0) + int(panels[0].get('h') or 0)
                fraction = top / height
                if 0.05 < fraction < 0.95 and abs(fraction - 0.5) > 0.01:
                    return f'seam:{fraction:.4f}'
            return 'seam'
        return 'bottom'

    return place


def style_line(style: dict, layout: str = 'vertical', font_name: str = 'DejaVu Sans') -> str:
    """The `Style: Default,…` line a CaptionStyle produces for one caption layout."""
    play_w, play_h, base_font, margin_v = CAPTION_LAYOUTS[layout]
    if style.get('size'):
        font_size = int(round(base_font * float(style['size']) / SIZE_REFERENCE))
    else:
        font_size = int(round(base_font * PRESET_SCALE.get(style['preset'], 1.0)))
    font = style.get('font') or font_name
    primary = _ass_colour(style['highlight_color'] if style['karaoke'] else style['color'])
    secondary = _ass_colour(style['color'])
    outline = style.get('outline') or {'width': 0, 'color': BLACK}
    outline_colour = _ass_colour(outline.get('color'), fallback=BLACK_ASS)
    box = style.get('box')
    if isinstance(box, dict):
        back = _ass_colour(box.get('color'), alpha=1.0 - float(box.get('opacity', 0.75)), fallback=BACK_ASS)
        border_style = 3
    else:
        back = style.get('back') or BACK_ASS
        border_style = 1
    bold = -1 if str(style.get('weight')) in ('bold', 'black') else 0
    alignment = _ALIGNMENT_NUMBERS.get(style.get('position') or 'bottom', (2, 1))[
        0 if style.get('alignment') != 'left' else 1
    ]
    if (style.get('position') or 'bottom') == 'top':
        margin_v = max(40, margin_v // 4)
    return (
        f'Style: Default,{font},{font_size},{primary},{secondary},{outline_colour},{back},'
        f'{bold},0,0,0,100,100,0,0,{border_style},{_number(outline.get("width", 0))},'
        f'{1 if style.get("shadow") else 0},{alignment},60,60,{margin_v},1'
    )


def _word_text(word: str, style: dict) -> str:
    text = _clean(word)
    return text.upper() if style.get('case') == 'upper' else text


def _is_keyword(word: str, keywords: set[str]) -> bool:
    if not keywords:
        return False
    return _clean(word).strip('.,!?;:"\'').lower() in keywords


def _line_text(parts: list[str], style: dict) -> str:
    """One or two lines out of the rendered word parts."""
    if int(style.get('max_lines') or 1) > 1 and len(parts) > 1:
        half = (len(parts) + 1) // 2
        return ' '.join(parts[:half]) + r'\N' + ' '.join(parts[half:])
    return ' '.join(parts)


def build_ass(
    groups: list[list[dict]],
    layout: str = 'vertical',
    preset: str = 'classic',
    font_name: str = 'DejaVu Sans',
    placement=None,
    style=None,
    speaker_colors: dict | None = None,
) -> str:
    """
    The burned-in caption script. `style` is a CaptionStyle (object or preset
    name); without one the legacy `preset` name is used, and the output is
    byte for byte what this builder has always produced.
    """
    resolved = resolve_caption_style(style if style is not None else preset)
    play_w, play_h, _base_font, _margin = CAPTION_LAYOUTS[layout]
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
            style_line(resolved, layout, font_name),
            '',
            '[Events]',
            'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
        ]
    )
    primary = _ass_colour(resolved['highlight_color'] if resolved['karaoke'] else resolved['color'])
    highlight = _ass_colour(resolved['highlight_color'])
    keywords = {k.lower().strip('.,!?;:"\'') for k in resolved.get('keywords') or []}
    weight_tag = r'{\b900}' if resolved.get('weight') == 'black' else ''
    events = []
    for group in groups:
        line_start = group[0]['start_ms']
        line_end = group[-1]['end_ms']
        prefix = ''
        where = placement(line_start) if placement is not None else None
        if where == 'seam':
            prefix = f'{{\\an5\\pos({play_w // 2},{play_h // 2})}}'
        elif isinstance(where, str) and where.startswith('seam:'):
            prefix = f'{{\\an5\\pos({play_w // 2},{int(play_h * float(where[5:]))})}}'
        speaker_colour = None
        if resolved.get('speaker_colors') and speaker_colors:
            speaker_colour = _hex_colour(speaker_colors.get((group[0] or {}).get('speaker')))
        head = prefix + weight_tag + (f'{{\\1c{_ass_colour(speaker_colour)}}}' if speaker_colour else '')

        if resolved.get('emphasis'):
            # per-word pop: one event per word, the spoken word grown and coloured
            for i, w in enumerate(group):
                start = line_start if i == 0 else int(w['start_ms'])
                end = int(group[i + 1]['start_ms']) if i + 1 < len(group) else line_end
                if end <= start:
                    continue
                parts = []
                for j, other in enumerate(group):
                    text = _word_text(other['word'], resolved)
                    if j == i:
                        parts.append(f'{{\\fscx112\\fscy112\\1c{highlight}}}{text}{{\\fscx100\\fscy100\\1c{primary}}}')
                    elif _is_keyword(other['word'], keywords):
                        parts.append(f'{{\\1c{highlight}}}{text}{{\\1c{primary}}}')
                    else:
                        parts.append(text)
                events.append(
                    f'Dialogue: 0,{_ass_time(start)},{_ass_time(end)},Default,,0,0,0,,'
                    f'{head}{_line_text(parts, resolved)}'
                )
            continue

        parts = []
        for i, w in enumerate(group):
            text = _word_text(w['word'], resolved)
            if _is_keyword(w['word'], keywords):
                text = f'{{\\1c{highlight}}}{text}{{\\1c{primary}}}'
            if resolved['karaoke']:
                next_start = group[i + 1]['start_ms'] if i + 1 < len(group) else line_end
                duration_cs = max(1, (next_start - w['start_ms']) // 10)
                text = f'{{\\k{duration_cs}}}{text}'
            parts.append(text)
        events.append(
            f'Dialogue: 0,{_ass_time(line_start)},{_ass_time(line_end)},Default,,0,0,0,,'
            f'{head}{_line_text(parts, resolved)}'
        )
    return header + '\n' + '\n'.join(events) + '\n'


def build_srt(groups: list[list[dict]]) -> str:
    """Serialize cleaned caption groups as numbered SRT cues."""
    blocks = []
    for i, group in enumerate(groups, start=1):
        text = ' '.join(_clean(w['word']) for w in group)
        blocks.append(f'{i}\n{_srt_time(group[0]["start_ms"])} --> {_srt_time(group[-1]["end_ms"])}\n{text}\n')
    return '\n'.join(blocks)


def build_vtt(groups: list[list[dict]]) -> str:
    """Serialize cleaned caption groups on their output clock as WebVTT cues."""
    blocks = ['WEBVTT', '']
    for group in groups:
        text = ' '.join(_clean(w['word']) for w in group)
        blocks.append(f'{_srt_time(group[0]["start_ms"], ".")} --> {_srt_time(group[-1]["end_ms"], ".")}\n{text}\n')
    return '\n'.join(blocks)
