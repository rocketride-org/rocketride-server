# =============================================================================
# MIT License
# Copyright (c) 2024 RocketRide Inc.
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
