"""
Unit tests for ai.common.table.Table.

Table.parse_markdown_table converts a markdown pipe-table into (headers, rows),
auto-numbering columns A, B, C, ... when no header separator is present and
coercing numeric cells to int / float. generate_markdown_table is the inverse,
and _excel_column_name is the helper that drives both.
"""

import pytest

from ai.common.table import Table


# ---------------------------------------------------------------------------
# _excel_column_name
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    'index, expected',
    [
        (0, 'A'),
        (1, 'B'),
        (25, 'Z'),
        (26, 'AA'),
        (27, 'AB'),
        (51, 'AZ'),
        (52, 'BA'),
        (701, 'ZZ'),
        (702, 'AAA'),
    ],
)
def test_excel_column_name(index, expected):
    """0-based indices must map to spreadsheet-style A, B, ..., Z, AA, AB labels."""
    assert Table._excel_column_name(index) == expected


# ---------------------------------------------------------------------------
# parse_markdown_table — empty / degenerate input
# ---------------------------------------------------------------------------


def test_parse_empty_string():
    """Empty input yields empty headers and rows."""
    headers, rows = Table.parse_markdown_table('')
    assert headers == []
    assert rows == []


def test_parse_no_pipe_lines():
    """Input with no '|' character is treated as having no rows."""
    headers, rows = Table.parse_markdown_table('hello world\nno pipes here')
    assert headers == []
    assert rows == []


# ---------------------------------------------------------------------------
# parse_markdown_table — header + separator
# ---------------------------------------------------------------------------


def test_parse_with_header_and_separator():
    """A standard markdown table with a --- separator yields named headers."""
    md = """
    | name | age |
    | --- | --- |
    | alice | 30 |
    | bob   | 25 |
    """
    headers, rows = Table.parse_markdown_table(md)
    assert headers == ['name', 'age']
    assert rows == [['alice', 30], ['bob', 25]]


def test_parse_recognises_alignment_separators():
    """Separator rows with alignment colons (:---, :---:, ---:) still count as headers."""
    md = """
    | a | b | c |
    | :--- | :---: | ---: |
    | x | y | z |
    """
    headers, rows = Table.parse_markdown_table(md)
    assert headers == ['a', 'b', 'c']
    assert rows == [['x', 'y', 'z']]


# ---------------------------------------------------------------------------
# parse_markdown_table — no header (auto-numbered columns)
# ---------------------------------------------------------------------------


def test_parse_without_header_uses_excel_letters():
    """When no separator row is present, columns are auto-named A, B, C, ..."""
    md = '| a | 1 |\n| b | 2 |'
    headers, rows = Table.parse_markdown_table(md)
    assert headers == ['A', 'B']
    assert rows == [['a', 1], ['b', 2]]


def test_parse_single_row_no_header():
    """A single-row table with no separator is auto-headered as well."""
    md = '| 10 | 20 | 30 |'
    headers, rows = Table.parse_markdown_table(md)
    assert headers == ['A', 'B', 'C']
    assert rows == [[10, 20, 30]]


# ---------------------------------------------------------------------------
# parse_markdown_table — type coercion
# ---------------------------------------------------------------------------


def test_parse_coerces_int_and_float():
    """Numeric cells become int or float; non-numeric cells stay as strings."""
    md = """
    | s | i | f |
    | --- | --- | --- |
    | hello | 42 | 3.14 |
    """
    _, rows = Table.parse_markdown_table(md)
    assert rows == [['hello', 42, 3.14]]


def test_parse_keeps_strings_with_spaces():
    """Cells containing non-numeric text remain strings."""
    md = """
    | label | value |
    | --- | --- |
    | abc def | not_a_number |
    """
    _, rows = Table.parse_markdown_table(md)
    assert rows == [['abc def', 'not_a_number']]


# ---------------------------------------------------------------------------
# parse_markdown_table — column-count normalisation
# ---------------------------------------------------------------------------


def test_parse_pads_short_rows_with_empty_strings():
    """Rows with fewer cells than the header are right-padded with ''."""
    md = """
    | a | b | c |
    | --- | --- | --- |
    | x | y |
    """
    _, rows = Table.parse_markdown_table(md)
    assert rows == [['x', 'y', '']]


def test_parse_truncates_overlong_rows():
    """Rows with more cells than the header are truncated to the header width."""
    md = """
    | a | b |
    | --- | --- |
    | x | y | z |
    """
    _, rows = Table.parse_markdown_table(md)
    assert rows == [['x', 'y']]


# ---------------------------------------------------------------------------
# generate_markdown_table
# ---------------------------------------------------------------------------


def test_generate_with_explicit_headers():
    """generate_markdown_table emits header row, ---|--- separator, then data rows."""
    out = Table.generate_markdown_table([[1, 2], [3, 4]], headers=['x', 'y'])
    expected = '|x|y|\n|---|---|\n|1|2|\n|3|4|'
    assert out == expected


def test_generate_auto_headers_when_none_supplied():
    """When headers is None, Excel-style A, B, ... labels are generated."""
    out = Table.generate_markdown_table([[1, 2, 3]])
    assert out.splitlines()[0] == '|A|B|C|'


def test_generate_with_row_numbers():
    """row_numbers=True prepends a '#' column with 1-based row indices."""
    out = Table.generate_markdown_table([['a'], ['b']], headers=['letter'], row_numbers=True)
    lines = out.splitlines()
    assert lines[0] == '|#|letter|'
    assert lines[2] == '|1|a|'
    assert lines[3] == '|2|b|'


def test_generate_pads_short_rows():
    """Rows shorter than headers are padded with empty strings."""
    out = Table.generate_markdown_table([[1]], headers=['x', 'y'])
    # Last data line should have an empty cell for the missing 'y'.
    assert out.splitlines()[-1] == '|1||'


def test_generate_empty_data_no_headers_returns_empty():
    """With no data and no headers, the function returns an empty string."""
    assert Table.generate_markdown_table([]) == ''


# ---------------------------------------------------------------------------
# Round-trip
# ---------------------------------------------------------------------------


def test_generate_then_parse_roundtrip():
    """Generating a table then parsing it yields the original headers and data."""
    original_headers = ['name', 'age']
    original_rows = [['alice', 30], ['bob', 25]]
    md = Table.generate_markdown_table(original_rows, headers=original_headers)
    headers, rows = Table.parse_markdown_table(md)
    assert headers == original_headers
    assert rows == original_rows
