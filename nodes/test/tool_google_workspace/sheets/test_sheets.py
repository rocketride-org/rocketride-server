# =============================================================================
# RocketRide Engine
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Unit tests for the tool_sheets node (no network, no engine runtime).

Bootstrap mirrors test_gmail.py: inject lightweight stubs for the engine runtime
modules ONLY if absent, import the module under test, then drop the stubs so
they never leak into a shared pytest session. The Google SDK is never imported —
IInstance receives a FakeSheets service and a real GoogleAccess.
"""

from __future__ import annotations

import importlib
import json
import sys
import types
from pathlib import Path
from unittest.mock import MagicMock

import pytest

_NODES_SRC = Path(__file__).resolve().parents[3] / 'src'
if str(_NODES_SRC) not in sys.path:
    sys.path.insert(0, str(_NODES_SRC))

_SERVICES_JSON = _NODES_SRC / 'nodes' / 'tool_google_workspace' / 'services.sheets.json'


def _require_str(args, key, *, tool_name=''):
    value = args.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f'{tool_name or key}: "{key}" is required')
    return value.strip()


def _build_import_stubs():
    rocketlib = MagicMock()
    rocketlib.IInstanceBase = object
    rocketlib.IGlobalBase = object
    rocketlib.tool_function = lambda **kwargs: lambda f: f
    rocketlib.OPEN_MODE = MagicMock()
    rocketlib.warning = lambda *a, **kw: None

    depends = MagicMock()
    depends.depends = lambda *a, **kw: None

    ai_common_utils = MagicMock()
    ai_common_utils.normalize_tool_input = lambda args, **kw: args if isinstance(args, dict) else {}
    ai_common_utils.require_str = _require_str

    def _stub_require_str_list(args, key, *, tool_name=''):
        prefix = f'{tool_name}: ' if tool_name else ''
        value = args.get(key)
        if not isinstance(value, list) or not value:
            raise ValueError(f'{prefix}"{key}" must be a non-empty list')
        if not all(isinstance(i, str) and i.strip() for i in value):
            raise ValueError(f'{prefix}"{key}" must contain only non-empty strings')
        return value

    def _stub_optional_str_list(args, key, *, default=None, tool_name=''):
        if key not in args or args[key] is None:
            return default
        return _stub_require_str_list(args, key, tool_name=tool_name)

    ai_common_utils.require_str_list = _stub_require_str_list
    ai_common_utils.optional_str_list = _stub_optional_str_list

    def _stub_require_int(args, key, *, lo=None, hi=None, tool_name=''):
        prefix = f'{tool_name}: ' if tool_name else ''
        val = args.get(key)
        if val is None:
            raise ValueError(f'{prefix}"{key}" is required')
        if isinstance(val, (bool, float)) or not isinstance(val, (int, str)):
            raise ValueError(f'{prefix}"{key}" must be an integer')
        try:
            out = int(val)
        except (TypeError, ValueError, OverflowError):
            raise ValueError(f'{prefix}"{key}" must be an integer')
        if (lo is not None and out < lo) or (hi is not None and out > hi):
            raise ValueError(f'{prefix}"{key}" must be an integer')
        return out

    def _stub_optional_int(args, key, *, default=None, lo=None, hi=None, tool_name=''):
        if key not in args or args[key] is None:
            return default
        return _stub_require_int(args, key, lo=lo, hi=hi, tool_name=tool_name)

    def _stub_optional_str(args, key, *, default=None, tool_name=''):
        if key not in args or args[key] is None:
            return default
        val = args[key]
        if not isinstance(val, str):
            prefix = f'{tool_name}: ' if tool_name else ''
            raise ValueError(f'{prefix}"{key}" must be a string')
        return val

    ai_common_utils.require_int = _stub_require_int
    ai_common_utils.optional_int = _stub_optional_int
    ai_common_utils.optional_str = _stub_optional_str

    return {
        'rocketlib': rocketlib,
        'depends': depends,
        'ai': MagicMock(),
        'ai.common': MagicMock(),
        'ai.common.utils': ai_common_utils,
        'ai.common.config': MagicMock(),
    }


_added = []
for _name, _stub in _build_import_stubs().items():
    if _name not in sys.modules:
        sys.modules[_name] = _stub
        _added.append(_name)

sheets_iinstance = importlib.import_module('nodes.tool_google_workspace.sheets.IInstance')
sheets_client = importlib.import_module('nodes.tool_google_workspace.sheets.client')
sheets_iglobal = importlib.import_module('nodes.tool_google_workspace.sheets.IGlobal')
workspace_iinstance = importlib.import_module('nodes.tool_google_workspace.IInstance')
workspace_iglobal = importlib.import_module('nodes.tool_google_workspace.IGlobal')
ga = importlib.import_module('nodes.core.google_access')

for _name in _added:
    sys.modules.pop(_name, None)


# ---------------------------------------------------------------------------
# Fake Sheets service: records terminal calls, returns canned results.
# ---------------------------------------------------------------------------

# Intermediate resource nodes (return another node); everything else is a
# terminal method that records its call and returns a canned result.
_RESOURCES = {'spreadsheets', 'values', 'sheets', 'developerMetadata'}


class _Req:
    def __init__(self, result):
        self.result = result

    def execute(self):
        if isinstance(self.result, Exception):
            raise self.result
        return self.result


class _Node:
    def __init__(self, sv, path):
        self._sv = sv
        self._path = path

    def __getattr__(self, name):
        def method(**kwargs):
            if name in _RESOURCES:
                return _Node(self._sv, f'{self._path}.{name}')
            self._sv.calls.append((name, kwargs))
            return _Req(self._sv.results.get(name, {}))

        return method


class FakeSheets:
    def __init__(self, results=None):
        self.calls = []
        self.results = results or {}

    def spreadsheets(self):
        return _Node(self, 'spreadsheets')

    def call_for(self, op):
        """Return the kwargs of the first recorded call to terminal method ``op``."""
        return next((kw for n, kw in self.calls if n == op), None)


def _make(tier='write', results=None):
    """Build an IInstance wired to a FakeSheets and a real resolved GoogleAccess."""
    inst = sheets_iinstance.IInstance()
    access = ga.resolve_google_access({'access': tier}, ga.SHEETS)
    inst.IGlobal = types.SimpleNamespace(service=FakeSheets(results or {}), access=access)
    return inst


# ---------------------------------------------------------------------------
# Reads
# ---------------------------------------------------------------------------


def test_values_get_reads_range():
    inst = _make(
        results={'get': {'range': 'Sheet1!A1:B2', 'majorDimension': 'ROWS', 'values': [['a', 'b'], ['1', '2']]}}
    )
    out = inst.values_get({'spreadsheetId': 'ss1', 'range': 'Sheet1!A1:B2'})
    assert out == {'range': 'Sheet1!A1:B2', 'majorDimension': 'ROWS', 'values': [['a', 'b'], ['1', '2']]}
    kw = inst.IGlobal.service.call_for('get')
    assert kw['spreadsheetId'] == 'ss1' and kw['range'] == 'Sheet1!A1:B2'
    assert 'majorDimension' not in kw  # optional param omitted when not passed


def test_values_get_passes_optional_enums():
    inst = _make(results={'get': {'values': []}})
    inst.values_get(
        {
            'spreadsheetId': 'ss1',
            'range': 'A1:A2',
            'majorDimension': 'COLUMNS',
            'valueRenderOption': 'UNFORMATTED_VALUE',
        }
    )
    kw = inst.IGlobal.service.call_for('get')
    assert kw['majorDimension'] == 'COLUMNS'
    assert kw['valueRenderOption'] == 'UNFORMATTED_VALUE'


def test_values_get_requires_range():
    inst = _make()
    with pytest.raises(ValueError):
        inst.values_get({'spreadsheetId': 'ss1'})


def test_values_get_rejects_bad_enum():
    inst = _make()
    with pytest.raises(ValueError):
        inst.values_get({'spreadsheetId': 'ss1', 'range': 'A1', 'majorDimension': 'DIAGONAL'})


def test_values_get_missing_values_defaults_empty():
    inst = _make(results={'get': {'range': 'A1'}})
    out = inst.values_get({'spreadsheetId': 'ss1', 'range': 'A1'})
    assert out['values'] == []


def test_values_batch_get():
    inst = _make(
        results={
            'batchGet': {
                'spreadsheetId': 'ss1',
                'valueRanges': [{'range': 'A1:A2', 'values': [['x']]}, {'range': 'B1', 'values': []}],
            }
        }
    )
    out = inst.values_batch_get({'spreadsheetId': 'ss1', 'ranges': ['A1:A2', 'B1']})
    assert out['spreadsheetId'] == 'ss1'
    assert len(out['valueRanges']) == 2
    assert out['valueRanges'][0] == {'range': 'A1:A2', 'majorDimension': None, 'values': [['x']]}
    assert inst.IGlobal.service.call_for('batchGet')['ranges'] == ['A1:A2', 'B1']


def test_values_batch_get_requires_nonempty_ranges():
    inst = _make()
    with pytest.raises(ValueError):
        inst.values_batch_get({'spreadsheetId': 'ss1', 'ranges': []})


def test_spreadsheet_get_cleans_metadata():
    raw = {
        'spreadsheetId': 'ss1',
        'properties': {'title': 'Budget', 'locale': 'en_US', 'timeZone': 'UTC'},
        'spreadsheetUrl': 'https://docs.google.com/spreadsheets/d/ss1',
        'sheets': [
            {
                'properties': {
                    'sheetId': 0,
                    'title': 'Tab1',
                    'index': 0,
                    'sheetType': 'GRID',
                    'gridProperties': {'rowCount': 100, 'columnCount': 26},
                }
            },
        ],
    }
    inst = _make(results={'get': raw})
    out = inst.spreadsheet_get({'spreadsheetId': 'ss1'})
    assert out['spreadsheetId'] == 'ss1'
    assert out['title'] == 'Budget'
    assert out['sheets'][0] == {
        'sheetId': 0,
        'title': 'Tab1',
        'index': 0,
        'sheetType': 'GRID',
        'gridProperties': {'rowCount': 100, 'columnCount': 26},
    }


# ---------------------------------------------------------------------------
# Access tiers
# ---------------------------------------------------------------------------


def test_readonly_tier_allows_reads():
    inst = _make(tier='readonly', results={'get': {'values': [['ok']]}})
    out = inst.values_get({'spreadsheetId': 'ss1', 'range': 'A1'})
    assert out['values'] == [['ok']]
    assert inst.IGlobal.access.can_write is False


def test_default_tier_is_write():
    access = ga.resolve_google_access({}, ga.SHEETS)
    assert access.tier == 'write'
    assert access.can_write is True


# ---------------------------------------------------------------------------
# Diagnostics
# ---------------------------------------------------------------------------


class _HttpErr(Exception):
    def __init__(self, status, reason, content=b''):
        super().__init__(reason)
        self.resp = types.SimpleNamespace(status=status)
        self.reason = reason
        self.content = content


def test_check_connection_reports_ok():
    inst = _make()
    out = inst.check_connection({})
    assert out['connection_ok'] is True
    assert out['access'] == 'write'
    assert any('spreadsheets' in s for s in out['requiredScopes'])
    assert inst.IGlobal.service.call_for('get') is not None


def test_check_connection_probe_swallows_expected_404():
    """A 404 on the probe's made-up spreadsheet id proves the Sheets API IS reachable."""
    inst = _make(results={'get': _HttpErr(404, 'notFound')})
    out = inst.check_connection({})
    assert out['connection_ok'] is True


def test_check_connection_reports_probe_failure():
    """A disabled Sheets API (accessNotConfigured) must flip connection_ok, not be swallowed."""
    err = _HttpErr(403, 'Forbidden', content=b'{"error": {"errors": [{"reason": "accessNotConfigured"}]}}')
    inst = _make(results={'get': err})
    out = inst.check_connection({})
    assert out['connection_ok'] is False
    assert out['errorReason'] == 'accessNotConfigured'


def test_check_connection_reports_probe_failure_one_platform_shape():
    """Sheets is a One Platform API: its disabled-API error carries the reason in
    error.details[] (a google.rpc.ErrorInfo), not error.errors[] like Gmail/Drive —
    this is the actual body Google returns for the #1694 scenario, and it has no
    errors[] array at all.
    """
    body = {
        'error': {
            'code': 403,
            'message': 'Google Sheets API has not been used in project 123456789 before or it is disabled.',
            'status': 'PERMISSION_DENIED',
            'details': [
                {
                    '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
                    'reason': 'SERVICE_DISABLED',
                    'domain': 'googleapis.com',
                }
            ],
        }
    }
    err = _HttpErr(403, 'Forbidden', content=json.dumps(body).encode())
    inst = _make(results={'get': err})
    out = inst.check_connection({})
    assert out['connection_ok'] is False
    assert out['errorReason'] == 'SERVICE_DISABLED'


def test_check_connection_falls_back_to_grpc_status_without_error_info():
    """When even the details[] ErrorInfo is absent, errorReason falls back to the
    coarser gRPC error.status rather than staying unset.
    """
    body = {'error': {'code': 403, 'message': 'Permission denied.', 'status': 'PERMISSION_DENIED'}}
    err = _HttpErr(403, 'Forbidden', content=json.dumps(body).encode())
    inst = _make(results={'get': err})
    out = inst.check_connection({})
    assert out['connection_ok'] is False
    assert out['errorReason'] == 'PERMISSION_DENIED'


def test_check_connection_reports_missing_user_oauth_scope(monkeypatch):
    monkeypatch.setattr(
        workspace_iinstance,
        'Config',
        types.SimpleNamespace(
            getNodeConfig=lambda *_args: {
                'authType': 'user',
                'userToken': json.dumps({'scope': 'https://www.googleapis.com/auth/drive.file'}),
            }
        ),
    )

    inst = _make(tier='write')
    inst.IGlobal.glb = types.SimpleNamespace(logicalType='tool_sheets', connConfig={})
    out = inst.check_connection({})

    assert out['connection_ok'] is False
    assert out['missingScopes'] == ['https://www.googleapis.com/auth/spreadsheets']


# ---------------------------------------------------------------------------
# services.json contract
# ---------------------------------------------------------------------------


def test_services_json_shape():
    data = json.loads(_SERVICES_JSON.read_text())
    assert data['classType'] == ['tool']
    assert data['capabilities'] == ['invoke']
    assert data['lanes'] == {}  # tool node: no data lanes
    assert data['prefix'] == 'sheets'
    assert data['path'] == 'nodes.tool_google_workspace.sheets'
    assert 'sheets.access' in data['fields']
    assert data['fields']['sheets.access']['default'] == 'write'
    assert [row[0] for row in data['fields']['sheets.access']['enum']] == ['readonly', 'write']
    # OAuth node: the framework can't drive it without live creds, so no dynamic test block.
    assert 'test' not in data


def test_services_json_no_secret_defaults():
    """Secrets must never carry a real default (gitleaks scans services*.json)."""
    data = json.loads(_SERVICES_JSON.read_text())
    for prof in data['preconfig']['profiles'].values():
        assert prof.get('serviceKey', '') == ''
        assert prof.get('userToken', '') == ''


# ---------------------------------------------------------------------------
# Writes — values
# ---------------------------------------------------------------------------


def test_values_update_writes_and_defaults_user_entered():
    inst = _make(
        results={
            'update': {
                'spreadsheetId': 'ss1',
                'updatedRange': 'Sheet1!A1:B1',
                'updatedRows': 1,
                'updatedColumns': 2,
                'updatedCells': 2,
            }
        }
    )
    out = inst.values_update({'spreadsheetId': 'ss1', 'range': 'Sheet1!A1', 'values': [['x', 'y']]})
    assert out['updatedCells'] == 2
    kw = inst.IGlobal.service.call_for('update')
    assert kw['valueInputOption'] == 'USER_ENTERED'  # documented default
    assert kw['body'] == {'values': [['x', 'y']]}


def test_values_update_honors_raw_option():
    inst = _make(results={'update': {'updatedCells': 1}})
    inst.values_update({'spreadsheetId': 'ss1', 'range': 'A1', 'values': [['=1+1']], 'valueInputOption': 'RAW'})
    assert inst.IGlobal.service.call_for('update')['valueInputOption'] == 'RAW'


def test_values_update_denied_on_readonly():
    inst = _make(tier='readonly')
    with pytest.raises(ga.GoogleAccessError):
        inst.values_update({'spreadsheetId': 'ss1', 'range': 'A1', 'values': [['x']]})


def test_values_update_requires_2d_values():
    inst = _make()
    with pytest.raises(ValueError):
        inst.values_update({'spreadsheetId': 'ss1', 'range': 'A1', 'values': ['flat', 'not-nested']})


def test_values_batch_update():
    inst = _make(
        results={
            'batchUpdate': {
                'spreadsheetId': 'ss1',
                'totalUpdatedCells': 3,
                'responses': [{'updatedRange': 'A1', 'updatedCells': 3}],
            }
        }
    )
    out = inst.values_batch_update({'spreadsheetId': 'ss1', 'data': [{'range': 'A1', 'values': [['a', 'b', 'c']]}]})
    assert out['totalUpdatedCells'] == 3
    assert out['responses'][0]['updatedCells'] == 3
    assert inst.IGlobal.service.call_for('batchUpdate')['body']['valueInputOption'] == 'USER_ENTERED'


def test_values_batch_update_requires_complete_entries():
    inst = _make()
    with pytest.raises(ValueError):
        inst.values_batch_update({'spreadsheetId': 'ss1', 'data': [{'range': 'A1'}]})


def test_values_batch_update_rejects_non_2d_entry_values():
    # Parity with values_update: each entry's values must be a 2-D array (audit finding).
    inst = _make()
    with pytest.raises(ValueError):
        inst.values_batch_update({'spreadsheetId': 'ss1', 'data': [{'range': 'A1', 'values': ['flat', 'not-nested']}]})


def test_values_append():
    inst = _make(
        results={
            'append': {
                'spreadsheetId': 'ss1',
                'tableRange': 'Sheet1!A1:B2',
                'updates': {'updatedRange': 'Sheet1!A3:B3', 'updatedCells': 2},
            }
        }
    )
    out = inst.values_append(
        {'spreadsheetId': 'ss1', 'range': 'Sheet1!A1', 'values': [['x', 'y']], 'insertDataOption': 'INSERT_ROWS'}
    )
    assert out['tableRange'] == 'Sheet1!A1:B2'
    assert out['updates']['updatedCells'] == 2
    assert inst.IGlobal.service.call_for('append')['insertDataOption'] == 'INSERT_ROWS'


def test_values_append_defaults_to_insert_rows():
    # The API's implicit default is OVERWRITE (silent data loss below the
    # table); the node must send INSERT_ROWS when the agent omits the option.
    inst = _make(
        results={
            'append': {
                'spreadsheetId': 'ss1',
                'tableRange': 'Sheet1!A1:B2',
                'updates': {'updatedRange': 'Sheet1!A3:B3', 'updatedCells': 2},
            }
        }
    )
    inst.values_append({'spreadsheetId': 'ss1', 'range': 'Sheet1!A1', 'values': [['x', 'y']]})
    assert inst.IGlobal.service.call_for('append')['insertDataOption'] == 'INSERT_ROWS'


def test_values_clear():
    inst = _make(results={'clear': {'spreadsheetId': 'ss1', 'clearedRange': 'Sheet1!A1:B2'}})
    out = inst.values_clear({'spreadsheetId': 'ss1', 'range': 'Sheet1!A1:B2'})
    assert out == {'spreadsheetId': 'ss1', 'clearedRange': 'Sheet1!A1:B2'}


# ---------------------------------------------------------------------------
# Writes — structure
# ---------------------------------------------------------------------------


def test_spreadsheet_create_with_sheet_titles():
    inst = _make(
        results={
            'create': {
                'spreadsheetId': 'new1',
                'properties': {'title': 'Q3'},
                'spreadsheetUrl': 'http://x',
                'sheets': [{'properties': {'sheetId': 0, 'title': 'Data'}}],
            }
        }
    )
    out = inst.spreadsheet_create({'title': 'Q3', 'sheetTitles': ['Data', 'Summary']})
    assert out['spreadsheetId'] == 'new1'
    body = inst.IGlobal.service.call_for('create')['body']
    assert body['properties']['title'] == 'Q3'
    assert [s['properties']['title'] for s in body['sheets']] == ['Data', 'Summary']


def test_sheet_add_returns_props():
    inst = _make(
        results={'batchUpdate': {'replies': [{'addSheet': {'properties': {'sheetId': 7, 'title': 'New', 'index': 2}}}]}}
    )
    out = inst.sheet_add({'spreadsheetId': 'ss1', 'title': 'New', 'rowCount': 10})
    assert out == {'sheetId': 7, 'title': 'New', 'index': 2}
    req = inst.IGlobal.service.call_for('batchUpdate')['body']['requests'][0]
    assert req['addSheet']['properties']['title'] == 'New'
    assert req['addSheet']['properties']['gridProperties'] == {'rowCount': 10}


def test_sheet_delete():
    inst = _make(results={'batchUpdate': {}})
    out = inst.sheet_delete({'spreadsheetId': 'ss1', 'sheetId': 3})
    assert out == {'deletedSheetId': 3}
    assert inst.IGlobal.service.call_for('batchUpdate')['body']['requests'][0]['deleteSheet']['sheetId'] == 3


def test_sheet_delete_rejects_bool_and_float_sheetid():
    # Shared require_int semantics: numeric strings coerce, bool/float reject.
    inst = _make()
    for bad in (True, 3.5, [3]):
        with pytest.raises(ValueError):
            inst.sheet_delete({'spreadsheetId': 'ss1', 'sheetId': bad})


def test_sheet_delete_coerces_numeric_string_sheetid():
    inst = _make(results={'batchUpdate': {'spreadsheetId': 'ss1', 'replies': [{}]}})
    inst.sheet_delete({'spreadsheetId': 'ss1', 'sheetId': '3'})
    body = inst.IGlobal.service.call_for('batchUpdate')['body']
    assert body['requests'][0]['deleteSheet']['sheetId'] == 3


def test_sheet_delete_rejects_bool_sheetid():
    # JSON true must never be coerced to 1.
    inst = _make()
    with pytest.raises(ValueError):
        inst.sheet_delete({'spreadsheetId': 'ss1', 'sheetId': True})


def test_sheet_duplicate():
    inst = _make(
        results={
            'batchUpdate': {
                'replies': [{'duplicateSheet': {'properties': {'sheetId': 9, 'title': 'Copy of Tab', 'index': 1}}}]
            }
        }
    )
    out = inst.sheet_duplicate({'spreadsheetId': 'ss1', 'sheetId': 2, 'newName': 'Copy of Tab'})
    assert out['sheetId'] == 9
    req = inst.IGlobal.service.call_for('batchUpdate')['body']['requests'][0]['duplicateSheet']
    assert req == {'sourceSheetId': 2, 'newSheetName': 'Copy of Tab'}


def test_sheet_copy_to():
    inst = _make(results={'copyTo': {'sheetId': 5, 'title': 'Copied', 'index': 0}})
    out = inst.sheet_copy_to({'spreadsheetId': 'ss1', 'sheetId': 2, 'destinationSpreadsheetId': 'ss2'})
    assert out == {'sheetId': 5, 'title': 'Copied', 'index': 0}
    kw = inst.IGlobal.service.call_for('copyTo')
    assert kw['sheetId'] == 2 and kw['body']['destinationSpreadsheetId'] == 'ss2'


def test_sheet_copy_to_requires_destination():
    inst = _make()
    with pytest.raises(ValueError):
        inst.sheet_copy_to({'spreadsheetId': 'ss1', 'sheetId': 2})


def test_batch_update_catch_all():
    inst = _make(results={'batchUpdate': {'spreadsheetId': 'ss1', 'replies': [{}, {}]}})
    reqs = [{'repeatCell': {'range': {}, 'cell': {}}}, {'addConditionalFormatRule': {}}]
    out = inst.batch_update({'spreadsheetId': 'ss1', 'requests': reqs})
    assert out['spreadsheetId'] == 'ss1'
    assert len(out['replies']) == 2
    assert inst.IGlobal.service.call_for('batchUpdate')['body']['requests'] == reqs


def test_batch_update_requires_nonempty_requests():
    inst = _make()
    with pytest.raises(ValueError):
        inst.batch_update({'spreadsheetId': 'ss1', 'requests': []})


def test_batch_update_denied_on_readonly():
    inst = _make(tier='readonly')
    with pytest.raises(ga.GoogleAccessError):
        inst.batch_update({'spreadsheetId': 'ss1', 'requests': [{'x': 1}]})


# ---------------------------------------------------------------------------
# Completeness
# ---------------------------------------------------------------------------


def test_all_thirteen_tools_plus_diagnostic_present():
    expected = {
        'check_connection',
        'spreadsheet_get',
        'values_get',
        'values_batch_get',
        'values_update',
        'values_batch_update',
        'values_append',
        'values_clear',
        'spreadsheet_create',
        'sheet_add',
        'sheet_delete',
        'sheet_duplicate',
        'sheet_copy_to',
        'batch_update',
    }
    for name in expected:
        assert callable(getattr(sheets_iinstance.IInstance, name)), f'missing tool: {name}'


# ---------------------------------------------------------------------------
# Scope report
# ---------------------------------------------------------------------------


def test_token_scope_report_covered_missing_absent_and_malformed():
    required = ['https://www.googleapis.com/auth/spreadsheets']
    assert sheets_client.token_scope_report({}, required) == (set(), True, [])
    covered_cfg = {'userToken': '{"scope": "https://www.googleapis.com/auth/spreadsheets"}'}
    granted, covered, missing = sheets_client.token_scope_report(covered_cfg, required)
    assert covered is True and missing == []
    other_cfg = {'userToken': '{"scope": "https://www.googleapis.com/auth/unrelated"}'}
    granted, covered, missing = sheets_client.token_scope_report(other_cfg, required)
    assert covered is False and missing == required
    with pytest.raises(ValueError):
        sheets_client.token_scope_report({'userToken': '{bad'}, required)


# ---------------------------------------------------------------------------
# Review round: empty-values rejection + malformed-token diagnostics
# ---------------------------------------------------------------------------


def test_values_update_rejects_empty_values():
    inst = _make()
    with pytest.raises(ValueError, match='non-empty 2-D'):
        inst.values_update({'spreadsheetId': 'ss1', 'range': 'A1', 'values': []})


def test_check_connection_reports_malformed_token(monkeypatch):
    class _Cfg:
        @staticmethod
        def getNodeConfig(*_a, **_k):
            return {'authType': 'user', 'userToken': '{bad json'}

    monkeypatch.setattr(workspace_iinstance, 'Config', _Cfg)
    inst = _make()
    inst.IGlobal.glb = types.SimpleNamespace(logicalType='tool_sheets', connConfig={})
    out = inst.check_connection({})
    assert out['connection_ok'] is False
    assert 'invalid user token' in out['scopeError']


def test_validate_config_warns_for_malformed_user_token(monkeypatch):
    warnings = []
    monkeypatch.setattr(
        workspace_iglobal.Config, 'getNodeConfig', lambda *a, **k: {'authType': 'user', 'userToken': '{bad json'}
    )
    monkeypatch.setattr(workspace_iglobal, 'warning', warnings.append)
    glb = sheets_iglobal.IGlobal()
    glb.glb = types.SimpleNamespace(logicalType='sheets', connConfig={})
    glb.validateConfig()
    assert any('invalid' in message.lower() for message in warnings)
