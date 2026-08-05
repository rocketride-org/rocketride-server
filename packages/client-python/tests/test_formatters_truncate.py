# MIT License
#
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

"""Regression tests for truncate_filename (RR-1385)."""

import unittest

from rocketride.cli.utils.formatters import truncate_filename


class TestTruncateFilename(unittest.TestCase):
    def test_never_exceeds_max_length_for_small_widths(self) -> None:
        """Small widths must not overrun max_length by appending an ellipsis."""
        for max_length in range(0, 8):
            for filename in ('abcdef', 'report.txt', 'a.very_long_extension'):
                result = truncate_filename(filename, max_length)
                self.assertLessEqual(
                    len(result),
                    max_length,
                    f'{filename!r} @ {max_length} -> {result!r}',
                )

    def test_small_width_has_no_stray_ellipsis(self) -> None:
        """Widths below the ellipsis width should hard-truncate without '...'."""
        self.assertEqual(truncate_filename('abcdef', 2), 'ab')
        self.assertEqual(truncate_filename('report.txt', 1), 'r')
        self.assertEqual(truncate_filename('abcdef', 3), 'abc')
        self.assertEqual(truncate_filename('abcdef', -1), '')

    def test_returns_filename_when_it_fits(self) -> None:
        self.assertEqual(truncate_filename('a.txt', 10), 'a.txt')

    def test_preserves_extension_when_room_allows(self) -> None:
        result = truncate_filename('very_long_document_name.pdf', 20)
        self.assertLessEqual(len(result), 20)
        self.assertTrue(result.endswith('.pdf'))
        self.assertIn('...', result)


if __name__ == '__main__':
    unittest.main()
