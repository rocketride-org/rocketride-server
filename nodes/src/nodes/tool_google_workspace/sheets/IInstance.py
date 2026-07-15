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

"""
Google Sheets tool node instance.

Exposes the Sheets v4 surface as agent tools: read/write/append/clear cell
values, create spreadsheets, manage tabs (add/delete/duplicate/copy), and run
arbitrary batchUpdate requests. Write operations require the ``write`` tier.

Operational targets (spreadsheetId, sheetId, ranges) are always invoke-time
parameters — never node config.
"""

from __future__ import annotations

from rocketlib import tool_function

from ai.common.utils import normalize_tool_input, optional_int, require_int, require_str, require_str_list

from ..IInstance import GoogleToolInstanceBase
from .client import (
    SERVICE,
    clean_append_result,
    clean_batch_update_result,
    clean_batch_update_values_result,
    clean_clear_result,
    clean_sheet_props,
    clean_spreadsheet,
    clean_update_result,
    clean_value_range,
    execute,
)
from .IGlobal import IGlobal

# Default write interpretation. USER_ENTERED parses strings like a user typing
# into the UI (so "=SUM(A1:A2)" becomes a formula, "1,000" a number); RAW stores
# the literal string. USER_ENTERED matches user expectations and is the documented default.
_DEFAULT_VALUE_INPUT = 'USER_ENTERED'
_VALUE_INPUT_OPTIONS = ('USER_ENTERED', 'RAW')
_VALUE_RENDER_OPTIONS = ('FORMATTED_VALUE', 'UNFORMATTED_VALUE', 'FORMULA')
_MAJOR_DIMENSIONS = ('ROWS', 'COLUMNS')


class IInstance(GoogleToolInstanceBase):
    IGlobal: IGlobal
    SERVICE = SERVICE

    # -----------------------------------------------------------------------
    # Helpers
    # -----------------------------------------------------------------------

    @staticmethod
    def _values_arg(args: dict, key: str, op: str) -> list:
        """Validate a 2-D array of cell values (list of row lists)."""
        values = args.get(key)
        if not isinstance(values, list) or not values or not all(isinstance(row, list) for row in values):
            raise ValueError(f'{op}: "{key}" must be a non-empty 2-D array (a list of row lists)')
        return values

    # =======================================================================
    # DIAGNOSTICS
    # =======================================================================

    @tool_function(
        description=(
            'Check the Google Sheets connection and verify that the granted OAuth scopes cover the '
            "node's configured access tier. Call this when a Sheets operation fails with a scope or "
            'permission error. Returns connection_ok: true when the required scopes are present.'
        ),
        input_schema={'type': 'object', 'properties': {}, 'required': []},
    )
    def check_connection(self, args: dict) -> dict:
        """Check Sheets connection status and whether granted OAuth scopes cover the access tier. Read-only."""
        return self._check_connection_impl()

    # =======================================================================
    # VALUES — read
    # =======================================================================

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['spreadsheetId', 'range'],
            'properties': {
                'spreadsheetId': {'type': 'string', 'description': 'The spreadsheet id (from its URL)'},
                'range': {'type': 'string', 'description': 'A1 notation range, e.g. "Sheet1!A1:C10"'},
                'majorDimension': {
                    'type': 'string',
                    'enum': list(_MAJOR_DIMENSIONS),
                    'description': 'Whether values are returned by ROWS (default) or COLUMNS',
                },
                'valueRenderOption': {
                    'type': 'string',
                    'enum': list(_VALUE_RENDER_OPTIONS),
                    'description': 'How values are rendered: FORMATTED_VALUE (default), UNFORMATTED_VALUE, or FORMULA',
                },
            },
        },
        description=(
            'Read the cell values in a single A1 range. Returns {range, majorDimension, values} where '
            'values is a 2-D array of rows. Use for reading a known range from a spreadsheet.'
        ),
    )
    def values_get(self, args: dict) -> dict:
        """Read the cell values in a single A1 range. Read-only."""
        args = normalize_tool_input(args, tool_name='tool_sheets')
        sid = require_str(args, 'spreadsheetId', tool_name='values_get')
        rng = require_str(args, 'range', tool_name='values_get')
        params = {'spreadsheetId': sid, 'range': rng}
        major = self._enum_arg(args, 'majorDimension', _MAJOR_DIMENSIONS, None)
        if major:
            params['majorDimension'] = major
        render = self._enum_arg(args, 'valueRenderOption', _VALUE_RENDER_OPTIONS, None)
        if render:
            params['valueRenderOption'] = render
        data = execute(self._svc().spreadsheets().values().get(**params))
        return clean_value_range(data)

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['spreadsheetId', 'ranges'],
            'properties': {
                'spreadsheetId': {'type': 'string', 'description': 'The spreadsheet id'},
                'ranges': {
                    'type': 'array',
                    'items': {'type': 'string'},
                    'description': 'A1 notation ranges to read in one call',
                },
                'majorDimension': {
                    'type': 'string',
                    'enum': list(_MAJOR_DIMENSIONS),
                    'description': 'ROWS (default) or COLUMNS',
                },
                'valueRenderOption': {
                    'type': 'string',
                    'enum': list(_VALUE_RENDER_OPTIONS),
                    'description': 'Value render option',
                },
            },
        },
        description='Read cell values from multiple A1 ranges in one call. Returns a list of {range, values}.',
    )
    def values_batch_get(self, args: dict) -> dict:
        """Read cell values from multiple A1 ranges in one call. Read-only."""
        args = normalize_tool_input(args, tool_name='tool_sheets')
        sid = require_str(args, 'spreadsheetId', tool_name='values_batch_get')
        ranges = require_str_list(args, 'ranges', tool_name='values_batch_get')
        params = {'spreadsheetId': sid, 'ranges': ranges}
        major = self._enum_arg(args, 'majorDimension', _MAJOR_DIMENSIONS, None)
        if major:
            params['majorDimension'] = major
        render = self._enum_arg(args, 'valueRenderOption', _VALUE_RENDER_OPTIONS, None)
        if render:
            params['valueRenderOption'] = render
        data = execute(self._svc().spreadsheets().values().batchGet(**params))
        return {
            'spreadsheetId': data.get('spreadsheetId'),
            'valueRanges': [clean_value_range(vr) for vr in data.get('valueRanges') or []],
        }

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['spreadsheetId'],
            'properties': {
                'spreadsheetId': {'type': 'string', 'description': 'The spreadsheet id'},
            },
        },
        description=(
            'Get spreadsheet metadata: id, title, locale, timezone, and the properties of every sheet '
            '(sheetId, title, index, grid size). Use to discover sheet ids and titles before reading or '
            'writing. For cell values use values_get / values_batch_get.'
        ),
    )
    def spreadsheet_get(self, args: dict) -> dict:
        """Get spreadsheet metadata and per-sheet properties. Read-only."""
        args = normalize_tool_input(args, tool_name='tool_sheets')
        sid = require_str(args, 'spreadsheetId', tool_name='spreadsheet_get')
        data = execute(self._svc().spreadsheets().get(spreadsheetId=sid))
        return clean_spreadsheet(data)

    # =======================================================================
    # VALUES — write
    # =======================================================================

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['spreadsheetId', 'range', 'values'],
            'properties': {
                'spreadsheetId': {'type': 'string', 'description': 'The spreadsheet id'},
                'range': {'type': 'string', 'description': 'A1 range to write, e.g. "Sheet1!A1"'},
                'values': {'type': 'array', 'items': {'type': 'array'}, 'description': '2-D array of rows to write'},
                'valueInputOption': {
                    'type': 'string',
                    'enum': list(_VALUE_INPUT_OPTIONS),
                    'description': 'USER_ENTERED (default: parses formulas/numbers) or RAW (store literally)',
                },
            },
        },
        description=(
            'Write a 2-D array of values into an A1 range, overwriting existing cells there. '
            'Returns updated-cell counts. Requires the write tier.'
        ),
    )
    def values_update(self, args: dict) -> dict:
        """Write values to an A1 range (overwrites). Requires the write tier."""
        args = normalize_tool_input(args, tool_name='tool_sheets')
        self._access().require_write('values_update')
        sid = require_str(args, 'spreadsheetId', tool_name='values_update')
        rng = require_str(args, 'range', tool_name='values_update')
        values = self._values_arg(args, 'values', 'values_update')
        vio = self._enum_arg(args, 'valueInputOption', _VALUE_INPUT_OPTIONS, _DEFAULT_VALUE_INPUT)
        data = execute(
            self._svc()
            .spreadsheets()
            .values()
            .update(spreadsheetId=sid, range=rng, valueInputOption=vio, body={'values': values})
        )
        return clean_update_result(data)

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['spreadsheetId', 'data'],
            'properties': {
                'spreadsheetId': {'type': 'string', 'description': 'The spreadsheet id'},
                'data': {
                    'type': 'array',
                    'items': {
                        'type': 'object',
                        'required': ['range', 'values'],
                        'properties': {
                            'range': {'type': 'string', 'description': 'A1 range'},
                            'values': {'type': 'array', 'items': {'type': 'array'}, 'description': '2-D rows'},
                        },
                    },
                    'description': 'List of {range, values} to write in one call',
                },
                'valueInputOption': {
                    'type': 'string',
                    'enum': list(_VALUE_INPUT_OPTIONS),
                    'description': 'USER_ENTERED (default) or RAW',
                },
            },
        },
        description='Write values to multiple A1 ranges in one call. Returns per-range and total update counts. Requires the write tier.',
    )
    def values_batch_update(self, args: dict) -> dict:
        """Write values to multiple A1 ranges in one call. Requires the write tier."""
        args = normalize_tool_input(args, tool_name='tool_sheets')
        self._access().require_write('values_batch_update')
        sid = require_str(args, 'spreadsheetId', tool_name='values_batch_update')
        data_arg = args.get('data')
        if not isinstance(data_arg, list) or not data_arg:
            raise ValueError('values_batch_update: "data" must be a non-empty list of {range, values}')
        for entry in data_arg:
            if not isinstance(entry, dict) or 'range' not in entry or 'values' not in entry:
                raise ValueError('values_batch_update: each data entry needs "range" and "values"')
            self._values_arg(entry, 'values', 'values_batch_update')
        vio = self._enum_arg(args, 'valueInputOption', _VALUE_INPUT_OPTIONS, _DEFAULT_VALUE_INPUT)
        body = {'valueInputOption': vio, 'data': data_arg}
        result = execute(self._svc().spreadsheets().values().batchUpdate(spreadsheetId=sid, body=body))
        return clean_batch_update_values_result(result)

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['spreadsheetId', 'range', 'values'],
            'properties': {
                'spreadsheetId': {'type': 'string', 'description': 'The spreadsheet id'},
                'range': {'type': 'string', 'description': 'A1 range whose table to append after (e.g. "Sheet1!A1")'},
                'values': {'type': 'array', 'items': {'type': 'array'}, 'description': '2-D array of rows to append'},
                'valueInputOption': {
                    'type': 'string',
                    'enum': list(_VALUE_INPUT_OPTIONS),
                    'description': 'USER_ENTERED (default) or RAW',
                },
                'insertDataOption': {
                    'type': 'string',
                    'enum': ['INSERT_ROWS', 'OVERWRITE'],
                    'description': 'INSERT_ROWS (default) to shift existing rows down, or OVERWRITE',
                },
            },
        },
        description='Append rows after the existing table at a range. Returns the updated range and counts. Requires the write tier.',
    )
    def values_append(self, args: dict) -> dict:
        """Append rows after a table's data. Requires the write tier."""
        args = normalize_tool_input(args, tool_name='tool_sheets')
        self._access().require_write('values_append')
        sid = require_str(args, 'spreadsheetId', tool_name='values_append')
        rng = require_str(args, 'range', tool_name='values_append')
        values = self._values_arg(args, 'values', 'values_append')
        vio = self._enum_arg(args, 'valueInputOption', _VALUE_INPUT_OPTIONS, _DEFAULT_VALUE_INPUT)
        # Always send insertDataOption: the API's implicit default is OVERWRITE,
        # which can silently clobber rows below the table.
        ido = self._enum_arg(args, 'insertDataOption', ('INSERT_ROWS', 'OVERWRITE'), 'INSERT_ROWS')
        params = {
            'spreadsheetId': sid,
            'range': rng,
            'valueInputOption': vio,
            'insertDataOption': ido,
            'body': {'values': values},
        }
        data = execute(self._svc().spreadsheets().values().append(**params))
        return clean_append_result(data)

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['spreadsheetId', 'range'],
            'properties': {
                'spreadsheetId': {'type': 'string', 'description': 'The spreadsheet id'},
                'range': {'type': 'string', 'description': 'A1 range to clear (values only; formatting is preserved)'},
            },
        },
        description=(
            'Clear the values in an A1 range (formatting preserved). NOT undoable via the API — cleared '
            "values can only be restored from the spreadsheet's version history. Requires the write tier."
        ),
    )
    def values_clear(self, args: dict) -> dict:
        """Clear the values in an A1 range (formatting preserved). Requires the write tier."""
        args = normalize_tool_input(args, tool_name='tool_sheets')
        self._access().require_write('values_clear')
        sid = require_str(args, 'spreadsheetId', tool_name='values_clear')
        rng = require_str(args, 'range', tool_name='values_clear')
        data = execute(self._svc().spreadsheets().values().clear(spreadsheetId=sid, range=rng, body={}))
        return clean_clear_result(data)

    # =======================================================================
    # SPREADSHEET / SHEET — structure (write)
    # =======================================================================

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['title'],
            'properties': {
                'title': {'type': 'string', 'description': 'Title for the new spreadsheet'},
                'sheetTitles': {
                    'type': 'array',
                    'items': {'type': 'string'},
                    'description': 'Optional titles for the initial tabs (default a single "Sheet1")',
                },
            },
        },
        description='Create a new spreadsheet. Returns its spreadsheetId, title, url, and sheet properties. Requires the write tier.',
    )
    def spreadsheet_create(self, args: dict) -> dict:
        """Create a new spreadsheet. Requires the write tier."""
        args = normalize_tool_input(args, tool_name='tool_sheets')
        self._access().require_write('spreadsheet_create')
        title = require_str(args, 'title', tool_name='spreadsheet_create')
        body: dict = {'properties': {'title': title}}
        if args.get('sheetTitles') is not None:
            titles = require_str_list(args, 'sheetTitles', tool_name='spreadsheet_create')
            body['sheets'] = [{'properties': {'title': t}} for t in titles]
        data = execute(self._svc().spreadsheets().create(body=body))
        return clean_spreadsheet(data)

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['spreadsheetId', 'title'],
            'properties': {
                'spreadsheetId': {'type': 'string', 'description': 'The spreadsheet id'},
                'title': {'type': 'string', 'description': 'Title for the new sheet (tab)'},
                'rowCount': {'type': 'integer', 'description': 'Initial row count (optional)'},
                'columnCount': {'type': 'integer', 'description': 'Initial column count (optional)'},
            },
        },
        description='Add a new sheet (tab) to a spreadsheet. Returns the new sheet properties. Requires the write tier.',
    )
    def sheet_add(self, args: dict) -> dict:
        """Add a new sheet (tab) to a spreadsheet. Requires the write tier."""
        args = normalize_tool_input(args, tool_name='tool_sheets')
        self._access().require_write('sheet_add')
        sid = require_str(args, 'spreadsheetId', tool_name='sheet_add')
        title = require_str(args, 'title', tool_name='sheet_add')
        props: dict = {'title': title}
        grid: dict = {}
        rows = optional_int(args, 'rowCount', tool_name='sheet_add')
        cols = optional_int(args, 'columnCount', tool_name='sheet_add')
        if rows is not None:
            grid['rowCount'] = rows
        if cols is not None:
            grid['columnCount'] = cols
        if grid:
            props['gridProperties'] = grid
        body = {'requests': [{'addSheet': {'properties': props}}]}
        data = execute(self._svc().spreadsheets().batchUpdate(spreadsheetId=sid, body=body))
        added = ((data.get('replies') or [{}])[0] or {}).get('addSheet', {}).get('properties')
        return clean_sheet_props(added) if added else clean_batch_update_result(data)

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['spreadsheetId', 'sheetId'],
            'properties': {
                'spreadsheetId': {'type': 'string', 'description': 'The spreadsheet id'},
                'sheetId': {
                    'type': 'integer',
                    'description': 'Numeric sheetId of the tab to delete (from spreadsheet_get)',
                },
            },
        },
        description=(
            'Delete a sheet (tab) by its numeric sheetId. NOT undoable via the API — a deleted tab can only '
            "be restored from the spreadsheet's version history. Requires the write tier."
        ),
    )
    def sheet_delete(self, args: dict) -> dict:
        """Delete a sheet (tab) by numeric sheetId. Requires the write tier."""
        args = normalize_tool_input(args, tool_name='tool_sheets')
        self._access().require_write('sheet_delete')
        sid = require_str(args, 'spreadsheetId', tool_name='sheet_delete')
        sheet_id = require_int(args, 'sheetId', tool_name='sheet_delete')
        body = {'requests': [{'deleteSheet': {'sheetId': sheet_id}}]}
        execute(self._svc().spreadsheets().batchUpdate(spreadsheetId=sid, body=body))
        return {'deletedSheetId': sheet_id}

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['spreadsheetId', 'sheetId'],
            'properties': {
                'spreadsheetId': {'type': 'string', 'description': 'The spreadsheet id'},
                'sheetId': {'type': 'integer', 'description': 'Numeric sheetId of the tab to duplicate'},
                'newName': {'type': 'string', 'description': 'Name for the duplicate (optional)'},
                'insertSheetIndex': {
                    'type': 'integer',
                    'description': 'Zero-based index to insert the duplicate at (optional)',
                },
            },
        },
        description='Duplicate a sheet (tab) within the same spreadsheet. Returns the new sheet properties. Requires the write tier.',
    )
    def sheet_duplicate(self, args: dict) -> dict:
        """Duplicate a sheet (tab) within the same spreadsheet. Requires the write tier."""
        args = normalize_tool_input(args, tool_name='tool_sheets')
        self._access().require_write('sheet_duplicate')
        sid = require_str(args, 'spreadsheetId', tool_name='sheet_duplicate')
        sheet_id = require_int(args, 'sheetId', tool_name='sheet_duplicate')
        req: dict = {'sourceSheetId': sheet_id}
        new_name = args.get('newName')
        if new_name is not None:
            if not isinstance(new_name, str) or not new_name.strip():
                raise ValueError('sheet_duplicate: "newName" must be a non-empty string')
            req['newSheetName'] = new_name
        idx = optional_int(args, 'insertSheetIndex', tool_name='sheet_duplicate')
        if idx is not None:
            req['insertSheetIndex'] = idx
        body = {'requests': [{'duplicateSheet': req}]}
        data = execute(self._svc().spreadsheets().batchUpdate(spreadsheetId=sid, body=body))
        props = ((data.get('replies') or [{}])[0] or {}).get('duplicateSheet', {}).get('properties')
        return clean_sheet_props(props) if props else clean_batch_update_result(data)

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['spreadsheetId', 'sheetId', 'destinationSpreadsheetId'],
            'properties': {
                'spreadsheetId': {'type': 'string', 'description': 'Source spreadsheet id'},
                'sheetId': {'type': 'integer', 'description': 'Numeric sheetId of the source tab'},
                'destinationSpreadsheetId': {'type': 'string', 'description': 'Spreadsheet id to copy the tab into'},
            },
        },
        description=(
            'Copy a single sheet (tab) into ANOTHER spreadsheet (the separate copyTo endpoint, not batch_update). '
            'Returns the copied sheet properties in the destination. Requires the write tier.'
        ),
    )
    def sheet_copy_to(self, args: dict) -> dict:
        """Copy a sheet (tab) into another spreadsheet. Requires the write tier."""
        args = normalize_tool_input(args, tool_name='tool_sheets')
        self._access().require_write('sheet_copy_to')
        sid = require_str(args, 'spreadsheetId', tool_name='sheet_copy_to')
        sheet_id = require_int(args, 'sheetId', tool_name='sheet_copy_to')
        dest = require_str(args, 'destinationSpreadsheetId', tool_name='sheet_copy_to')
        data = execute(
            self._svc()
            .spreadsheets()
            .sheets()
            .copyTo(spreadsheetId=sid, sheetId=sheet_id, body={'destinationSpreadsheetId': dest})
        )
        return clean_sheet_props(data)

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['spreadsheetId', 'requests'],
            'properties': {
                'spreadsheetId': {'type': 'string', 'description': 'The spreadsheet id'},
                'requests': {
                    'type': 'array',
                    'items': {'type': 'object'},
                    'description': 'List of Sheets API batchUpdate request objects',
                },
                'includeSpreadsheetInResponse': {
                    'type': 'boolean',
                    'description': 'Return the updated spreadsheet in the reply (optional)',
                },
            },
        },
        description=(
            'The catch-all write endpoint: apply a list of Sheets batchUpdate requests. Use this for '
            'formatting, charts, conditional formatting, protected ranges, merges, and any structural '
            'change not covered by a dedicated function. Pass the full requests list (e.g. '
            '[{"repeatCell": {...}}, {"addConditionalFormatRule": {...}}]). Returns the API replies. '
            'Requires the write tier.'
        ),
    )
    def batch_update(self, args: dict) -> dict:
        """Apply a list of Sheets batchUpdate requests (formatting/charts/structure). Requires the write tier."""
        args = normalize_tool_input(args, tool_name='tool_sheets')
        self._access().require_write('batch_update')
        sid = require_str(args, 'spreadsheetId', tool_name='batch_update')
        requests = args.get('requests')
        if not isinstance(requests, list) or not requests:
            raise ValueError('batch_update: "requests" must be a non-empty list of Sheets batchUpdate request objects')
        if not all(isinstance(r, dict) for r in requests):
            raise ValueError('batch_update: each request must be an object')
        body: dict = {'requests': requests}
        if isinstance(args.get('includeSpreadsheetInResponse'), bool):
            body['includeSpreadsheetInResponse'] = args['includeSpreadsheetInResponse']
        data = execute(self._svc().spreadsheets().batchUpdate(spreadsheetId=sid, body=body))
        return clean_batch_update_result(data)
