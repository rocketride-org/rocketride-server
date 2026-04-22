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

# Fallback duration (seconds) when a segment lacks an end timestamp
DEFAULT_CUE_DURATION = 2.0


def _format_timestamp(t: float) -> str:
    """
    Format seconds as an SRT timestamp `HH:MM:SS,mmm`.

    Negative inputs are clamped to 0. Millisecond rollover caused by
    rounding is normalized into the seconds field.

    Args:
        t (float): Time offset in seconds.

    Returns:
        str: Timestamp string in SRT format, e.g. `00:01:23,456`.
    """
    if t < 0:
        t = 0.0
    hours = int(t // 3600)
    minutes = int((t % 3600) // 60)
    seconds_float = t - hours * 3600 - minutes * 60
    seconds = int(seconds_float)
    millis = int(round((seconds_float - seconds) * 1000))
    # Guard against rounding pushing ms to 1000
    if millis >= 1000:
        millis -= 1000
        seconds += 1
    return f'{hours:02d}:{minutes:02d}:{seconds:02d},{millis:03d}'


def build_srt(docs) -> str:
    """
    Build an SRT document from a list of Doc objects.

    Expects `metadata.time_stamp` (required) and `metadata.time_stamp_end`
    (optional). Falls back to `start + DEFAULT_CUE_DURATION` when the end
    timestamp is missing or not after the start. Docs whose `page_content`
    is empty after stripping are skipped.

    Args:
        docs (list[Doc]): Ordered subtitle segments to serialize.

    Returns:
        str: SRT document content with a trailing newline. Returns a single
            trailing newline if `docs` is empty.
    """
    lines = []
    for i, doc in enumerate(docs, 1):
        metadata = doc.metadata
        start = float(getattr(metadata, 'time_stamp', 0.0) or 0.0)
        end_attr = getattr(metadata, 'time_stamp_end', None)
        end = float(end_attr) if end_attr is not None else start + DEFAULT_CUE_DURATION
        if end <= start:
            end = start + DEFAULT_CUE_DURATION

        text = (doc.page_content or '').strip()
        if not text:
            continue

        lines.append(str(i))
        lines.append(f'{_format_timestamp(start)} --> {_format_timestamp(end)}')
        lines.append(text)
        lines.append('')  # blank line between cues

    return '\n'.join(lines) + '\n'
