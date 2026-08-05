# =============================================================================
# RocketRide Engine
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Unit tests for the tool_drive node (no network, no engine runtime).

Bootstrap mirrors test_sheets.py / test_gmail.py: inject lightweight stubs for
the engine runtime modules ONLY if absent, import the module under test, then
drop the stubs so they never leak into a shared pytest session. The Google SDK
is never imported — IInstance receives a FakeDrive service and a real
GoogleAccess.
"""

from __future__ import annotations

import base64
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

_SERVICES_JSON = _NODES_SRC / 'nodes' / 'tool_google_workspace' / 'services.drive.json'


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

    def _stub_int_arg(args, key, *, default, lo, hi, tool_name=''):
        value = args.get(key)
        if value is None:
            value = default
        if isinstance(value, bool) or not isinstance(value, int):
            prefix = f'{tool_name}: ' if tool_name else ''
            raise ValueError(f'{prefix}"{key}" must be an integer')
        return max(lo, min(value, hi))

    ai_common_utils.int_arg = _stub_int_arg

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

drive_iinstance = importlib.import_module('nodes.tool_google_workspace.drive.IInstance')
drive_client = importlib.import_module('nodes.tool_google_workspace.drive.client')
ga = importlib.import_module('nodes.core.google_access')

for _name in _added:
    sys.modules.pop(_name, None)


# ---------------------------------------------------------------------------
# Fake Drive service: records terminal calls, returns canned results.
# ---------------------------------------------------------------------------


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
            self._sv.calls.append((name, kwargs))
            return _Req(self._sv.results.get(name, {}))

        return method


class FakeDrive:
    def __init__(self, results=None):
        self.calls = []
        self.results = results or {}

    def files(self):
        return _Node(self, 'files')

    def permissions(self):
        return _Node(self, 'permissions')

    def drives(self):
        return _Node(self, 'drives')

    def changes(self):
        return _Node(self, 'changes')

    def call_for(self, op):
        """Return the kwargs of the FIRST recorded call to terminal method ``op``."""
        return next((kw for n, kw in self.calls if n == op), None)

    def calls_for(self, op):
        return [kw for n, kw in self.calls if n == op]


def _make(cfg=None, results=None, account_domain=None):
    """Build an IInstance wired to a FakeDrive and a real resolved GoogleAccess."""
    inst = drive_iinstance.IInstance()
    access = ga.resolve_google_access(cfg or {'access': 'write'}, ga.DRIVE)
    inst.IGlobal = types.SimpleNamespace(service=FakeDrive(results or {}), access=access, account_domain=account_domain)
    return inst


_WRITE_FLAGS = {'access': 'write', 'allowPublicSharing': True, 'allowHardDelete': True}


# ---------------------------------------------------------------------------
# Access spec / defaults
# ---------------------------------------------------------------------------


def test_default_tier_is_write():
    access = ga.resolve_google_access({}, ga.DRIVE)
    assert access.tier == 'write'
    assert access.can_write is True
    assert access.flags == {'allowPublicSharing': False, 'allowHardDelete': False}


def test_readonly_tier_no_write():
    access = ga.resolve_google_access({'access': 'readonly'}, ga.DRIVE)
    assert access.can_write is False


def test_flag_misconfig_string_raises():
    with pytest.raises(ga.GoogleAccessError):
        ga.resolve_google_access({'access': 'write', 'allowPublicSharing': 'true'}, ga.DRIVE)


# ---------------------------------------------------------------------------
# Reads
# ---------------------------------------------------------------------------


def test_file_list_defaults_and_all_drives():
    inst = _make(results={'list': {'files': [{'id': 'f1', 'name': 'A', 'mimeType': 'text/plain'}]}})
    out = inst.file_list({})
    assert out['files'][0] == {'id': 'f1', 'name': 'A', 'mimeType': 'text/plain'}
    kw = inst.IGlobal.service.call_for('list')
    assert kw['supportsAllDrives'] is True
    assert kw['includeItemsFromAllDrives'] is True
    assert kw['pageSize'] == 25
    assert 'q' not in kw


def test_file_list_pagesize_clamped_and_explicit_zero_survives():
    inst = _make(results={'list': {'files': []}})
    inst.file_list({'pageSize': 500})
    assert inst.IGlobal.service.call_for('list')['pageSize'] == 100
    inst2 = _make(results={'list': {'files': []}})
    inst2.file_list({'pageSize': 0})  # explicit 0 clamps up to 1, not defaulted to 25
    assert inst2.IGlobal.service.call_for('list')['pageSize'] == 1


def test_file_list_pagesize_rejects_bool():
    inst = _make()
    with pytest.raises(ValueError):
        inst.file_list({'pageSize': True})


def test_file_list_driveid_sets_corpora():
    inst = _make(results={'list': {'files': []}})
    inst.file_list({'driveId': 'D1'})
    kw = inst.IGlobal.service.call_for('list')
    assert kw['driveId'] == 'D1'
    assert kw['corpora'] == 'drive'


def test_file_search_requires_q():
    inst = _make()
    with pytest.raises(ValueError):
        inst.file_search({})


def test_file_search_delegates_with_query():
    inst = _make(results={'list': {'files': [{'id': 'f9', 'name': 'inv'}]}})
    out = inst.file_search({'q': "name contains 'inv'"})
    assert out['files'][0]['id'] == 'f9'
    assert inst.IGlobal.service.call_for('list')['q'] == "name contains 'inv'"


def test_file_get_cleans_and_all_drives():
    raw = {
        'id': 'f1',
        'name': 'Doc',
        'description': 'Canvas validation code: DRIVE-CONTRACT-83',
        'mimeType': 'application/pdf',
        'parents': ['p1'],
        'webViewLink': 'http://x',
        'modifiedTime': '2026-01-01T00:00:00Z',
        'size': '1234',
        'trashed': False,
        'driveId': 'D1',
    }
    inst = _make(results={'get': raw})
    out = inst.file_get({'fileId': 'f1'})
    assert out['id'] == 'f1' and out['size'] == '1234' and out['driveId'] == 'D1'
    assert out['description'] == 'Canvas validation code: DRIVE-CONTRACT-83'
    assert 'description' in inst.IGlobal.service.call_for('get')['fields'].split(',')
    assert inst.IGlobal.service.call_for('get')['supportsAllDrives'] is True


def test_file_get_requires_fileid():
    inst = _make()
    with pytest.raises(ValueError):
        inst.file_get({})


def test_file_download_returns_base64():
    inst = _make(results={'get': {'mimeType': 'text/plain', 'size': '5'}, 'get_media': b'hello'})
    out = inst.file_download({'fileId': 'f1'})
    assert out == {
        'fileId': 'f1',
        'mimeType': 'text/plain',
        'size': 5,
        'data_base64': base64.b64encode(b'hello').decode('ascii'),
    }
    assert inst.IGlobal.service.call_for('get_media')['supportsAllDrives'] is True


def test_file_download_refuses_native_pointing_to_export():
    inst = _make(results={'get': {'mimeType': 'application/vnd.google-apps.document'}})
    with pytest.raises(ValueError) as exc:
        inst.file_download({'fileId': 'f1'})
    assert 'file_export' in str(exc.value)


def test_file_download_size_cap_raises():
    inst = _make(results={'get': {'mimeType': 'application/pdf', 'size': str(11 * 1024 * 1024)}})
    with pytest.raises(ValueError) as exc:
        inst.file_download({'fileId': 'f1'})
    assert 'cap' in str(exc.value).lower()


def test_file_download_size_cap_raises_when_metadata_omits_size():
    raw = b'x' * (drive_iinstance._MAX_DOWNLOAD + 1)
    inst = _make(results={'get': {'mimeType': 'application/pdf'}, 'get_media': raw})
    with pytest.raises(ValueError) as exc:
        inst.file_download({'fileId': 'f1'})
    assert 'cap' in str(exc.value).lower()


def test_file_export_returns_base64():
    inst = _make(results={'export_media': b'%PDF-1.4'})
    out = inst.file_export({'fileId': 'doc1', 'mimeType': 'application/pdf'})
    assert out['fileId'] == 'doc1'
    assert out['mimeType'] == 'application/pdf'
    assert out['data_base64'] == base64.b64encode(b'%PDF-1.4').decode('ascii')
    assert inst.IGlobal.service.call_for('export_media')['mimeType'] == 'application/pdf'


def test_file_export_requires_mimetype():
    inst = _make()
    with pytest.raises(ValueError):
        inst.file_export({'fileId': 'doc1'})


def test_drives_list():
    inst = _make(results={'list': {'drives': [{'id': 'D1', 'name': 'Team'}], 'nextPageToken': 'nt'}})
    out = inst.drives_list({})
    assert out['drives'] == [{'id': 'D1', 'name': 'Team'}]
    assert out['nextPageToken'] == 'nt'


def test_changes_list_bootstrap_forwards_drive_id():
    # Start tokens are per corpus: the shared-drive bootstrap must carry driveId.
    inst = _make(results={'getStartPageToken': {'startPageToken': '77'}})
    out = inst.changes_list({'driveId': 'D1'})
    assert out['startPageToken'] == '77'
    kw = inst.IGlobal.service.call_for('getStartPageToken')
    assert kw['driveId'] == 'D1' and kw['supportsAllDrives'] is True


def test_changes_list_bootstraps_start_token():
    inst = _make(results={'getStartPageToken': {'startPageToken': '900'}})
    out = inst.changes_list({})
    assert out['startPageToken'] == '900'
    assert 'message' in out
    assert inst.IGlobal.service.call_for('getStartPageToken')['supportsAllDrives'] is True


def test_changes_list_with_token():
    inst = _make(
        results={
            'list': {
                'newStartPageToken': '950',
                'changes': [
                    {
                        'fileId': 'f1',
                        'removed': False,
                        'time': 't',
                        'file': {
                            'id': 'f1',
                            'name': 'A',
                            'description': 'Canvas validation code: DRIVE-CONTRACT-83',
                        },
                    }
                ],
            }
        }
    )
    out = inst.changes_list({'pageToken': '900'})
    assert out['newStartPageToken'] == '950'
    assert out['changes'][0] == {
        'fileId': 'f1',
        'removed': False,
        'time': 't',
        'file': {'id': 'f1', 'name': 'A', 'description': 'Canvas validation code: DRIVE-CONTRACT-83'},
    }
    assert out['changes'][0]['file']['description'] == 'Canvas validation code: DRIVE-CONTRACT-83'
    kw = inst.IGlobal.service.call_for('list')
    assert kw['pageToken'] == '900' and kw['supportsAllDrives'] is True


# ---------------------------------------------------------------------------
# Writes — files
# ---------------------------------------------------------------------------


def test_file_create_metadata_only():
    inst = _make(results={'create': {'id': 'n1', 'name': 'New'}})
    out = inst.file_create({'name': 'New', 'parents': ['folder1']})
    assert out == {'id': 'n1', 'name': 'New'}
    kw = inst.IGlobal.service.call_for('create')
    assert kw['body'] == {'name': 'New', 'parents': ['folder1']}
    assert kw['supportsAllDrives'] is True
    assert 'media_body' not in kw


def test_folder_create_sets_folder_mime():
    inst = _make(results={'create': {'id': 'd1', 'name': 'Folder'}})
    inst.folder_create({'name': 'Folder'})
    body = inst.IGlobal.service.call_for('create')['body']
    assert body['mimeType'] == 'application/vnd.google-apps.folder'


def test_file_copy():
    inst = _make(results={'copy': {'id': 'c1', 'name': 'Copy'}})
    out = inst.file_copy({'fileId': 'f1', 'name': 'Copy'})
    assert out['id'] == 'c1'
    kw = inst.IGlobal.service.call_for('copy')
    assert kw['fileId'] == 'f1' and kw['body'] == {'name': 'Copy'} and kw['supportsAllDrives'] is True


def test_file_move_add_and_remove_parents_recorded():
    inst = _make(results={'get': {'parents': ['old1', 'old2']}, 'update': {'id': 'f1', 'parents': ['new1']}})
    inst.file_move({'fileId': 'f1', 'addParents': ['new1']})
    kw = inst.IGlobal.service.call_for('update')
    assert kw['addParents'] == 'new1'
    assert kw['removeParents'] == 'old1,old2'  # defaulted from current parents
    assert kw['supportsAllDrives'] is True
    # current parents were fetched via files().get(fields='parents')
    assert inst.IGlobal.service.call_for('get')['fields'] == 'parents'


def test_file_move_explicit_remove_parents():
    inst = _make(results={'update': {'id': 'f1'}})
    inst.file_move({'fileId': 'f1', 'addParents': ['new1'], 'removeParents': ['keep_out']})
    kw = inst.IGlobal.service.call_for('update')
    assert kw['removeParents'] == 'keep_out'
    # no metadata fetch when removeParents supplied
    assert inst.IGlobal.service.call_for('get') is None


def test_file_move_requires_add_parents():
    inst = _make()
    with pytest.raises(ValueError):
        inst.file_move({'fileId': 'f1'})


def test_file_trash_sets_flag():
    inst = _make(results={'update': {'id': 'f1', 'trashed': True}})
    out = inst.file_trash({'fileId': 'f1'})
    assert out['trashed'] is True
    kw = inst.IGlobal.service.call_for('update')
    assert kw['body'] == {'trashed': True} and kw['supportsAllDrives'] is True


def test_file_untrash_sets_flag():
    inst = _make(results={'update': {'id': 'f1', 'trashed': False}})
    inst.file_untrash({'fileId': 'f1'})
    assert inst.IGlobal.service.call_for('update')['body'] == {'trashed': False}


def test_file_update_rename():
    inst = _make(results={'update': {'id': 'f1', 'name': 'Renamed'}})
    inst.file_update({'fileId': 'f1', 'name': 'Renamed', 'description': 'd'})
    body = inst.IGlobal.service.call_for('update')['body']
    assert body == {'name': 'Renamed', 'description': 'd'}


def test_file_update_requires_a_field_to_change():
    inst = _make()
    with pytest.raises(ValueError, match='^file_update: provide at least one field to change$'):
        inst.file_update({'fileId': 'f1'})
    assert inst.IGlobal.service.call_for('update') is None


# ---------------------------------------------------------------------------
# Permissions
# ---------------------------------------------------------------------------


def test_permission_list():
    inst = _make(
        cfg={'access': 'readonly'},
        results={'list': {'permissions': [{'id': 'p1', 'type': 'user', 'role': 'writer'}]}},
    )
    out = inst.permission_list({'fileId': 'f1'})
    assert out['permissions'][0] == {'id': 'p1', 'type': 'user', 'role': 'writer'}
    assert inst.IGlobal.service.call_for('list')['supportsAllDrives'] is True


def test_permission_update():
    inst = _make(
        results={
            'get': {'id': 'p1', 'type': 'user', 'emailAddress': 'sam@x.com'},
            'update': {'id': 'p1', 'type': 'user', 'role': 'reader'},
        }
    )
    inst.permission_update({'fileId': 'f1', 'permissionId': 'p1', 'role': 'reader'})
    kw = inst.IGlobal.service.call_for('update')
    assert kw['permissionId'] == 'p1' and kw['body'] == {'role': 'reader'}


def test_permission_update_gates_existing_public_grant():
    # Broadening an existing anyone-permission is sharing: same gate as create.
    inst = _make(results={'get': {'id': 'p1', 'type': 'anyone', 'role': 'reader'}})
    with pytest.raises(ga.GoogleAccessError) as exc:
        inst.permission_update({'fileId': 'f1', 'permissionId': 'p1', 'role': 'writer'})
    assert 'allowPublicSharing' in str(exc.value)
    assert inst.IGlobal.service.call_for('update') is None  # role never changed


def test_permission_update_public_grant_allowed_with_flag():
    inst = _make(
        cfg=dict(_WRITE_FLAGS),
        results={
            'get': {'id': 'p1', 'type': 'anyone', 'role': 'reader'},
            'update': {'id': 'p1', 'type': 'anyone', 'role': 'writer'},
        },
    )
    out = inst.permission_update({'fileId': 'f1', 'permissionId': 'p1', 'role': 'writer'})
    assert out['role'] == 'writer'


def test_permission_update_rejects_bad_role():
    inst = _make()
    with pytest.raises(ValueError):
        inst.permission_update({'fileId': 'f1', 'permissionId': 'p1', 'role': 'god'})


def test_permission_delete():
    inst = _make(results={'delete': {}})
    out = inst.permission_delete({'fileId': 'f1', 'permissionId': 'p1'})
    assert out == {'deleted': True, 'fileId': 'f1', 'permissionId': 'p1'}


# ---------------------------------------------------------------------------
# Gating matrix — readonly
# ---------------------------------------------------------------------------

_WRITE_METHODS = [
    ('file_create', {'name': 'x'}),
    ('file_update', {'fileId': 'f1', 'name': 'x'}),
    ('file_copy', {'fileId': 'f1'}),
    ('file_move', {'fileId': 'f1', 'addParents': ['n']}),
    ('file_trash', {'fileId': 'f1'}),
    ('file_untrash', {'fileId': 'f1'}),
    ('folder_create', {'name': 'x'}),
    ('permission_update', {'fileId': 'f1', 'permissionId': 'p1', 'role': 'reader'}),
    ('permission_delete', {'fileId': 'f1', 'permissionId': 'p1'}),
    ('permission_create', {'fileId': 'f1', 'type': 'user', 'role': 'reader', 'emailAddress': 'a@x.com'}),
    ('file_delete', {'fileId': 'f1'}),
]


@pytest.mark.parametrize('method,args', _WRITE_METHODS)
def test_readonly_denies_all_writes(method, args):
    inst = _make(cfg={'access': 'readonly'})
    with pytest.raises(ga.GoogleAccessError):
        getattr(inst, method)(dict(args))


# ---------------------------------------------------------------------------
# Gating matrix — sharing gate (allowPublicSharing)
# ---------------------------------------------------------------------------


def _perm_inst(cfg, account_domain):
    return _make(
        cfg=cfg, results={'create': {'id': 'p1', 'type': 'user', 'role': 'reader'}}, account_domain=account_domain
    )


def test_share_anyone_gated_when_flag_off():
    inst = _perm_inst({'access': 'write'}, 'acme.com')
    with pytest.raises(ga.GoogleAccessError) as exc:
        inst.permission_create({'fileId': 'f1', 'type': 'anyone', 'role': 'reader'})
    assert 'allowPublicSharing' in str(exc.value)


def test_share_internal_user_passes_flag_off():
    inst = _perm_inst({'access': 'write'}, 'acme.com')
    inst.permission_create({'fileId': 'f1', 'type': 'user', 'role': 'reader', 'emailAddress': 'bob@acme.com'})
    assert inst.IGlobal.service.call_for('create') is not None


def test_share_external_user_gated_flag_off():
    inst = _perm_inst({'access': 'write'}, 'acme.com')
    with pytest.raises(ga.GoogleAccessError) as exc:
        inst.permission_create({'fileId': 'f1', 'type': 'user', 'role': 'reader', 'emailAddress': 'eve@evil.com'})
    assert 'allowPublicSharing' in str(exc.value)


def test_share_domain_same_passes_flag_off():
    inst = _perm_inst({'access': 'write'}, 'acme.com')
    inst.permission_create({'fileId': 'f1', 'type': 'domain', 'role': 'reader', 'domain': 'acme.com'})
    assert inst.IGlobal.service.call_for('create') is not None


def test_share_domain_other_gated_flag_off():
    inst = _perm_inst({'access': 'write'}, 'acme.com')
    with pytest.raises(ga.GoogleAccessError):
        inst.permission_create({'fileId': 'f1', 'type': 'domain', 'role': 'reader', 'domain': 'other.com'})


def test_share_unknown_domain_anyone_and_domain_gated_user_passes():
    inst = _perm_inst({'access': 'write'}, None)  # UNKNOWN account domain
    with pytest.raises(ga.GoogleAccessError):
        inst.permission_create({'fileId': 'f1', 'type': 'anyone', 'role': 'reader'})
    inst2 = _perm_inst({'access': 'write'}, None)
    with pytest.raises(ga.GoogleAccessError):
        inst2.permission_create({'fileId': 'f1', 'type': 'domain', 'role': 'reader', 'domain': 'anything.com'})
    inst3 = _perm_inst({'access': 'write'}, None)
    inst3.permission_create({'fileId': 'f1', 'type': 'user', 'role': 'reader', 'emailAddress': 'x@whoever.com'})
    assert inst3.IGlobal.service.call_for('create') is not None


def test_share_gated_ops_pass_with_flag_on():
    inst = _perm_inst(_WRITE_FLAGS, 'acme.com')
    inst.permission_create({'fileId': 'f1', 'type': 'anyone', 'role': 'reader'})
    kw = inst.IGlobal.service.call_for('create')
    assert kw['body'] == {'type': 'anyone', 'role': 'reader'}
    assert 'sendNotificationEmail' not in kw  # anyone/domain: Drive rejects the param; omitted entirely


def test_share_user_grant_always_sends_notification():
    inst = _perm_inst(_WRITE_FLAGS, 'acme.com')
    inst.permission_create({'fileId': 'f1', 'type': 'user', 'role': 'writer', 'emailAddress': 'eve@evil.com'})
    assert inst.IGlobal.service.call_for('create')['sendNotificationEmail'] is True


def test_share_user_requires_email():
    inst = _perm_inst(_WRITE_FLAGS, 'acme.com')
    with pytest.raises(ValueError):
        inst.permission_create({'fileId': 'f1', 'type': 'user', 'role': 'reader'})


# ---------------------------------------------------------------------------
# Gating matrix — hard delete (allowHardDelete)
# ---------------------------------------------------------------------------


def test_file_delete_gated_when_flag_off():
    inst = _make(cfg={'access': 'write'})
    with pytest.raises(ga.GoogleAccessError) as exc:
        inst.file_delete({'fileId': 'f1'})
    assert 'allowHardDelete' in str(exc.value)


def test_file_delete_passes_with_flag_on():
    inst = _make(cfg=_WRITE_FLAGS, results={'delete': {}})
    out = inst.file_delete({'fileId': 'f1'})
    assert out == {'deleted': True, 'fileId': 'f1', 'permanent': True}
    assert inst.IGlobal.service.call_for('delete')['supportsAllDrives'] is True


def test_file_trash_passes_at_write_without_flag():
    inst = _make(cfg={'access': 'write'}, results={'update': {'id': 'f1', 'trashed': True}})
    out = inst.file_trash({'fileId': 'f1'})
    assert out['trashed'] is True


# ---------------------------------------------------------------------------
# resolve_account_domain helper
# ---------------------------------------------------------------------------


def test_resolve_account_domain_service_admin_email():
    assert drive_client.resolve_account_domain('service', {'adminEmail': 'admin@Acme.com'}) == 'acme.com'


def test_resolve_account_domain_service_no_admin_is_none():
    assert drive_client.resolve_account_domain('service', {}) is None


def test_resolve_account_domain_treats_consumer_domains_as_unknown():
    # A personal account is not an organisation: gmail.com must never become
    # the "own domain" that waves through grants to other consumer addresses.
    token = json.dumps({'email': 'someone@gmail.com'})
    assert drive_client.resolve_account_domain('user', {'userToken': token}) is None
    assert drive_client.resolve_account_domain('service', {'adminEmail': 'x@googlemail.com'}) is None


def test_resolve_account_domain_user_hd_claim():
    token = json.dumps({'scope': 'x', 'hd': 'Corp.com'})
    assert drive_client.resolve_account_domain('user', {'userToken': token}) == 'corp.com'


def test_resolve_account_domain_user_email_claim():
    token = json.dumps({'email': 'me@team.io'})
    assert drive_client.resolve_account_domain('user', {'userToken': token}) == 'team.io'


def test_resolve_account_domain_user_no_claim_is_none():
    token = json.dumps({'access_token': 'abc'})
    assert drive_client.resolve_account_domain('user', {'userToken': token}) is None


# ---------------------------------------------------------------------------
# Diagnostics
# ---------------------------------------------------------------------------


def test_check_connection_reports_ok():
    inst = _make()
    out = inst.check_connection({})
    assert out['connection_ok'] is True
    assert out['access'] == 'write'
    assert any('drive' in s for s in out['requiredScopes'])


# ---------------------------------------------------------------------------
# Error mapping
# ---------------------------------------------------------------------------


class _HttpErr(Exception):
    def __init__(self, status, reason, content=b''):
        super().__init__(reason)
        self.resp = types.SimpleNamespace(status=status)
        self.reason = reason
        self.content = content


def test_execute_maps_403_to_actionable_valueerror():
    inst = _make(results={'get': _HttpErr(403, 'insufficientPermissions')})
    with pytest.raises(ValueError) as exc:
        inst.file_get({'fileId': 'f1'})
    assert '403' in str(exc.value)


# ---------------------------------------------------------------------------
# services.json contract
# ---------------------------------------------------------------------------


def test_services_json_shape():
    data = json.loads(_SERVICES_JSON.read_text(encoding='utf-8'))
    assert data['title'] == 'Google Drive'
    assert data['protocol'] == 'tool_drive://'
    assert data['classType'] == ['tool']
    assert data['capabilities'] == ['invoke']
    assert data['lanes'] == {}
    assert data['prefix'] == 'drive'
    assert data['path'] == 'nodes.tool_google_workspace.drive'
    assert data['icon'] == 'drive.svg'
    assert 'drive.access' in data['fields']
    assert data['fields']['drive.access']['default'] == 'write'
    assert [row[0] for row in data['fields']['drive.access']['enum']] == ['readonly', 'write']
    # Both destructive gate fields present (issue AC).
    assert 'drive.allowPublicSharing' in data['fields']
    assert 'drive.allowHardDelete' in data['fields']
    assert data['fields']['drive.allowPublicSharing']['default'] is False
    assert data['fields']['drive.allowHardDelete']['default'] is False
    assert data['shape'][0]['properties'] == ['type', 'google.authType', 'drive.access']
    # OAuth node: no dynamic test block.
    assert 'test' not in data


def test_services_json_no_secret_defaults():
    data = json.loads(_SERVICES_JSON.read_text(encoding='utf-8'))
    prof = data['preconfig']['profiles']['default']
    assert prof.get('serviceKey', '') == ''
    assert prof.get('userToken', '') == ''
    # Gate flags are NOT in the profile (absent => False, gmail precedent).
    assert 'allowPublicSharing' not in prof
    assert 'allowHardDelete' not in prof


# ---------------------------------------------------------------------------
# Completeness
# ---------------------------------------------------------------------------


def test_all_tools_present():
    expected = {
        'check_connection',
        'file_list',
        'file_search',
        'file_get',
        'file_download',
        'file_export',
        'drives_list',
        'changes_list',
        'file_create',
        'file_update',
        'file_copy',
        'file_move',
        'file_trash',
        'file_untrash',
        'folder_create',
        'permission_list',
        'permission_update',
        'permission_delete',
        'permission_create',
        'file_delete',
    }
    for name in expected:
        assert callable(getattr(drive_iinstance.IInstance, name)), f'missing tool: {name}'


def test_file_create_passes_description():
    inst = _make(results={'create': {'id': 'n2', 'name': 'New', 'description': 'Canvas code'}})
    out = inst.file_create({'name': 'New', 'description': 'Canvas code'})
    assert inst.IGlobal.service.call_for('create')['body']['description'] == 'Canvas code'
    assert out['description'] == 'Canvas code'


def test_folder_create_passes_description():
    inst = _make(results={'create': {'id': 'd2', 'name': 'Folder', 'description': 'Canvas code'}})
    inst.folder_create({'name': 'Folder', 'description': 'Canvas code'})
    assert inst.IGlobal.service.call_for('create')['body']['description'] == 'Canvas code'


def test_file_copy_passes_description():
    inst = _make(results={'copy': {'id': 'c2', 'name': 'Copy', 'description': 'Canvas code'}})
    inst.file_copy({'fileId': 'f1', 'name': 'Copy', 'description': 'Canvas code'})
    assert inst.IGlobal.service.call_for('copy')['body']['description'] == 'Canvas code'


def test_token_scope_report_covered_missing_absent_and_malformed():
    required = ['https://www.googleapis.com/auth/drive']
    assert drive_client.token_scope_report({}, required) == (set(), True, [])
    covered_cfg = {'userToken': '{"scope": "https://www.googleapis.com/auth/drive"}'}
    granted, covered, missing = drive_client.token_scope_report(covered_cfg, required)
    assert covered is True and missing == []
    other_cfg = {'userToken': '{"scope": "https://www.googleapis.com/auth/unrelated"}'}
    granted, covered, missing = drive_client.token_scope_report(other_cfg, required)
    assert covered is False and missing == required
    with pytest.raises(ValueError):
        drive_client.token_scope_report({'userToken': '{bad'}, required)


def test_resolve_account_domain_non_dict_token_degrades_to_unknown():
    cfg = {'userToken': '["not", "an", "object"]'}
    assert drive_client.resolve_account_domain('user', cfg) is None


def test_decode_content_tolerates_wrapped_base64():
    import base64 as _b64

    wrapped = _b64.b64encode(b'rocketride wrapped payload').decode()
    wrapped = wrapped[:10] + '\n' + wrapped[10:14] + ' ' + wrapped[14:]
    out = drive_iinstance.IInstance._decode_content({'c': wrapped}, 'c', 'file_create')
    assert out == b'rocketride wrapped payload'
