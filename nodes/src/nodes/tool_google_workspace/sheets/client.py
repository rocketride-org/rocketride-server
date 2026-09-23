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


"""Google Sheets service bindings and response cleaners."""

from __future__ import annotations

import functools

from .. import google_client

SERVICE = google_client.GoogleService(
    product='Google Sheets',
    api='sheets',
    version='v4',
    superset_scopes=frozenset(
        {
            'https://www.googleapis.com/auth/spreadsheets',
            'https://www.googleapis.com/auth/drive',
        }
    ),
)

token_scope_report = functools.partial(google_client.token_scope_report, SERVICE)
execute = functools.partial(google_client.execute, SERVICE)

# ---------------------------------------------------------------------------
# Response cleaners
# ---------------------------------------------------------------------------


def clean_sheet_props(props: dict | None) -> dict:
    """Compact a sheet's properties: id, title, index, type, and grid size."""
    if not isinstance(props, dict):
        return {}
    grid = props.get('gridProperties') or {}
    out: dict = {
        'sheetId': props.get('sheetId'),
        'title': props.get('title'),
        'index': props.get('index'),
        'sheetType': props.get('sheetType'),
    }
    if grid:
        out['gridProperties'] = {
            k: grid[k] for k in ('rowCount', 'columnCount', 'frozenRowCount', 'frozenColumnCount') if k in grid
        }
    return {k: v for k, v in out.items() if v is not None}


def clean_spreadsheet(ss: dict | None) -> dict:
    """Compact a spreadsheet: id, title, url, and per-sheet properties."""
    if not isinstance(ss, dict):
        return {}
    props = ss.get('properties') or {}
    return {
        'spreadsheetId': ss.get('spreadsheetId'),
        'title': props.get('title'),
        'locale': props.get('locale'),
        'timeZone': props.get('timeZone'),
        'spreadsheetUrl': ss.get('spreadsheetUrl'),
        'sheets': [clean_sheet_props((s or {}).get('properties')) for s in ss.get('sheets') or []],
    }


def clean_value_range(vr: dict | None) -> dict:
    """Compact a ValueRange: range, majorDimension, and the 2-D values."""
    if not isinstance(vr, dict):
        return {}
    return {
        'range': vr.get('range'),
        'majorDimension': vr.get('majorDimension'),
        'values': vr.get('values') or [],
    }


def clean_update_result(resp: dict | None) -> dict:
    """Compact an UpdateValuesResponse: range + updated-cell counts."""
    if not isinstance(resp, dict):
        return {}
    return {
        k: resp[k]
        for k in ('spreadsheetId', 'updatedRange', 'updatedRows', 'updatedColumns', 'updatedCells')
        if k in resp
    }


def clean_batch_update_values_result(resp: dict | None) -> dict:
    """Compact a BatchUpdateValuesResponse: totals + per-range update results."""
    if not isinstance(resp, dict):
        return {}
    out: dict = {
        k: resp[k]
        for k in (
            'spreadsheetId',
            'totalUpdatedRows',
            'totalUpdatedColumns',
            'totalUpdatedCells',
            'totalUpdatedSheets',
        )
        if k in resp
    }
    out['responses'] = [clean_update_result(r) for r in resp.get('responses') or []]
    return out


def clean_append_result(resp: dict | None) -> dict:
    """Compact an AppendValuesResponse: spreadsheetId, tableRange, and updates."""
    if not isinstance(resp, dict):
        return {}
    return {
        'spreadsheetId': resp.get('spreadsheetId'),
        'tableRange': resp.get('tableRange'),
        'updates': clean_update_result(resp.get('updates')),
    }


def clean_clear_result(resp: dict | None) -> dict:
    """Compact a ClearValuesResponse: spreadsheetId + clearedRange."""
    if not isinstance(resp, dict):
        return {}
    return {k: resp[k] for k in ('spreadsheetId', 'clearedRange') if k in resp}


def clean_batch_update_result(resp: dict | None) -> dict:
    """Compact a spreadsheets.batchUpdate response: id + raw replies (shape varies per request)."""
    if not isinstance(resp, dict):
        return {}
    out: dict = {'spreadsheetId': resp.get('spreadsheetId')}
    if 'replies' in resp:
        out['replies'] = resp.get('replies')
    return out
