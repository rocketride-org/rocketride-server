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

"""Pure conversion helpers for Confluence storage-format XHTML.

Kept free of any engine/rocketlib imports so it can be unit tested in
isolation, without standing up the pipeline engine.
"""

from __future__ import annotations

import re
from typing import List, Tuple


def convert_storage_html(html: str) -> Tuple[str, List[str]]:
    """Convert a Confluence storage-format page body into (text, tables).

    Tables are extracted and removed from the body first, so their cell
    text isn't duplicated in the plain-text output; each table is rendered
    as an independent Markdown table string.

    bs4 is imported here rather than at module level so that merely
    importing this module (as test collection and IEndpoint.py's
    `from .converter import convert_storage_html` both do) never requires
    beautifulsoup4 to be installed — only actually calling this function
    does. The engine installs it at runtime via requirements.txt/depends(),
    but the bare pytest-collection step some CI jobs run does not.
    """
    if not html or not html.strip():
        return '', []

    from bs4 import BeautifulSoup

    soup = BeautifulSoup(html, 'html.parser')

    tables: List[str] = []
    for table_tag in soup.find_all('table'):
        markdown_table = _table_to_markdown(table_tag)
        if markdown_table:
            tables.append(markdown_table)
        table_tag.decompose()

    text = soup.get_text(separator='\n')
    text = re.sub(r'[ \t]+\n', '\n', text)
    text = re.sub(r'\n{3,}', '\n\n', text).strip()

    return text, tables


def _table_to_markdown(table_tag) -> str:
    """Render a BeautifulSoup <table> tag as a Markdown table string."""
    rows = []
    for row_tag in table_tag.find_all('tr'):
        cells = row_tag.find_all(['th', 'td'])
        if not cells:
            continue
        rows.append([cell.get_text(separator=' ', strip=True) for cell in cells])

    if not rows:
        return ''

    header, *body = rows
    # Size columns from the widest row, not just the header — a body row with
    # extra cells would otherwise be silently truncated with no way to
    # recover that data (the source table is already removed from the text
    # lane by the time this runs).
    width = max(len(row) for row in rows)

    def _escape(cell: str) -> str:
        return cell.replace('\\', '\\\\').replace('|', '\\|').replace('\n', '<br>')

    def _render_row(cells: List[str]) -> str:
        padded = (cells + [''] * width)[:width]
        return '| ' + ' | '.join(_escape(cell) for cell in padded) + ' |'

    lines = [_render_row(header), '| ' + ' | '.join(['---'] * width) + ' |']
    lines.extend(_render_row(row) for row in body)
    return '\n'.join(lines)
