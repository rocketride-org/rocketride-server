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

"""
Unit tests for the CLI's shared file-argument expander.

`expand_file_patterns` is the one expander behind both `validate` and `eval`.
These tests pin the behavior those commands depend on and that its sibling
`find_files` deliberately does not provide: paths come back exactly as typed
(never absolutized), an unmatched pattern survives so the caller can report
it as a missing file, glob results are sorted, and duplicates are dropped
without reordering.
"""

import os

import pytest

from rocketride.cli.utils.file_utils import expand_file_patterns


@pytest.fixture
def tree(tmp_path):
    """Create a small nested file tree and return its root."""
    (tmp_path / 'nested').mkdir()
    for relative in ('b.eval.json', 'a.eval.json', 'notes.txt', 'nested/c.eval.json'):
        (tmp_path / relative).write_text('{}', encoding='utf-8')
    return tmp_path


class TestExpandFilePatterns:
    def test_literal_existing_file_is_kept_verbatim(self, tree):
        # Not absolutized: the command reports the file the user named
        literal = os.path.join(str(tree), 'a.eval.json')

        assert expand_file_patterns([literal]) == [literal]

    def test_relative_literal_path_is_not_absolutized(self, tree, monkeypatch):
        monkeypatch.chdir(tree)

        assert expand_file_patterns(['a.eval.json']) == ['a.eval.json']

    def test_glob_matches_are_sorted(self, tree):
        # b.eval.json was created first, so sorting is what puts a.* ahead
        matches = expand_file_patterns([os.path.join(str(tree), '*.eval.json')])

        assert matches == [
            os.path.join(str(tree), 'a.eval.json'),
            os.path.join(str(tree), 'b.eval.json'),
        ]

    def test_recursive_glob_descends_into_subdirectories(self, tree):
        matches = expand_file_patterns([os.path.join(str(tree), '**', '*.eval.json')])

        assert os.path.join(str(tree), 'nested', 'c.eval.json') in matches

    def test_unmatched_pattern_is_kept_verbatim(self, tree):
        # The caller needs the original text to report "file not found"
        missing = os.path.join(str(tree), 'no-such.eval.json')
        nothing_matches = os.path.join(str(tree), '*.nope')

        assert expand_file_patterns([missing, nothing_matches]) == [missing, nothing_matches]

    def test_directories_are_not_expanded(self, tree):
        # A directory matches no file, so it is kept as an unreadable entry
        # rather than pulling in everything under it (unlike find_files)
        directory = os.path.join(str(tree), 'nested')

        assert expand_file_patterns([directory]) == [directory]

    def test_duplicates_are_dropped_preserving_first_position(self, tree):
        literal = os.path.join(str(tree), 'a.eval.json')
        pattern = os.path.join(str(tree), '*.eval.json')

        # a.eval.json is named twice - once literally, once via the glob
        assert expand_file_patterns([literal, pattern]) == [
            literal,
            os.path.join(str(tree), 'b.eval.json'),
        ]

    def test_argument_order_is_preserved_across_patterns(self, tree):
        second = os.path.join(str(tree), 'b.eval.json')
        first_pattern = os.path.join(str(tree), 'nested', '*.eval.json')

        assert expand_file_patterns([second, first_pattern]) == [
            second,
            os.path.join(str(tree), 'nested', 'c.eval.json'),
        ]

    def test_no_patterns_yields_no_files(self):
        assert expand_file_patterns([]) == []
