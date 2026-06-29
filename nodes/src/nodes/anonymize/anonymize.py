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


import re


# Default PII labels for zero-shot detection when the user has not configured
# their own. Kept in sync with the `entityTypes` field default in services.json
# (enforced by nodes/test/test_anonymize_logic.py::test_default_labels_match_services_json).
DEFAULT_PII_LABELS = [
    'person',
    'name',
    'email',
    'phone number',
    'address',
    'social security number',
    'credit card number',
    'date of birth',
    'organization',
    'company',
    'location',
    'ip address',
    'bank account',
    'passport number',
    'driver license',
]


def format_token(label: str) -> str:
    """Render an entity label as a clean placeholder tag, e.g. [PHONE NUMBER].

    Labels reach this function already normalized by GLiNER (lowercased, spaces
    collapsed to underscores). We undo that so multi-word types read naturally
    inside the brackets instead of as [PHONE_NUMBER].
    """
    cleaned = re.sub(r'\s+', ' ', label.replace('_', ' ')).strip()
    return f'[{cleaned.upper()}]'


def clean_entity_types(configured, defaults=None) -> list:
    """Normalize a configured `entityTypes` value into a usable label list.

    - A non-list value (e.g. a stray JSON string) is rejected outright so it can
      never be iterated character-by-character into junk single-char labels.
    - Blank / non-string entries are dropped.
    - An empty result falls back to the defaults, so detection is never silently
      disabled (this fallback is intended behavior, not a bug).
    """
    labels = DEFAULT_PII_LABELS if defaults is None else defaults
    if not isinstance(configured, list):
        return list(labels)
    cleaned = [item.strip() for item in configured if isinstance(item, str) and item.strip()]
    return cleaned or list(labels)


def anonymize(text: str, matches, anonymize_char: str = '*') -> str:
    """Replace specified segments with a sequence of anonymization characters.

    Args:
        text (str): Input text to replace the segments.
        matches (any): A list of the matches (offset and length) to be replaced with anonymization characters.
        anonymize_char (str): A char to replace with.
        anonymize_length (int): Optional. The fixed length of the sequence to replace.

    Note:
        Offsets are expected in ascending order, repetitions and overlaps are allowed.
    """
    if not matches:
        return text  # Return the original text if no matches exist

    # Merge overlapping and adjacent matches
    merged_matches = []
    for offset, length in sorted(matches):
        if merged_matches and offset <= merged_matches[-1][0] + merged_matches[-1][1]:
            prev_offset, prev_length = merged_matches.pop()
            new_offset = prev_offset
            new_length = max(prev_offset + prev_length, offset + length) - new_offset
            merged_matches.append((new_offset, new_length))
        else:
            merged_matches.append((offset, length))

    text_list = list(text)

    for offset, length in merged_matches:
        end = offset + length
        text_list[offset:end] = [anonymize_char] * length

    return ''.join(text_list)


def anonymize_tokens(text: str, matches) -> str:
    """Replace specified segments with labelled placeholder tokens.

    Args:
        text (str): Input text to replace the segments.
        matches (any): A list of (offset, length, token) tuples. The span
            [offset, offset + length) is replaced by the token string.

    Note:
        Offsets may be in any order. Only genuinely overlapping matches are
        merged (adjacent-but-distinct spans are kept separate so each entity
        keeps its own token); on a merge the first (lowest-offset, earliest in
        the input list) token is kept. Callers that want a specific label to win
        over a generic one on an equal-offset overlap must list it first.
    """
    if not matches:
        return text  # Return the original text if no matches exist

    # Merge only truly overlapping matches (strict `<`, not `<=`), keeping the
    # first token. Equal offsets are a stable tiebreak via Python's stable sort.
    merged_matches = []
    for offset, length, token in sorted(matches, key=lambda m: m[0]):
        if merged_matches and offset < merged_matches[-1][0] + merged_matches[-1][1]:
            prev_offset, prev_length, prev_token = merged_matches[-1]
            new_length = max(prev_offset + prev_length, offset + length) - prev_offset
            merged_matches[-1] = (prev_offset, new_length, prev_token)
        else:
            merged_matches.append((offset, length, token))

    # Single left-to-right pass: copy gaps verbatim, swap each span for its
    # token, then join once — O(n) instead of rebuilding the string per match.
    parts = []
    cursor = 0
    for offset, length, token in merged_matches:
        parts.append(text[cursor:offset])
        parts.append(token)
        cursor = offset + length
    parts.append(text[cursor:])

    return ''.join(parts)
