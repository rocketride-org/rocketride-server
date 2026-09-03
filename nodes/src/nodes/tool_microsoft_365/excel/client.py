# =============================================================================
# RocketRide Engine
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


"""Excel service bindings and response cleaners."""

from __future__ import annotations

import functools
import re
import io
import urllib.parse
import zipfile

from .. import graph_client

SERVICE = graph_client.GraphService(product='Excel', superset_scopes=frozenset({'Files.ReadWrite.All'}))

token_scope_report = functools.partial(graph_client.token_scope_report, SERVICE)
request = functools.partial(graph_client.request, SERVICE)


def _seg(value: str) -> str:
    """URL-encode a single path segment (item/permission ids may contain '!' etc.)."""
    return urllib.parse.quote(value, safe='')


_ITEM_ID_RE = re.compile(r'[A-Za-z0-9!]{15,}$')


def looks_like_item_id(value: str) -> bool:
    """True for Graph item-id-shaped tokens (or the 'root' alias) — see wb()."""
    return value == 'root' or bool(_ITEM_ID_RE.fullmatch(value))


def wb(base: str, file: str) -> str:
    """Workbook URL prefix for a drive path ('Reports/q3.xlsx') or item id.

    A path may have multiple already-valid segments, so each segment is
    percent-encoded (``safe='/'`` preserves the separators) before being
    interpolated into the ``root:/{path}:`` addressing form — an unencoded
    space raises ``http.client.InvalidURL`` and an unencoded ``#`` truncates
    the path, silently addressing the wrong item.
    """
    if looks_like_item_id(file):
        return f'{base}/drive/items/{_seg(file)}/workbook'
    return f'{base}/drive/root:/{urllib.parse.quote(file, safe="/")}:/workbook'


# ---------------------------------------------------------------------------
# Response cleaners
# ---------------------------------------------------------------------------


def clean_range(r: dict) -> dict:
    return {k: r.get(k) for k in ('address', 'values', 'formulas', 'rowCount', 'columnCount') if k in r}


def clean_worksheet(w: dict) -> dict:
    return {k: w.get(k) for k in ('id', 'name', 'position', 'visibility') if k in w}


def clean_table(t: dict) -> dict:
    return {k: t.get(k) for k in ('id', 'name', 'showHeaders', 'showTotals') if k in t}


# ---------------------------------------------------------------------------
# EMPTY_XLSX — a minimal valid .xlsx (OOXML SpreadsheetML) built once at
# import time, byte-for-byte the smallest package Excel/Graph will open: one
# sheet ("Sheet1"), no styles, no shared strings. Used by excel_create_workbook
# as the initial content for a brand-new file.
# ---------------------------------------------------------------------------

_CONTENT_TYPES_XML = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    '<Default Extension="xml" ContentType="application/xml"/>'
    '<Override PartName="/xl/workbook.xml" '
    'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    '<Override PartName="/xl/worksheets/sheet1.xml" '
    'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
    '</Types>'
)

_PACKAGE_RELS_XML = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    '<Relationship Id="rId1" '
    'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
    'Target="xl/workbook.xml"/>'
    '</Relationships>'
)

_WORKBOOK_XML = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>'
    '</workbook>'
)

_WORKBOOK_RELS_XML = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    '<Relationship Id="rId1" '
    'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" '
    'Target="worksheets/sheet1.xml"/>'
    '</Relationships>'
)

_SHEET1_XML = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>'
)


def _build_empty_xlsx() -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as zf:
        zf.writestr('[Content_Types].xml', _CONTENT_TYPES_XML)
        zf.writestr('_rels/.rels', _PACKAGE_RELS_XML)
        zf.writestr('xl/workbook.xml', _WORKBOOK_XML)
        zf.writestr('xl/_rels/workbook.xml.rels', _WORKBOOK_RELS_XML)
        zf.writestr('xl/worksheets/sheet1.xml', _SHEET1_XML)
    return buf.getvalue()


EMPTY_XLSX: bytes = _build_empty_xlsx()
