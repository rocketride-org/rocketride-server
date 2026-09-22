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
What a caller is allowed to believe about a finished render.

Everything in here is MEASURED on the deliverable (probe + EBU R128 analysis),
never planned: an unverifiable value is reported as null with a warning rather
than asserted. The shape is report schema 2, with whatever the caller put in
the spec's `meta` block merged underneath it by the node — a measured value
always wins over a claimed one.
"""

from __future__ import annotations
import time

REPORT_SCHEMA = 2
LOUDNESS_TOLERANCE_LU = 1.0  # integrated may sit this far either side of the target
TRUE_PEAK_CEILING_DBTP = -1.0  # nothing may peak above this…
TRUE_PEAK_TOLERANCE_DB = 0.2  # …give or take the measurement's own error
DURATION_TOLERANCE_MS = 500


def dedupe(warnings) -> list[str]:
    """The same sentences, trimmed, each said once, in the order they arrived."""
    out: list[str] = []
    seen: set[str] = set()
    for item in warnings or []:
        if item is None:
            continue
        text = str(item).strip()
        if text and text not in seen:
            seen.add(text)
            out.append(text)
    return out


def loudness_block(measured: dict | None, target_lufs: float | None, *, mastered: bool = True) -> dict:
    """
    The report's `loudness` record: what the finished file measures, next to
    the target it was mastered to. `loudness_ok` is None (unknown) when the
    file was not mastered or could not be measured — it is False only when a
    real measurement is outside tolerance.
    """
    measured = measured if isinstance(measured, dict) else None
    target = float(target_lufs) if target_lufs is not None else None
    block = {
        'target_lufs': target,
        'integrated_lufs': measured.get('integrated_lufs') if measured else None,
        'true_peak_dbtp': measured.get('true_peak_dbtp') if measured else None,
        'loudness_range_lu': measured.get('loudness_range_lu') if measured else None,
        'loudness_ok': None,
    }
    if not mastered or measured is None or target is None:
        return block
    try:
        integrated = float(block['integrated_lufs'])
        peak = float(block['true_peak_dbtp'])
    except (TypeError, ValueError):
        return block
    block['loudness_ok'] = (
        abs(integrated - target) <= LOUDNESS_TOLERANCE_LU and peak <= TRUE_PEAK_CEILING_DBTP + TRUE_PEAK_TOLERANCE_DB
    )
    return block


def loudness_warning(block: dict) -> str | None:
    """Plain-language line for a finished file that missed the loudness target."""
    if not isinstance(block, dict) or block.get('loudness_ok') is not False:
        return None
    target, integrated = block.get('target_lufs'), block.get('integrated_lufs')
    peak = block.get('true_peak_dbtp')
    if integrated is not None and target is not None and abs(float(integrated) - float(target)) > LOUDNESS_TOLERANCE_LU:
        louder = 'louder' if float(integrated) > float(target) else 'quieter'
        return (
            f'The finished sound came out {abs(float(integrated) - float(target)):.1f} LU {louder} '
            f'than the {float(target):.0f} LUFS target.'
        )
    return f'The finished sound peaks at {float(peak):.1f} dBTP — above the -1.0 dBTP ceiling.'


def build_render_report(
    *,
    kind: str = 'render',
    mode: str = 'preview',
    quality: str = '',
    detail: dict | None = None,
    check: dict,
    version=None,
    title=None,
    measured=None,
    measurements=None,
    target_lufs=None,
    mastered: bool = True,
    window=None,
    preview_output_start_ms: int = 0,
    total_ms: int = 0,
    body_ms: int = 0,
    lead_ms: int = 0,
    tail_ms: int = 0,
    files=None,
    outputs=None,
    extras=None,
    source_range=None,
    fps=None,
    cuts: int = 0,
    mutes: int = 0,
    bleeps: int = 0,
    captions_on: bool = False,
    caption_lines: int = 0,
    caption_style: dict | None = None,
    caption_preset=None,
    chapters=None,
    music: bool = False,
    expect_video: bool = True,
    parts=None,
    spec_hash: str = '',
    framing: dict | None = None,
    warnings: list[str] | None = None,
    seconds: float = 0.0,
) -> dict:
    """
    Report schema 2 for one render. `warnings` is appended to in place (the
    caller keeps the same list), so a duration or loudness problem always
    reaches the producer as words, not just as a flag. The list it arrives as
    is what the SPEC carried (the caller's own warnings), so the finished
    report says both what was already known and what this render measured —
    each sentence once (F9/O1).
    """
    warnings = warnings if isinstance(warnings, list) else []
    chapters = [
        {'title': c.get('title'), 'out_ms': int(c.get('out_ms') or 0)} for c in (chapters or []) if isinstance(c, dict)
    ]
    check = check if isinstance(check, dict) else {}
    duration_ms = int(check.get('duration_ms') or 0)
    delta = duration_ms - int(total_ms)
    loudness = loudness_block(measured, target_lufs, mastered=mastered)
    has_audio, has_video = bool(check.get('has_audio')), bool(check.get('has_video'))
    clock_mode = 'export' if mode == 'export' else ('range_preview' if window else 'rough_preview')
    report = {
        'schema_version': REPORT_SCHEMA,
        'kind': kind,
        'mode': mode,
        # `quality` is the measured block (render_lib.quality_block); the
        # tier's own name stays alongside it.
        'quality': detail if isinstance(detail, dict) else quality,
        'quality_label': quality,
        'version': version,
        'title': title,
        'range': [int(window[0]), int(window[1])] if window else None,
        'duration_ms': duration_ms,
        'output_duration_ms': int(total_ms),
        'body_duration_ms': int(body_ms),
        'lead_ms': int(lead_ms),
        'tail_ms': int(tail_ms),
        'files': files or {},
        'outputs': list(outputs or []),
        'extra_aspects': list(extras or []),
        'width': check.get('width'),
        'height': check.get('height'),
        'fps': fps,
        'has_audio': has_audio,
        'has_video': has_video,
        'cuts': int(cuts),
        'muted': int(mutes),
        'bleeped': int(bleeps),
        'captions': bool(captions_on),
        'caption_lines': int(caption_lines),
        'caption_style': caption_style,
        'caption_preset': caption_preset,
        'chapters': chapters,
        'chapter_count': len(chapters),
        'clock': {
            'mode': clock_mode,
            'quality': quality,
            'range': [int(window[0]), int(window[1])] if window else None,
            'preview_output_start_ms': int(preview_output_start_ms or 0),
        },
        'mastered': bool(mastered),
        'unmastered_preview': bool(mode != 'export' and not mastered),
        'music': bool(music),
        'loudness': loudness,
        'loudness_target_lufs': loudness['target_lufs'] if mastered else None,
        'measurements': measurements or {},
        'parts': list(parts or []),
        'layout': framing,
        # the identity of the render this file came from (`plan.spec_identity`).
        # It names the render; it never selects one — every render renders.
        'spec_hash': spec_hash,
        'warnings': warnings,
        'validation': {
            'expected_duration_ms': int(total_ms),
            'duration_ms': duration_ms,
            'delta_ms': delta,
            'duration_ok': abs(delta) <= DURATION_TOLERANCE_MS,
            'has_video': has_video,
            'has_audio': has_audio,
            'streams_ok': bool(has_audio and (has_video or not expect_video)),
            'loudness_ok': loudness['loudness_ok'],
        },
        'rendered_at': time.time(),
        'seconds': seconds,
    }
    if source_range:
        report['start_ms'] = int(source_range[0])
        report['end_ms'] = int(source_range[1])
        report['source_duration_ms'] = int(source_range[1]) - int(source_range[0])
    if not report['validation']['duration_ok']:
        warnings.append(f'The finished file is {delta / 1000:.1f}s off the planned length.')
    problem = loudness_warning(loudness)
    if problem:
        warnings.append(problem)
    # in place, so the caller's list stays the report's list — the same
    # sentence can arrive both from the spec and from the measurement
    warnings[:] = dedupe(warnings)
    return report
