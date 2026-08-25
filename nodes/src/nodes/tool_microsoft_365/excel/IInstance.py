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
Excel tool node instance.

Exposes the Microsoft Graph workbook API as agent tools: list worksheets and
tables, read/write/clear ranges, add worksheets/tables/table rows/charts,
recalculate, and create workbooks. Write operations require the ``write``
tier. Operates sessionless — no persisted workbook session is opened or
closed per call (Graph fully supports this; batches of edits simply cost one
extra round trip per call versus a session).

Operational targets (file path/id, sheet, range, table) are always
invoke-time parameters — never node config.
"""

from __future__ import annotations

import urllib.parse

from rocketlib import tool_function

from ai.common.utils import normalize_tool_input, optional_bool, require_str

from .. import graph_client
from ..IInstance import MicrosoftToolInstanceBase
from .client import EMPTY_XLSX, SERVICE, clean_range, clean_table, clean_worksheet, request, wb
from .IGlobal import IGlobal


def _seg(value: str) -> str:
    """URL-encode a path segment (worksheet/table names may contain spaces, etc.)."""
    return urllib.parse.quote(value, safe='')


class IInstance(MicrosoftToolInstanceBase):
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

    def _base(self) -> str:
        return graph_client.user_base(self.IGlobal.cfg)

    def _wb(self, file: str) -> str:
        return wb(self._base(), file)

    # =======================================================================
    # DIAGNOSTICS
    # =======================================================================

    @tool_function(
        description=(
            'Check the Excel/Graph connection and verify that the granted OAuth scopes cover the '
            "node's configured access tier. Call this when an Excel operation fails with a scope or "
            'permission error. Returns connection_ok: true when the required scopes are present.'
        ),
        input_schema={'type': 'object', 'properties': {}, 'required': []},
    )
    def excel_check_connection(self, args: dict) -> dict:
        """Check the Excel connection and whether granted OAuth scopes cover the access tier. Read-only."""
        base = self._base()

        def _probe(auth):
            request(auth, 'GET', f'{base}/drive')

        return self._check_connection_impl(probe=_probe)

    # =======================================================================
    # WORKSHEETS — read
    # =======================================================================

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['file'],
            'properties': {
                'file': {
                    'type': 'string',
                    'description': "Path in the acting user's OneDrive (e.g. 'Reports/q3.xlsx') or a drive item id",
                },
            },
        },
        description='List the worksheets (tabs) in a workbook. Returns each worksheet id, name, position, and visibility.',
    )
    def excel_list_worksheets(self, args: dict) -> dict:
        """List the worksheets (tabs) in a workbook. Read-only."""
        args = normalize_tool_input(args, tool_name='tool_excel')
        file = require_str(args, 'file', tool_name='excel_list_worksheets')
        data = request(self.IGlobal.auth, 'GET', f'{self._wb(file)}/worksheets')
        return {'worksheets': [clean_worksheet(w) for w in data.get('value') or []]}

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['file', 'sheet', 'range'],
            'properties': {
                'file': {
                    'type': 'string',
                    'description': "Path in the acting user's OneDrive or a drive item id",
                },
                'sheet': {'type': 'string', 'description': 'Worksheet name or id'},
                'range': {'type': 'string', 'description': "A1 notation range, e.g. 'A1:C10'"},
            },
        },
        description=(
            'Read the cell values and formulas in a single A1 range of one worksheet. Returns '
            '{address, values, formulas, rowCount, columnCount}. Use for reading a known range.'
        ),
    )
    def excel_read_range(self, args: dict) -> dict:
        """Read the cell values in a single A1 range. Read-only."""
        args = normalize_tool_input(args, tool_name='tool_excel')
        file = require_str(args, 'file', tool_name='excel_read_range')
        sheet = require_str(args, 'sheet', tool_name='excel_read_range')
        rng = require_str(args, 'range', tool_name='excel_read_range')
        path = f"{self._wb(file)}/worksheets/{_seg(sheet)}/range(address='{_seg(rng)}')"
        data = request(self.IGlobal.auth, 'GET', path)
        return clean_range(data)

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['file', 'sheet'],
            'properties': {
                'file': {
                    'type': 'string',
                    'description': "Path in the acting user's OneDrive or a drive item id",
                },
                'sheet': {'type': 'string', 'description': 'Worksheet name or id'},
            },
        },
        description=(
            'Read the used range of a worksheet — the smallest range containing any data or formatting. '
            'Returns {address, values, formulas, rowCount, columnCount}. Use to discover the populated '
            'area of a worksheet without knowing its bounds ahead of time.'
        ),
    )
    def excel_read_used_range(self, args: dict) -> dict:
        """Read a worksheet's used range (the populated area). Read-only."""
        args = normalize_tool_input(args, tool_name='tool_excel')
        file = require_str(args, 'file', tool_name='excel_read_used_range')
        sheet = require_str(args, 'sheet', tool_name='excel_read_used_range')
        path = f'{self._wb(file)}/worksheets/{_seg(sheet)}/usedRange'
        data = request(self.IGlobal.auth, 'GET', path)
        return clean_range(data)

    # =======================================================================
    # RANGES — write
    # =======================================================================

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['file', 'sheet', 'range', 'values'],
            'properties': {
                'file': {
                    'type': 'string',
                    'description': "Path in the acting user's OneDrive or a drive item id",
                },
                'sheet': {'type': 'string', 'description': 'Worksheet name or id'},
                'range': {'type': 'string', 'description': "A1 range to write, e.g. 'A1:B2'"},
                'values': {
                    'type': 'array',
                    'items': {'type': 'array'},
                    'description': '2-D array of rows to write into the range',
                },
            },
        },
        description=(
            'Write a 2-D array of values into an A1 range, overwriting existing cells there. '
            'Returns the updated range. Requires the write tier.'
        ),
    )
    def excel_update_range(self, args: dict) -> dict:
        """Write values into an A1 range (overwrites). Requires the write tier."""
        args = normalize_tool_input(args, tool_name='tool_excel')
        self.IGlobal.access.require_write('excel_update_range')
        file = require_str(args, 'file', tool_name='excel_update_range')
        sheet = require_str(args, 'sheet', tool_name='excel_update_range')
        rng = require_str(args, 'range', tool_name='excel_update_range')
        values = self._values_arg(args, 'values', 'excel_update_range')
        path = f"{self._wb(file)}/worksheets/{_seg(sheet)}/range(address='{_seg(rng)}')"
        data = request(self.IGlobal.auth, 'PATCH', path, json_body={'values': values})
        return clean_range(data)

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['file', 'sheet', 'range'],
            'properties': {
                'file': {
                    'type': 'string',
                    'description': "Path in the acting user's OneDrive or a drive item id",
                },
                'sheet': {'type': 'string', 'description': 'Worksheet name or id'},
                'range': {'type': 'string', 'description': 'A1 range to clear (contents only)'},
            },
        },
        description='Clear the contents of an A1 range (formatting preserved). Requires the write tier.',
    )
    def excel_clear_range(self, args: dict) -> dict:
        """Clear the contents of an A1 range. Requires the write tier."""
        args = normalize_tool_input(args, tool_name='tool_excel')
        self.IGlobal.access.require_write('excel_clear_range')
        file = require_str(args, 'file', tool_name='excel_clear_range')
        sheet = require_str(args, 'sheet', tool_name='excel_clear_range')
        rng = require_str(args, 'range', tool_name='excel_clear_range')
        path = f"{self._wb(file)}/worksheets/{_seg(sheet)}/range(address='{_seg(rng)}')/clear"
        request(self.IGlobal.auth, 'POST', path, json_body={'applyTo': 'Contents'})
        return {'cleared': rng}

    # =======================================================================
    # WORKSHEETS — write
    # =======================================================================

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['file', 'name'],
            'properties': {
                'file': {
                    'type': 'string',
                    'description': "Path in the acting user's OneDrive or a drive item id",
                },
                'name': {'type': 'string', 'description': 'Name for the new worksheet'},
            },
        },
        description='Add a new worksheet (tab) to a workbook. Returns the new worksheet properties. Requires the write tier.',
    )
    def excel_add_worksheet(self, args: dict) -> dict:
        """Add a new worksheet (tab) to a workbook. Requires the write tier."""
        args = normalize_tool_input(args, tool_name='tool_excel')
        self.IGlobal.access.require_write('excel_add_worksheet')
        file = require_str(args, 'file', tool_name='excel_add_worksheet')
        name = require_str(args, 'name', tool_name='excel_add_worksheet')
        data = request(self.IGlobal.auth, 'POST', f'{self._wb(file)}/worksheets/add', json_body={'name': name})
        return clean_worksheet(data)

    # =======================================================================
    # TABLES — read
    # =======================================================================

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['file'],
            'properties': {
                'file': {
                    'type': 'string',
                    'description': "Path in the acting user's OneDrive or a drive item id",
                },
            },
        },
        description='List the tables in a workbook. Returns each table id, name, and header/totals visibility.',
    )
    def excel_list_tables(self, args: dict) -> dict:
        """List the tables in a workbook. Read-only."""
        args = normalize_tool_input(args, tool_name='tool_excel')
        file = require_str(args, 'file', tool_name='excel_list_tables')
        data = request(self.IGlobal.auth, 'GET', f'{self._wb(file)}/tables')
        return {'tables': [clean_table(t) for t in data.get('value') or []]}

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['file', 'table'],
            'properties': {
                'file': {
                    'type': 'string',
                    'description': "Path in the acting user's OneDrive or a drive item id",
                },
                'table': {'type': 'string', 'description': 'Table name or id (from excel_list_tables)'},
            },
        },
        description='Read every row of a table. Returns {rows} as a list of row value-arrays (no header row).',
    )
    def excel_read_table(self, args: dict) -> dict:
        """Read every row of a table. Read-only."""
        args = normalize_tool_input(args, tool_name='tool_excel')
        file = require_str(args, 'file', tool_name='excel_read_table')
        table = require_str(args, 'table', tool_name='excel_read_table')
        rows: list = []
        # Graph may page large tables; follow @odata.nextLink so "every row"
        # holds. Each workbookTableRow.values is a one-row 2-D array
        # ([[a, b, c]]); unwrap it to the documented per-row value-array.
        path = f'{self._wb(file)}/tables/{_seg(table)}/rows'
        while path:
            data = request(self.IGlobal.auth, 'GET', path)
            for row in data.get('value') or []:
                values = row.get('values')
                rows.append(values[0] if isinstance(values, list) and len(values) == 1 else values)
            path = data.get('@odata.nextLink')
        return {'rows': rows}

    # =======================================================================
    # TABLES — write
    # =======================================================================

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['file', 'sheet', 'range'],
            'properties': {
                'file': {
                    'type': 'string',
                    'description': "Path in the acting user's OneDrive or a drive item id",
                },
                'sheet': {'type': 'string', 'description': 'Worksheet name or id'},
                'range': {'type': 'string', 'description': 'A1 range covering the new table, including headers'},
                'has_headers': {
                    'type': 'boolean',
                    'description': 'Whether the first row of the range is a header row (default true)',
                },
            },
        },
        description='Create a table over an A1 range on a worksheet. Returns the new table properties. Requires the write tier.',
    )
    def excel_add_table(self, args: dict) -> dict:
        """Create a table over an A1 range. Requires the write tier."""
        args = normalize_tool_input(args, tool_name='tool_excel')
        self.IGlobal.access.require_write('excel_add_table')
        file = require_str(args, 'file', tool_name='excel_add_table')
        sheet = require_str(args, 'sheet', tool_name='excel_add_table')
        rng = require_str(args, 'range', tool_name='excel_add_table')
        has_headers = optional_bool(args, 'has_headers', default=True, tool_name='excel_add_table')
        path = f'{self._wb(file)}/worksheets/{_seg(sheet)}/tables/add'
        data = request(self.IGlobal.auth, 'POST', path, json_body={'address': rng, 'hasHeaders': has_headers})
        return clean_table(data)

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['file', 'table', 'rows'],
            'properties': {
                'file': {
                    'type': 'string',
                    'description': "Path in the acting user's OneDrive or a drive item id",
                },
                'table': {'type': 'string', 'description': 'Table name or id'},
                'rows': {
                    'type': 'array',
                    'items': {'type': 'array'},
                    'description': '2-D array of rows to append to the table',
                },
            },
        },
        description='Append rows to the end of a table. Returns {added: <row count>}. Requires the write tier.',
    )
    def excel_add_table_rows(self, args: dict) -> dict:
        """Append rows to the end of a table. Requires the write tier."""
        args = normalize_tool_input(args, tool_name='tool_excel')
        self.IGlobal.access.require_write('excel_add_table_rows')
        file = require_str(args, 'file', tool_name='excel_add_table_rows')
        table = require_str(args, 'table', tool_name='excel_add_table_rows')
        rows = self._values_arg(args, 'rows', 'excel_add_table_rows')
        path = f'{self._wb(file)}/tables/{_seg(table)}/rows'
        request(self.IGlobal.auth, 'POST', path, json_body={'values': rows})
        return {'added': len(rows)}

    # =======================================================================
    # CHARTS — write
    # =======================================================================

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['file', 'sheet', 'chart_type', 'source_range'],
            'properties': {
                'file': {
                    'type': 'string',
                    'description': "Path in the acting user's OneDrive or a drive item id",
                },
                'sheet': {'type': 'string', 'description': 'Worksheet name or id'},
                'chart_type': {
                    'type': 'string',
                    'description': "Graph chart type, e.g. 'ColumnClustered', 'Line', 'Pie', 'BarClustered'",
                },
                'source_range': {'type': 'string', 'description': 'A1 range the chart plots data from'},
            },
        },
        description='Add a chart to a worksheet, plotting a source A1 range. Returns the new chart id and name. Requires the write tier.',
    )
    def excel_add_chart(self, args: dict) -> dict:
        """Add a chart to a worksheet. Requires the write tier."""
        args = normalize_tool_input(args, tool_name='tool_excel')
        self.IGlobal.access.require_write('excel_add_chart')
        file = require_str(args, 'file', tool_name='excel_add_chart')
        sheet = require_str(args, 'sheet', tool_name='excel_add_chart')
        chart_type = require_str(args, 'chart_type', tool_name='excel_add_chart')
        source_range = require_str(args, 'source_range', tool_name='excel_add_chart')
        path = f'{self._wb(file)}/worksheets/{_seg(sheet)}/charts/add'
        data = request(
            self.IGlobal.auth,
            'POST',
            path,
            json_body={'type': chart_type, 'sourceData': source_range, 'seriesBy': 'Auto'},
        )
        return {'id': data.get('id'), 'name': data.get('name')}

    # =======================================================================
    # WORKBOOK — write
    # =======================================================================

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['file'],
            'properties': {
                'file': {
                    'type': 'string',
                    'description': "Path in the acting user's OneDrive or a drive item id",
                },
            },
        },
        description=(
            'Recalculate every formula in a workbook (a Full recalculation). Use after writing values that '
            'formulas depend on and the caller needs up-to-date computed results. Requires the write tier.'
        ),
    )
    def excel_calculate(self, args: dict) -> dict:
        """Recalculate every formula in a workbook. Requires the write tier."""
        args = normalize_tool_input(args, tool_name='tool_excel')
        self.IGlobal.access.require_write('excel_calculate')
        file = require_str(args, 'file', tool_name='excel_calculate')
        request(
            self.IGlobal.auth, 'POST', f'{self._wb(file)}/application/calculate', json_body={'calculationType': 'Full'}
        )
        return {'calculated': True}

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['path'],
            'properties': {
                'path': {
                    'type': 'string',
                    'description': "Destination path in the acting user's OneDrive, e.g. 'Reports/new.xlsx'",
                },
            },
        },
        description=(
            'Create a new, empty .xlsx workbook (a single blank "Sheet1") at a OneDrive path, overwriting '
            'any existing file there. Returns the new file id, name, and webUrl. Requires the write tier.'
        ),
    )
    def excel_create_workbook(self, args: dict) -> dict:
        """Create a new empty workbook at a OneDrive path. Requires the write tier."""
        args = normalize_tool_input(args, tool_name='tool_excel')
        self.IGlobal.access.require_write('excel_create_workbook')
        path_arg = require_str(args, 'path', tool_name='excel_create_workbook')
        upload_path = f'{self._base()}/drive/root:/{urllib.parse.quote(path_arg, safe=chr(47))}:/content'
        data = request(
            self.IGlobal.auth,
            'PUT',
            upload_path,
            data=EMPTY_XLSX,
            content_type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        )
        return {'id': data.get('id'), 'name': data.get('name'), 'webUrl': data.get('webUrl')}
