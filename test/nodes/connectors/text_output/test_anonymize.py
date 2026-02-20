# =============================================================================
# MIT License
# Copyright (c) 2026 RocketRide, Inc.
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

from nodes.text_output.anonymize import anonymize


# Anonymize example
def test():
    """Test anonymize basic replacement."""
    assert anonymize('aaa bbb ccc', [(4, 3)]) == 'aaa *** ccc'


# Anonimization character
def test_char():
    """Test anonymize with custom replacement character."""
    assert anonymize('aaa bbb ccc', [(4, 3)], anonymize_char='#') == 'aaa ### ccc'


# Anonimization length shorter that match length
def test_length_shorter():
    """Test anonymize with replacement shorter than match length."""
    assert anonymize('aaa bbb ccc', [(4, 3)], anonymize_length=1) == 'aaa * ccc'


# Anonimization length longer that match length
def test_length_longer():
    """Test anonymize with replacement longer than match length."""
    assert anonymize('aaa bbb ccc', [(4, 3)], anonymize_length=5) == 'aaa ***** ccc'


# Start match
def test_start():
    """Test anonymize at start of text."""
    assert anonymize('aaa bbb ccc', [(0, 3)]) == '*** bbb ccc'


# End match
def test_end():
    """Test anonymize at end of text."""
    assert anonymize('aaa bbb ccc', [(8, 3)]) == 'aaa bbb ***'


# Start and end matches
def test_start_end():
    """Test anonymize at both start and end positions."""
    assert anonymize('aaa bbb ccc', [(0, 3), (8, 3)]) == '*** bbb ***'


# Whole text match
def test_whole_text():
    """Test anonymize covering the whole text."""
    assert anonymize('aaa bbb ccc', [(0, 11)]) == '***********'


# Match repetitions
def test_repetitions():
    """Test anonymize with repeated overlapping matches."""
    assert anonymize('aaa bbb ccc', [(0, 3), (0, 3), (4, 3), (4, 3), (8, 3), (8, 3)]) == '*** *** ***'


# Match overlaps
def test_overlaps():
    """Test anonymize with overlapping matches."""
    assert anonymize('aaa bbb ccc', [(0, 3), (0, 7), (4, 3), (4, 7), (8, 3)]) == '***********'


# Match overlaps with fixed length
def test_overlaps_length():
    """Test anonymize with overlaps using fixed replacement length."""
    assert anonymize('aaa bbb ccc', [(0, 3), (0, 7), (4, 3), (4, 7), (8, 3)], anonymize_length=1) == '*'


# Сonsecutive not-overlapping matches
def test_sequence():
    """Test anonymize with consecutive non-overlapping matches."""
    assert anonymize('aaa bbb ccc', [(0, 4), (4, 4), (8, 3)]) == '***********'


# Сonsecutive not-overlapping matches with fixed length
def test_sequence_length():
    """Test anonymize with consecutive matches and fixed replacement length."""
    assert anonymize('aaa bbb ccc', [(0, 4), (4, 4), (8, 3)], anonymize_length=1) == '***'
