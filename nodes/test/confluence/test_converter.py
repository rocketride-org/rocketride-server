# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Unit tests for the Confluence storage-format HTML converter (no network).

converter.py has no rocketlib/engine dependency, but importing it through the
`nodes.confluence` package still triggers that package's __init__, which pulls
in the engine runtime (rocketlib, depends) via IEndpoint.py. Stub those two
only (bs4/requests are real, installed packages, left untouched), following
the same import-then-restore approach used by nodes/test/tool_oura.
"""

from __future__ import annotations

import importlib
import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

try:
    import bs4  # noqa: F401

    _HAS_BS4 = True
except ImportError:
    _HAS_BS4 = False

# converter.py imports bs4 lazily (inside convert_storage_html) only once the
# input is non-empty — so the empty-input test keeps running regardless, and
# only the tests that push real HTML through the parser need to skip.
requires_bs4 = pytest.mark.skipif(not _HAS_BS4, reason='bs4 not installed')

_NODES_SRC = Path(__file__).resolve().parents[2] / 'src'
if str(_NODES_SRC) not in sys.path:
    sys.path.insert(0, str(_NODES_SRC))


def _build_import_stubs():
    rocketlib = MagicMock()
    rocketlib.IEndpointBase = object
    rocketlib.IGlobalBase = object
    rocketlib.debug = lambda *a, **kw: None
    rocketlib.getObject = MagicMock()
    rocketlib.monitorStatus = lambda *a, **kw: None
    rocketlib.monitorCompleted = lambda *a, **kw: None
    rocketlib.monitorFailed = lambda *a, **kw: None

    depends = MagicMock()
    depends.depends = lambda *a, **kw: None

    return {'rocketlib': rocketlib, 'depends': depends}


_added_stubs = []
for _name, _stub in _build_import_stubs().items():
    if _name not in sys.modules:
        sys.modules[_name] = _stub
        _added_stubs.append(_name)

try:
    converter = importlib.import_module('nodes.confluence.converter')
finally:
    for _name in _added_stubs:
        sys.modules.pop(_name, None)


def test_empty_body_returns_empty():
    text, tables = converter.convert_storage_html('')
    assert text == ''
    assert tables == []


@requires_bs4
def test_plain_paragraph_becomes_text():
    text, tables = converter.convert_storage_html('<p>Hello team</p>')
    assert 'Hello team' in text
    assert tables == []


@requires_bs4
def test_table_extracted_and_removed_from_text():
    html = (
        '<p>Intro</p><table><tr><th>Name</th><th>Owner</th></tr><tr><td>API</td><td>Alice</td></tr></table><p>Outro</p>'
    )
    text, tables = converter.convert_storage_html(html)

    assert 'Intro' in text
    assert 'Outro' in text
    # Table cell text must not leak into the surrounding text lane
    assert 'API' not in text
    assert 'Alice' not in text

    assert len(tables) == 1
    assert tables[0].splitlines()[0] == '| Name | Owner |'
    assert '| API | Alice |' in tables[0]


@requires_bs4
def test_multiple_tables_each_rendered_separately():
    html = '<table><tr><th>A</th></tr><tr><td>1</td></tr></table><table><tr><th>B</th></tr><tr><td>2</td></tr></table>'
    _, tables = converter.convert_storage_html(html)

    assert len(tables) == 2
    assert '| A |' in tables[0]
    assert '| B |' in tables[1]


@requires_bs4
def test_ragged_row_is_padded_to_header_width():
    # A row with fewer cells than the header shouldn't misalign columns.
    html = '<table><tr><th>A</th><th>B</th><th>C</th></tr><tr><td>1</td></tr></table>'
    _, tables = converter.convert_storage_html(html)

    body_line = tables[0].splitlines()[2]
    assert body_line == '| 1 |  |  |'


@requires_bs4
def test_wider_body_row_is_not_truncated():
    # A body row with MORE cells than the header must not silently lose data —
    # the source table is already gone from the text lane by this point.
    html = '<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td><td>3</td></tr></table>'
    _, tables = converter.convert_storage_html(html)

    lines = tables[0].splitlines()
    # Width comes from the widest row (3), so the header pads out to match
    # rather than the body row getting truncated down to the header's width.
    assert lines[0] == '| A | B |  |'
    assert lines[2] == '| 1 | 2 | 3 |'


@requires_bs4
def test_pipe_and_backslash_in_cell_are_escaped():
    html = '<table><tr><th>Note</th></tr><tr><td>a | b \\ c</td></tr></table>'
    _, tables = converter.convert_storage_html(html)

    assert '| a \\| b \\\\ c |' in tables[0]


@requires_bs4
def test_table_with_no_rows_is_skipped():
    html = '<p>Text</p><table></table>'
    text, tables = converter.convert_storage_html(html)
    assert tables == []
    assert 'Text' in text


@requires_bs4
def test_excess_blank_lines_collapsed():
    html = '<p>One</p><p></p><p></p><p></p><p>Two</p>'
    text, _ = converter.convert_storage_html(html)
    assert '\n\n\n' not in text
