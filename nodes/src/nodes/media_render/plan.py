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
The render spec, normalized. Pure functions — no store, no ffmpeg, no engine —
so the whole contract of the node can be exercised in a unit test.

The public request carries a spec JSON object. The stream adapter resolves
`source` to a received stream and supplies its private `write_to` prefix;
`outputs` is required. This module validates the resulting internal document:

    {
      "source": "<received stream name>",                  # the recording to cut from
      "source_range": [start_ms, end_ms],        # decode window; `keep` remains on the source clock
      "keep":   [[s, e], …],                     # what survives, in source ms
      "map":    [[src_s, src_e, out_s], …],      # source <-> output map (default: from `keep`)
      "window": [out_a, out_b],                  # render only this slice of the output timeline
      "mutes":  [[s, e], …], "bleeps": [[s, e], …],   # both on the SOURCE timeline

      "audio":  {"denoise": true, "highpass": true, "compress": true, "master": true,
                 "loudness_lufs": -16, "true_peak": -1, "channels": 2},
      "music":  {"source": "<received stream name>", "gain_db": -22, "duck_db": -12, "fade_ms": 1500},
      "overlays": [{"image": "<received stream name>", "corner": "tr", "height": 0.1, "opacity": 1}],
      "cards":  [{"text": "…", "subtitle": "…", "seconds": 3, "at": "start"|"end"}],
      "concat": [{"source": "<received stream name>", "at": "start"|"end"}],

      "subtitles": {"words": [{"w"|"word", "s"|"start_ms", "e"|"end_ms", "speaker"}],
                    "groups": [ … ],             # already grouped, on the OUTPUT timeline
                    "style": <CaptionStyle>, "speaker_colors": {}, "sidecars": false,
                    "name": "captions", "files": {"srt": "…", "vtt": "…"},
                    "map_through_keep": true},

      "framing_plan": <plan>,                    # a framing plan (`pan`/`layout` also read)
      "framing_offset_ms": 0,                    # where the plan's own zero sits in the source

      "outputs": [{"key",                        # the key this file gets in the report
                   "name",                       # file name without the extension
                   "file",                       # or the full file name, extension included
                   "container": "mp4|mp3|wav",
                   "layout"|"aspect"|"width"/"height",   # the shape; `long_edge`/`short_edge` size it
                   "fps_max", "crf", "preset", "captions", "audio_channels", "tier",
                   "fit": "fit"|"fill", "background": "blur"|"#rrggbb",
                   "framing": true|false,        # drive this output with the framing plan
                   "from": "<key>"|"programme_audio"}],   # derive instead of rendering
      "thumbnail": true | {"name", "at_ms"},     # default: on for `clip`, off for `programme`
      "chunking": {"part_ms": 300000},
      "chapters": [{"title", "out_ms"}],         # files are written in `export` mode

      "pipeline": "clip"|"programme",            # default: derived (see choose_pipeline)
      "mode": "preview"|"export",                # a draft to be re-made vs the deliverable
      "quality": "<label>", "title": "…", "version": 3, "name": "…",
      "media": {"width", "height", "fps", "has_video"},   # what the source is (for the report)
      "fit", "background", "long_edge", "aspect",         # defaults for every output
      "write_to": "outputs",                    # internal scratch directory, not public config
      "status_meta": { … added to every progress event … },
      "warnings": [ … ], "meta": { … merged under the report … }
    }

Nothing in here (or anywhere else in the node) knows what the files are for.
"""

from __future__ import annotations
from ._support.paths import SpecError, check_store_path, check_input_path, check_destination, FILTER_CHARS
from .captions import (
    CAPTION_LAYOUTS,
    group_words,
    group_words_for,
    resolve_caption_style,
    style_is_off,
)

from .render_lib import (
    PROGRAMME_PART_MS,
    LOUDNESS_TARGET_LUFS,
    TRUE_PEAK_DBTP,
    TimelineMap,
    aspect_dims,
    capped_dims,
    caption_layout_for,
    dims,
    map_words_to_output,
    range_to_keep,
    shift_groups,
    spec_hash,
)

VIDEO_CONTAINERS = ('mp4', 'mov', 'mkv', 'webm')

AUDIO_CONTAINERS = ('mp3', 'wav', 'm4a', 'aac', 'flac')

LAYOUT_NAMES = ('vertical', 'wide', '9:16', '16:9', '4:5', '1:1')

PROGRAMME_AUDIO = 'programme_audio'  # reserved `from:` — the mastered programme

DEFAULTS = {
    'long_edge': 960,
    'fps': 30,
    'crf': 28,
    'preset': 'ultrafast',
    'captions': True,
    'sidecars': False,
    'part_ms': PROGRAMME_PART_MS,
}


def as_ranges(rows) -> list[tuple[int, int]]:
    """
    [[s, e], …] or [{start_ms, end_ms}, …] -> non-empty (s, e) pairs, sorted by
    start. The picture is cut in time order whatever order the spec listed
    the ranges in, so the sound has to be too.
    """
    out: list[tuple[int, int]] = []
    for row in rows or []:
        if isinstance(row, dict):
            start, end = row.get('start_ms', row.get('s')), row.get('end_ms', row.get('e'))
        elif isinstance(row, (list, tuple)) and len(row) >= 2:
            start, end = row[0], row[1]
        else:
            continue
        try:
            start, end = int(start), int(end)
        except (TypeError, ValueError):
            continue
        if end > start:
            out.append((start, end))
    return sorted(out)


SPEC_SCHEMA_VERSIONS = (1, 2)


SAFE_WORD = ('fit', 'fill', 'crop', 'cover', 'contain', 'blur', 'none')

KNOWN_PRESETS = ('ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow')


def _text(value) -> str:
    return value if isinstance(value, str) else ('' if value is None else str(value))


def _check_ranges(rows, field: str, *, required: bool = False) -> list[tuple[int, int]]:
    if rows in (None, ''):
        rows = []
    if not isinstance(rows, (list, tuple)):
        raise SpecError(f'{field} must be a list of [start, end] times in milliseconds.')
    out: list[tuple[int, int]] = []
    for i, row in enumerate(rows):
        if isinstance(row, dict):
            start, end = row.get('start_ms', row.get('s')), row.get('end_ms', row.get('e'))
        elif isinstance(row, (list, tuple)) and len(row) >= 2:
            start, end = row[0], row[1]
        else:
            raise SpecError(f'{field}[{i}] is not a [start, end] pair.')
        if isinstance(start, bool) or isinstance(end, bool):
            raise SpecError(f'{field}[{i}] has a true/false where a time should be.')
        try:
            start, end = int(start), int(end)
        except (TypeError, ValueError):
            raise SpecError(f'{field}[{i}] has a time that is not a whole number of milliseconds.') from None
        if start < 0 or end < 0:
            raise SpecError(f'{field}[{i}] has a negative time.')
        if end <= start:
            raise SpecError(f'{field}[{i}] ends at or before it starts ({start} → {end}).')
        out.append((start, end))
    if required and not out:
        raise SpecError(f'{field} is empty — there is nothing to render.')
    return out


def _check_word(value, field: str, allowed: tuple[str, ...] | None = None) -> None:
    text = _text(value).strip()
    if not text:
        return
    if allowed is not None and text.lower() not in allowed:
        raise SpecError(f'{field} is {text!r}; it has to be one of {", ".join(allowed)}.')
    for ch in FILTER_CHARS:
        if ch in text:
            raise SpecError(f'{field} contains a character ffmpeg would read as part of a filter ({ch!r}).')


def _check_colour(value, field: str) -> None:
    text = _text(value).strip()
    if not text:
        return
    lowered = text.lower()
    if lowered in SAFE_WORD:
        return
    if lowered.startswith('#') or lowered.startswith('0x'):
        digits = lowered[1:] if lowered.startswith('#') else lowered[2:]
        if len(digits) in (6, 8) and all(c in '0123456789abcdef' for c in digits):
            return
        raise SpecError(f'{field} is not a colour ({text!r}).')
    if not lowered.isalpha():
        raise SpecError(f'{field} is not a colour ({text!r}).')


def validate_spec(spec: dict) -> dict:
    """
    Everything that has to be true before a render starts. Raises `SpecError`
    with a sentence a person can act on; the node never writes a file until
    this has passed.
    """
    if not isinstance(spec, dict):
        raise SpecError('The render spec is not an object.')

    version = spec.get('schema_version')
    if version is not None:
        if isinstance(version, bool) or not isinstance(version, int):
            raise SpecError('schema_version has to be a whole number.')
        if version not in SPEC_SCHEMA_VERSIONS:
            raise SpecError(
                f'This spec is schema version {version}; this renderer reads '
                f'{" and ".join(str(v) for v in SPEC_SCHEMA_VERSIONS)}.'
            )

    for field in ('meta', 'status_meta'):
        if spec.get(field) is not None and not isinstance(spec[field], dict):
            raise SpecError(f'{field} must be an object.')
    if spec.get('warnings') is not None and not isinstance(spec['warnings'], list):
        raise SpecError('warnings must be a list.')
    if spec.get('framing_plan') is not None and not isinstance(spec['framing_plan'], dict):
        raise SpecError('framing_plan must be an object.')
    framing = framing_plan(spec)
    segments = (framing or {}).get('segments')
    if segments is not None:
        if not isinstance(segments, list):
            raise SpecError('framing_plan.segments must be a list.')
        for i, segment in enumerate(segments):
            field = f'framing_plan.segments[{i}]'
            if not isinstance(segment, dict) or not isinstance(segment.get('layout'), str):
                raise SpecError(f'{field} must be an object with a string layout.')
            for key in ('start_ms', 'end_ms'):
                value = segment.get(key)
                if not (type(value) is int or isinstance(value, float) and value.is_integer()):
                    raise SpecError(f'{field}.{key} must be a whole number of milliseconds.')
            _check_ranges([segment], field)

    source = check_input_path(spec.get('source'), 'source')
    write_to = check_store_path(spec.get('write_to'), 'write_to').rstrip('/')
    check_store_path(spec.get('report_to'), 'report_to', allow_empty=True)
    check_store_path(spec.get('status_to'), 'status_to', allow_empty=True)

    keep = _check_ranges(spec.get('keep'), 'keep', required=not spec.get('source_range'))
    _check_ranges(spec.get('mutes'), 'mutes')
    _check_ranges(spec.get('bleeps'), 'bleeps')
    for field in ('window', 'source_range', 'range'):
        value = spec.get(field)
        if value not in (None, ''):
            _check_ranges([value], field)

    media = spec.get('media') if isinstance(spec.get('media'), dict) else {}
    duration_ms = int(media.get('duration_ms') or 0)
    if duration_ms > 0 and keep and min(s for s, _ in keep) >= duration_ms + 1000:
        raise SpecError('The keep list starts after the end of the recording — it is on a different clock.')

    entries = spec.get('outputs')
    if isinstance(entries, (str, dict)):
        entries = [entries]
    if not entries:
        raise SpecError('The spec asks for no outputs.')
    written = {check_store_path(spec.get('report_to'), 'report_to', allow_empty=True).strip('/')} - {''}
    for i, entry in enumerate(entries):
        if isinstance(entry, str):
            continue
        if not isinstance(entry, dict):
            raise SpecError(f'output {i + 1} is not an object.')
        name = _text(entry.get('key') or entry.get('name') or i + 1)
        file_name = _text(entry.get('file') or '')
        if file_name:
            check_store_path(file_name, f'the file name of output {name!r}')
            path = f'{write_to}/{file_name}'.strip('/')
            if path == source:
                raise SpecError(f'Output {name!r} would be written over the recording it is cut from.')
            if path in written:
                raise SpecError(f'Two outputs would be written to the same file ({file_name!r}).')
            written.add(path)
        _check_word(entry.get('preset'), f'the encoder preset of output {name!r}', KNOWN_PRESETS)
        _check_word(entry.get('fit'), f'the fit of output {name!r}', SAFE_WORD)
        _check_colour(entry.get('background'), f'the background of output {name!r}')
        _check_word(entry.get('container'), f'the container of output {name!r}')
    _check_word(spec.get('fit'), 'fit', SAFE_WORD)
    _check_colour(spec.get('background'), 'background')

    for field in ('overlays', 'concat'):
        for item in spec.get(field) or []:
            if isinstance(item, dict):
                check_input_path(
                    item.get('image') or item.get('path') or item.get('source'), f'a file named in {field}'
                )
    music = spec.get('music')
    if isinstance(music, dict) and music.get('source'):
        check_input_path(music.get('source'), 'the music file')
    thumb = spec.get('thumbnail')
    if isinstance(thumb, dict) and (thumb.get('file') or thumb.get('name')):
        check_store_path(thumb.get('file') or f'{thumb.get("name")}.jpg', 'the thumbnail file name')
    subs = spec.get('subtitles') if isinstance(spec.get('subtitles'), dict) else {}
    files = subs.get('files') if isinstance(subs.get('files'), dict) else {}
    for kind, value in files.items():
        if value:
            check_store_path(value, f'the {kind} sidecar file name')
    validate_output_paths(spec, normalize_outputs(spec, has_video=bool(media.get('has_video', True))))
    return spec


def validate_output_paths(spec: dict, outputs: list[dict], config: dict | None = None) -> None:
    """Check generated names and collisions after output defaults are resolved."""
    root = check_store_path(spec.get('write_to'), 'write_to').rstrip('/')
    destinations: set[str] = set()

    def reserve(path, field):
        canonical = check_destination(path, spec, field)
        if any(
            canonical == other or canonical.startswith(other + '/') or other.startswith(canonical + '/')
            for other in destinations
        ):
            raise SpecError(f'Two outputs would be written to the same file or directory ({path!r}).')
        destinations.add(canonical)

    for field in ('report_to', 'status_to'):
        if spec.get(field):
            reserve(spec[field], field)
    for output in outputs:
        reserve(f'{root}/{output["file"]}', f'output {output["key"]!r}')
    subs = spec.get('subtitles') if isinstance(spec.get('subtitles'), dict) else {}
    # Validate even unused caller-provided names; profiles can enable these later.
    primary = next((o for o in outputs if o['video']), outputs[0])
    name = str(subs.get('name') or primary['name'])
    named = subs.get('files') if isinstance(subs.get('files'), dict) else {}
    sidecars = subs.get('sidecars')
    wants_sidecars = bool((config or {}).get('sidecars', False)) if sidecars is None else bool(sidecars)
    for kind in ('srt', 'vtt'):
        filename = str(named.get(kind) or f'{name}.{kind}')
        check_store_path(filename, f'the {kind} sidecar file name')
        if wants_sidecars or named.get(kind):
            reserve(f'{root}/{filename}', f'{kind} sidecar')
    thumb = spec.get('thumbnail', choose_pipeline(spec) == 'clip')
    if thumb:
        options = thumb if isinstance(thumb, dict) else {}
        given = str(options.get('file') or '')
        name = given.rsplit('.', 1)[0] if given else str(options.get('name') or outputs[0]['name'])
        check_store_path(f'{name}.jpg', 'the thumbnail file name')
        reserve(f'{root}/{name}.jpg', 'thumbnail')
    chapter_files = spec.get('chapter_files')
    wants_chapters = str(spec.get('mode') or '').lower() == 'export' if chapter_files is None else bool(chapter_files)
    if spec.get('chapters') and choose_pipeline(spec) == 'programme' and wants_chapters:
        for filename in ('chapters.json', 'chapters.txt'):
            reserve(f'{root}/{filename}', 'chapters')


def map_from_keep(keep: list[tuple[int, int]]) -> list[list[int]]:
    """The source <-> output map, rebuilt from the keep list when a spec omits it."""
    rows, out = [], 0
    for start, end in keep:
        rows.append([start, end, out])
        out += end - start
    return rows


def resolve_keep(spec: dict) -> dict:
    """
    The keep list this render really cuts, plus the output offset its captions
    live on. A `window` renders only the source slices behind an output-time
    window (the range preview) — everything else renders the whole keep list.
    """
    full = as_ranges(spec.get('keep'))
    source_range = spec.get('source_range') if isinstance(spec.get('source_range'), (list, tuple)) else None
    if not full and source_range:
        full = [(int(source_range[0]), int(source_range[1]))]
    if not full:
        raise ValueError('the spec has no keep segments')
    # the one place both pipelines take their keep list from: sorted above, and
    # disjoint here — two ranges sharing material would play its sound twice
    # under a picture that shows it once (touching ranges are fine)
    for (a, b), (c, d) in zip(full, full[1:]):
        if c < b:
            raise SpecError(f'keep intervals must not overlap: [{a}, {b}] and [{c}, {d}] do.')
    rows = spec.get('map') or map_from_keep(full)
    window = (
        spec.get('window') if isinstance(spec.get('window'), (list, tuple)) and len(spec.get('window')) == 2 else None
    )
    keep, offset_ms = full, 0
    if window:
        offset_ms = max(0, int(window[0]))
        keep = [(s, e) for s, e in range_to_keep(rows, offset_ms, int(window[1])) if e > s]
        if not keep:
            raise ValueError('the requested window falls entirely inside a cut')
    if source_range:
        lower, upper = _check_ranges([source_range], 'source_range')[0]
        if any(start < lower or end > upper for start, end in keep):
            raise SpecError('Rendered keep intervals must stay inside source_range.')
    return {
        'full_keep': full,
        'keep': keep,
        'map': rows,
        'window': list(window) if window else None,
        'offset_ms': offset_ms,
        'body_ms': sum(e - s for s, e in keep),
        'source_range': [int(source_range[0]), int(source_range[1])] if source_range else None,
    }


def choose_pipeline(spec: dict) -> str:
    """
    `clip` — one short piece: a single audio pass (cut, cleaned, mastered) and
    one encode per output.
    `programme` — a long timeline: the picture in parts, an unmastered body
    pass with bleeps and ducked music, lead-in / tail-out material concatenated
    around it and the mastering run LAST over the finished programme.

    Stated with `pipeline:`; derived from the spec's own shape otherwise.
    """
    named = str(spec.get('pipeline') or '').strip().lower()
    if named in ('clip', 'programme'):
        return named
    if (
        spec.get('chunking')
        or spec.get('bleeps')
        or spec.get('music')
        or spec.get('cards')
        or spec.get('concat')
        or spec.get('chapters')
    ):
        return 'programme'
    return 'clip'


def normalize_audio(spec: dict) -> dict:
    """The audio chain flags, defaulted the way the renderer has always run them."""
    audio = spec.get('audio') if isinstance(spec.get('audio'), dict) else {}
    return {
        'denoise': bool(audio.get('denoise', audio.get('noise_reduction', True))),
        'highpass': bool(audio.get('highpass', audio.get('high_pass', True))),
        'compress': bool(audio.get('compress', audio.get('compression', True))),
        'master': bool(audio.get('master', True)),
        'loudness_lufs': float(audio.get('loudness_lufs') or LOUDNESS_TARGET_LUFS),
        'true_peak': float(audio.get('true_peak') if audio.get('true_peak') is not None else TRUE_PEAK_DBTP),
        'channels': int(audio.get('channels') or 2),
    }


def _geometry(entry: dict, spec: dict, config: dict) -> tuple[int, int]:
    width, height = entry.get('width'), entry.get('height')
    if width and height:
        return max(2, int(width) // 2 * 2), max(2, int(height) // 2 * 2)
    long_edge = int(entry.get('long_edge') or spec.get('long_edge') or config['long_edge'])
    layout = str(entry.get('layout') or '').strip().lower()
    if layout in LAYOUT_NAMES:
        return dims(layout, long_edge)
    aspect = entry.get('aspect') or spec.get('aspect')
    short_edge = entry.get('short_edge')
    if aspect and short_edge:
        return aspect_dims(aspect, int(short_edge))
    return capped_dims(aspect or '16:9', long_edge)


def normalize_output(entry, index: int, spec: dict, config: dict, has_video: bool = True) -> dict:
    """One entry of `outputs` with every gap filled from the spec and the node config."""
    if isinstance(entry, str):
        entry = {'key': entry, 'layout': entry} if entry in LAYOUT_NAMES else {'key': entry}
    if not isinstance(entry, dict):
        raise ValueError(f'output {index} is not an object')
    layout = str(entry.get('layout') or '').strip().lower() or None
    key = check_output_key(entry.get('key') or layout or entry.get('name') or f'out{index + 1}', index)
    # Aspect aliases are valid report keys, but ':' is not a portable filename.
    default_name = key.replace(':', 'x') if key in LAYOUT_NAMES else key
    name = str(entry.get('name') or spec.get('name') or default_name)
    # an output that states a shape is a picture; one that asks for the
    # programme's audio is not; anything else follows the source
    if layout or entry.get('aspect') or (entry.get('width') and entry.get('height')):
        default_container = 'mp4'
    elif entry.get('from') == PROGRAMME_AUDIO:
        default_container = 'mp3'
    else:
        default_container = 'mp4' if has_video else 'mp3'
    container = str(entry.get('container') or default_container).lower().lstrip('.')
    if container not in VIDEO_CONTAINERS + AUDIO_CONTAINERS:
        raise ValueError(f'output {key!r} asks for an unknown container {container!r}')
    video = container in VIDEO_CONTAINERS
    audio_cfg = normalize_audio(spec)
    out: dict = {
        'key': key,
        'name': name,
        'container': container,
        'video': video,
        'layout': layout,
        'aspect': entry.get('aspect'),
        'file': str(entry.get('file') or f'{name}.{container}'),
        'fps': max(1, int(entry.get('fps_max') or entry.get('fps') or config['fps'])),
        'crf': int(entry.get('crf') if entry.get('crf') is not None else config['crf']),
        'preset': str(entry.get('preset') or config['preset']),
        'captions': bool(entry.get('captions', True)) and bool(config['captions']),
        'audio_channels': int(entry.get('audio_channels') or audio_cfg['channels']),
        'tier': str(entry.get('tier') or spec.get('quality') or spec.get('mode') or 'preview'),
        'fit': str(entry.get('fit') or spec.get('fit') or 'fit'),
        'background': entry.get('background') or spec.get('background') or 'blur',
        'framing': entry.get('framing'),
        # `from`: derive this output from another instead of rendering it
        # (`derive_from` / `transcode_from` are the older spellings)
        'from': entry.get('from') or entry.get('derive_from') or entry.get('transcode_from'),
    }
    check_store_path(out['file'], f'the file name of output {key!r}')
    check_store_path(name, f'the name of output {key!r}')
    if video:
        out['width'], out['height'] = _geometry(entry, spec, config)
        caption_layout = str(entry.get('caption_layout') or '').strip().lower()
        if caption_layout and caption_layout not in CAPTION_LAYOUTS:
            raise ValueError(
                f'output {key!r} asks for an unknown caption_layout {caption_layout!r}; '
                f'allowed layouts: {", ".join(CAPTION_LAYOUTS)}'
            )
        caption_layout = caption_layout or (layout if layout in CAPTION_LAYOUTS else None)
        out['caption_layout'] = caption_layout or caption_layout_for(out['width'], out['height'])
        # a framing plan drives the portrait / square passes; a wide pass is
        # letterboxed as it always was unless the output asks for it by name
        if out['framing'] is None:
            out['framing'] = out['height'] >= out['width']
    else:
        out['width'] = out['height'] = 0
        out['caption_layout'] = None
        out['framing'] = False
    return out


def check_output_key(value, index: int) -> str:
    """
    An output's key names its file in the report and used to name scratch
    files on disk, so it is held to the file-name rule (no `'`, `:`, `\\`,
    control characters — nothing an ffmpeg graph would misread) and, being one
    name rather than a path, may not contain a `/`. The aspect aliases (`9:16`)
    stay the valid keys they always were.
    """
    text = _text(value).strip()
    if not text:
        raise SpecError(f'output {index + 1} has an empty key.')
    if text in LAYOUT_NAMES:
        return text
    if '/' in text:
        raise SpecError(f'the key of output {index + 1} ({text!r}) contains a "/" — a key is a name, not a path.')
    return check_store_path(text, f'the key of output {index + 1}')


def normalize_outputs(spec: dict, config: dict | None = None, has_video: bool = True) -> list[dict]:
    """Normalize output definitions and resolve their dependency order."""
    config = {**DEFAULTS, **(config or {})}
    entries = spec.get('outputs')
    if isinstance(entries, (str, dict)):
        entries = [entries]
    if not entries:
        raise ValueError('the spec asks for no outputs')
    outputs = [normalize_output(entry, i, spec, config, has_video) for i, entry in enumerate(entries)]
    if not has_video:
        outputs = [o for o in outputs if not o['video']]
        if not outputs:
            raise ValueError('the source has no picture and the spec asks for no audio output')
    keys = [o['key'] for o in outputs]
    if len(set(keys)) != len(keys):
        raise ValueError(f'two outputs share a key: {sorted(keys)}')
    return outputs


def normalize_words(items) -> list[dict]:
    """Words in either the spec's short form ({w, s, e}) or the caption form."""
    words = []
    for w in items or []:
        if not isinstance(w, dict):
            continue
        word = w.get('word', w.get('w'))
        start, end = w.get('start_ms', w.get('s')), w.get('end_ms', w.get('e'))
        if word is None or start is None or end is None:
            continue
        words.append({'word': str(word), 'start_ms': int(start), 'end_ms': int(end), 'speaker': w.get('speaker')})
    return words


def caption_plan(
    spec: dict, keep: list[tuple[int, int]] | None = None, *, offset_ms: int = 0, body_ms: int | None = None
) -> dict:
    """
    The burned-in / sidecar captions: the caption lines on the timeline of the
    file this render writes, the resolved style and the per-speaker colours.

    `words` are on the source timeline and are mapped through the keep list
    (words inside a cut disappear); `groups` are already grouped lines on the
    output timeline (a caller that did its own grouping — one dict per line
    with the timed words nested, or a flat word list per line).

    A `window` renders only the slice of the output timeline from `offset_ms`
    for `body_ms`, and the finished file's clock starts there — so the lines
    are moved onto that clock and everything outside the slice is dropped
    (`shift_groups`). Without a window nothing moves.
    """
    subs = spec.get('subtitles') if isinstance(spec.get('subtitles'), dict) else {}
    style = resolve_caption_style(subs.get('style') if subs.get('style') is not None else subs.get('preset'))
    groups: list[list[dict]] = []
    raw = subs.get('groups') or []
    if raw:
        if isinstance(raw[0], dict) and isinstance(raw[0].get('words'), list):
            for group in raw:  # one dict per caption line
                words = normalize_words(group.get('words'))
                for w in words:
                    if w.get('speaker') is None:
                        w['speaker'] = group.get('speaker')
                if words:
                    groups.append(words)
        elif isinstance(raw[0], dict):
            groups = group_words(normalize_words(raw))
        else:
            for group in raw:  # a list of word lists
                words = normalize_words(group)
                if words:
                    groups.append(words)
    elif subs.get('words'):
        words = normalize_words(subs.get('words'))
        through = subs.get('map_through_keep')
        if through is None:
            through = True
        if through and keep:
            words = map_words_to_output(words, TimelineMap(list(keep)))
        groups = group_words_for(words, style)
    if offset_ms or body_ms is not None:
        groups = shift_groups(groups, int(offset_ms or 0), int(body_ms) if body_ms is not None else None)
    files = subs.get('files') if isinstance(subs.get('files'), dict) else {}
    return {
        'groups': groups,
        'style': style,
        'speaker_colors': subs.get('speaker_colors') or {},
        'sidecars': bool(subs['sidecars']) if subs.get('sidecars') is not None else None,
        'name': str(subs.get('name') or ''),
        # the caller may name its sidecars; otherwise they follow the picture
        'files': {kind: str(files[kind]) for kind in ('srt', 'vtt') if files.get(kind)},
        'enabled': bool(groups) and not style_is_off(style) and bool(subs.get('enabled', True)),
    }


def framing_plan(spec: dict) -> dict | None:
    """The framing plan the caller sent, whatever shape it arrived in."""
    plan = spec.get('framing_plan') if isinstance(spec.get('framing_plan'), dict) else None
    if plan is None and isinstance(spec.get('layout'), dict):
        plan = spec['layout']  # the schema-1 name
    if plan is None and spec.get('pan'):
        plan = {'segments': spec.get('segments') or [], 'paths': spec.get('pan')}
    return plan if isinstance(plan, dict) else None


def shift_framing(plan: dict | None, offset_ms: int) -> dict | None:
    """
    A framing plan moved from its own clock onto the recording's.

    The planner sees a copy of the clip that starts at 0, so its segments and
    crop paths are CLIP-relative; the keep list the renderer cuts is on the
    SOURCE timeline. `framing_offset_ms` (the spec's) is where the plan's zero
    sits in the recording, and everything timed in the plan moves by it — or
    the two lists never overlap and the clip renders as an unplanned full frame
    of the wrong part of the recording.
    """
    if not isinstance(plan, dict):
        return None
    offset = int(offset_ms or 0)
    if not offset:
        return plan
    shifted = dict(plan)
    shifted['segments'] = [
        {**seg, 'start_ms': int(seg.get('start_ms') or 0) + offset, 'end_ms': int(seg.get('end_ms') or 0) + offset}
        for seg in plan.get('segments') or []
        if isinstance(seg, dict)
    ]
    paths = []
    for path in plan.get('paths') or []:
        if not isinstance(path, dict):
            continue
        keyframes = [[int(k[0]) + offset, *k[1:]] for k in path.get('keyframes') or [] if len(k) >= 3]
        paths.append({**path, 'keyframes': keyframes})
    shifted['paths'] = paths
    if plan.get('speaking'):
        shifted['speaking'] = [
            {**s, 'start_ms': int(s.get('start_ms') or 0) + offset, 'end_ms': int(s.get('end_ms') or 0) + offset}
            for s in plan['speaking']
            if isinstance(s, dict) and s.get('start_ms') is not None and s.get('end_ms') is not None
        ]
    shifted['offset_ms'] = offset
    return shifted


def framing_style(plan: dict | None) -> str | None:
    """
    The reframe STYLE a plan that does not move the picture still asks for:
    `original` (the recording's own picture, letter/pillarboxed on black) when
    the producer chose it, None for the blur-padded full frame.
    """
    if not isinstance(plan, dict):
        return None
    segments = [s for s in plan.get('segments') or [] if isinstance(s, dict)]
    if segments and all(s.get('layout') == 'original' for s in segments):
        return 'original'
    if str(plan.get('mode') or '').strip().lower() == 'original':
        return 'original'
    return None


def reframes(plan: dict | None) -> bool:
    """Whether a plan actually moves the picture — a plan of full frames does not."""
    if not isinstance(plan, dict):
        return False
    return any(s.get('layout') not in ('full_frame', 'original') for s in plan.get('segments') or [])


def framing_summary(plan: dict | None, applied: bool) -> dict | None:
    """What the report says about the framing plan it was handed."""
    if not isinstance(plan, dict):
        return None
    return {
        'mode': plan.get('mode'),
        'subject_override': plan.get('subject_override'),
        'applied': bool(applied),
        'segments': [
            {k: s.get(k) for k in ('start_ms', 'end_ms', 'layout', 'subjects', 'reason')}
            for s in plan.get('segments') or []
        ],
        'people': [
            {k: t.get(k) for k in ('id', 'coverage', 'first_ms', 'last_ms', 'mean_center', 'mean_face_h')}
            for t in plan.get('tracks') or []
        ],
        'thumbnails': plan.get('thumbnails') or {},
        'speaking': plan.get('speaking') or [],
        'metrics': plan.get('metrics') or {},
        'method': plan.get('method'),
        'error': plan.get('error'),
    }


IDENTITY_EXCLUDE = (
    'window',
    'range',
    'quality',
    'prepared_at',
    'warnings',
    'status_to',
    'report_to',
    'meta',
    'status_meta',
    'cache_key',
    'cache',
)


def spec_identity(spec: dict) -> str:
    """
    Identity of a render: the spec that is actually going to be rendered.

    It selects nothing — every render renders — it NAMES the render, and the
    report carries it as `spec_hash` so a client can tell the plan a file was
    made from. It is derived from the document the renderer reads and from
    nothing else: a caller's own key describes what the caller knew when it
    built the spec, and the spec goes on being built after that (the
    `framing_plan` is merged in afterwards), so a key taken on trust named the
    wrong render — which is exactly how a stale picture once came back beside a
    correct plan (V3 FINDING A).

    `spec_hash` drops every runtime measurement at every depth — a framing
    plan's own `seconds`, a `prepared_at`, a `reused` flag — so two identical
    runs name the same render. Everything that IS rendered stays in: the
    framing plan's segments, its `cuts_ms` and the thumbnail paths it names
    included.
    """
    return spec_hash(spec, exclude=IDENTITY_EXCLUDE)


def part_ms_for(spec: dict, config: dict | None = None) -> int:
    """Return the configured programme part duration, clamped to at least one second."""
    chunking = spec.get('chunking') if isinstance(spec.get('chunking'), dict) else {}
    config = {**DEFAULTS, **(config or {})}
    return max(1000, int(chunking.get('part_ms') or config['part_ms']))


def overlay_for(spec: dict) -> dict | None:
    """The first image overlay (a watermark) — the one the graphs support today."""
    for item in spec.get('overlays') or []:
        if isinstance(item, dict) and (item.get('image') or item.get('path')):
            return {
                'path': item.get('image') or item.get('path'),
                'corner': item.get('corner') or 'tr',
                'height': item.get('height', 0.10),
                'opacity': item.get('opacity', 1.0),
            }
    return None


def cards_for(spec: dict, at: str) -> list[dict]:
    """Return caller-supplied title cards for the requested programme position."""
    return [c for c in (spec.get('cards') or []) if isinstance(c, dict) and str(c.get('at') or 'start').lower() == at]


def concat_for(spec: dict, at: str) -> list[dict]:
    """Return received media attachments for the requested programme position."""
    return [
        c
        for c in (spec.get('concat') or [])
        if isinstance(c, dict) and str(c.get('at') or 'start').lower() == at and c.get('source')
    ]
