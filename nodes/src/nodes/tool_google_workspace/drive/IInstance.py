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
Google Drive tool node instance.

Exposes the Drive v3 surface as agent tools: list/search files, read metadata,
download binary files and export native Docs/Sheets/Slides, create/update/copy/
move files and folders, manage permissions (sharing), trash/untrash, track
changes, and permanently delete. Every file operation targets My Drive and
shared drives (supportsAllDrives).

Write operations require the ``write`` tier. Two destructive capabilities are
additionally gated behind explicit config flags: public/external sharing
(``allowPublicSharing``) and permanent delete (``allowHardDelete``).

Operational targets (fileId, folderId, permissionId) are always invoke-time
parameters — never node config.
"""

from __future__ import annotations

import base64

from rocketlib import tool_function

from ai.common.utils import int_arg, normalize_tool_input, optional_str, optional_str_list, require_str

from .client import (
    SERVICE,
    _FILE_FIELDS,
    clean_binary,
    clean_change,
    clean_drive,
    clean_file,
    clean_file_list,
    clean_permission,
    execute,
    execute_media,
)
from ..IInstance import GoogleToolInstanceBase
from .IGlobal import IGlobal

# Google-native docs (Docs/Sheets/Slides/etc.) have no binary blob; they must be
# exported (file_export), not downloaded (file_download).
_GOOGLE_NATIVE_PREFIX = 'application/vnd.google-apps.'
_FOLDER_MIME = 'application/vnd.google-apps.folder'

# Download cap: get_media buffers the whole body in memory and returns base64.
_MAX_DOWNLOAD = 10 * 1024 * 1024  # 10 MiB

_PERM_TYPES = ('user', 'group', 'domain', 'anyone')
_PERM_ROLES = ('reader', 'commenter', 'writer', 'fileOrganizer', 'organizer', 'owner')

# Fields returned for a permission resource.
_PERM_FIELDS = 'id,type,role,emailAddress,domain,allowFileDiscovery'


class IInstance(GoogleToolInstanceBase):
    IGlobal: IGlobal
    SERVICE = SERVICE

    # -----------------------------------------------------------------------
    # Helpers
    # -----------------------------------------------------------------------

    def _account_domain(self) -> str | None:
        """Return the resolved account domain (or None/UNKNOWN)."""
        return getattr(self.IGlobal, 'account_domain', None)

    @staticmethod
    def _decode_content(args: dict, key: str, op: str) -> bytes | None:
        """Decode an optional base64 content arg into bytes (padding-tolerant)."""
        raw = args.get(key)
        if raw is None:
            return None
        if not isinstance(raw, str):
            raise ValueError(f'{op}: "{key}" must be a base64-encoded string')
        # Wrapped base64 (embedded newlines/spaces) would corrupt the padding
        # calculation; normalize all whitespace away first.
        s = ''.join(raw.split())
        try:
            return base64.b64decode(s + '=' * ((-len(s)) % 4))
        except Exception as exc:
            raise ValueError(f'{op}: "{key}" is not valid base64: {exc}') from exc

    def _require_sharing_allowed(self, args: dict) -> None:
        """Gate permission_create per the account-domain sharing rule.

        - type ``anyone``  -> always require ``allowPublicSharing``.
        - type ``domain``  -> require the flag UNLESS the target domain equals
          the account's own domain.
        - type ``user``/``group`` -> require the flag ONLY when the account
          domain is known AND the grantee's email domain differs.
        - When the account domain is UNKNOWN: anyone/domain are gated; user/group
          grants are allowed (treated as internal).

        Both public-link and external-party grants are gated by the single
        ``allowPublicSharing`` flag.
        """
        ptype = args.get('type')
        domain = self._account_domain()

        if ptype == 'anyone':
            self._access().require_flag('allowPublicSharing', 'permission_create (type=anyone, public link)')
            return

        if ptype == 'domain':
            target = str(args.get('domain') or '').strip().lower()
            if domain and target and target == domain:
                return  # sharing within the account's own domain
            self._access().require_flag('allowPublicSharing', 'permission_create (external / other-domain grant)')
            return

        if ptype in ('user', 'group'):
            if domain:  # account domain known: gate cross-domain grants
                email = str(args.get('emailAddress') or '').strip().lower()
                grantee_domain = email.rsplit('@', 1)[-1] if '@' in email else ''
                if grantee_domain and grantee_domain != domain:
                    self._access().require_flag(
                        'allowPublicSharing', 'permission_create (external grantee, different domain)'
                    )
            # Unknown account domain: user/group grants are allowed (treated internal).
            return

    def _files(self):
        return self._svc().files()

    # =======================================================================
    # DIAGNOSTICS
    # =======================================================================

    @tool_function(
        description=(
            'Check the Google Drive connection and verify that the granted OAuth scopes cover the '
            "node's configured access tier. Call this when a Drive operation fails with a scope or "
            'permission error. Returns connection_ok: true when the required scopes are present.'
        ),
        input_schema={'type': 'object', 'properties': {}, 'required': []},
    )
    def check_connection(self, args: dict) -> dict:
        """Check Drive connection status and whether granted OAuth scopes cover the access tier. Read-only."""
        return self._check_connection_impl()

    # =======================================================================
    # FILES — read
    # =======================================================================

    @tool_function(
        input_schema={
            'type': 'object',
            'properties': {
                'q': {
                    'type': 'string',
                    'description': (
                        'Optional Drive query string. Examples: '
                        '"name contains \'report\'" ; '
                        '"\'FOLDER_ID\' in parents and trashed = false" ; '
                        '"mimeType = \'application/pdf\'".'
                    ),
                },
                'pageSize': {'type': 'integer', 'description': 'Max files to return (1-100, default 25)'},
                'pageToken': {'type': 'string', 'description': 'Page token from a previous call'},
                'orderBy': {'type': 'string', 'description': 'Sort key, e.g. "modifiedTime desc" or "name"'},
                'driveId': {'type': 'string', 'description': 'Restrict to a specific shared drive id'},
                'corpora': {
                    'type': 'string',
                    'description': 'Search scope: "user", "drive" (requires driveId), "allDrives", or "domain"',
                },
            },
        },
        description=(
            'List Drive files, optionally filtered by a query "q". Searches My Drive and shared drives. '
            'Returns {files:[{id,name,description,mimeType,parents,webViewLink,modifiedTime,size,trashed,driveId}], '
            'nextPageToken}. For a required-query search use file_search.'
        ),
    )
    def file_list(self, args: dict) -> dict:
        """List Drive files (optionally filtered by a query). Read-only."""
        args = normalize_tool_input(args, tool_name='tool_drive')
        params: dict = {
            'pageSize': int_arg(args, 'pageSize', default=25, lo=1, hi=100),
            'supportsAllDrives': True,
            'includeItemsFromAllDrives': True,
            'fields': f'nextPageToken, files({_FILE_FIELDS})',
        }
        q = optional_str(args, 'q', tool_name='file_list')
        if q and q.strip():
            params['q'] = q
        page_token = optional_str(args, 'pageToken', tool_name='file_list')
        if page_token and page_token.strip():
            params['pageToken'] = page_token
        order_by = optional_str(args, 'orderBy', tool_name='file_list')
        if order_by and order_by.strip():
            params['orderBy'] = order_by
        drive_id = optional_str(args, 'driveId', tool_name='file_list')
        corpora = optional_str(args, 'corpora', tool_name='file_list')
        if drive_id and drive_id.strip():
            params['driveId'] = drive_id
            params['corpora'] = corpora.strip() if (corpora and corpora.strip()) else 'drive'
        elif corpora and corpora.strip():
            params['corpora'] = corpora.strip()
        data = execute(self._files().list(**params))
        return clean_file_list(data)

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['q'],
            'properties': {
                'q': {
                    'type': 'string',
                    'description': (
                        'Required Drive query string (Drive search syntax). Examples: '
                        '"name = \'Budget 2026\'" ; '
                        '"fullText contains \'quarterly revenue\'" ; '
                        '"mimeType = \'application/vnd.google-apps.folder\' and trashed = false".'
                    ),
                },
                'pageSize': {'type': 'integer', 'description': 'Max files to return (1-100, default 25)'},
                'pageToken': {'type': 'string', 'description': 'Page token from a previous call'},
                'orderBy': {'type': 'string', 'description': 'Sort key, e.g. "modifiedTime desc"'},
                'driveId': {'type': 'string', 'description': 'Restrict to a specific shared drive id'},
                'corpora': {'type': 'string', 'description': 'Search scope (see file_list)'},
            },
        },
        description=(
            'Search Drive files with a required query "q" (Drive query syntax). A thin wrapper over '
            'file_list that enforces a query. Use operators like contains, =, and "in parents", e.g. '
            '"name contains \'invoice\'", "\'FOLDER_ID\' in parents", "fullText contains \'contract\'".'
        ),
    )
    def file_search(self, args: dict) -> dict:
        """Search Drive files with a required query. Read-only."""
        args = normalize_tool_input(args, tool_name='tool_drive')
        require_str(args, 'q', tool_name='file_search')
        return self.file_list(args)

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['fileId'],
            'properties': {'fileId': {'type': 'string', 'description': 'The file id'}},
        },
        description=(
            "Get a single file's metadata: id, name, description, mimeType, parents, webViewLink, "
            'modifiedTime, size, trashed, driveId. Works for files in My Drive and shared drives.'
        ),
    )
    def file_get(self, args: dict) -> dict:
        """Get one file's cleaned metadata. Read-only."""
        args = normalize_tool_input(args, tool_name='tool_drive')
        fid = require_str(args, 'fileId', tool_name='file_get')
        data = execute(self._files().get(fileId=fid, supportsAllDrives=True, fields=_FILE_FIELDS))
        return clean_file(data)

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['fileId'],
            'properties': {'fileId': {'type': 'string', 'description': 'The file id to download'}},
        },
        description=(
            'Download a NON-native binary file (PDF, image, .docx, .csv, etc.) and return its bytes as '
            'base64 in {fileId, mimeType, size, data_base64}. Refuses Google-native files '
            '(Docs/Sheets/Slides, mimeType application/vnd.google-apps.*) — use file_export for those. '
            'Capped at 10 MiB; larger files raise with their size.'
        ),
    )
    def file_download(self, args: dict) -> dict:
        """Download a non-native file as base64 (10 MiB cap; native files raise). Read-only."""
        args = normalize_tool_input(args, tool_name='tool_drive')
        fid = require_str(args, 'fileId', tool_name='file_download')
        meta = execute(self._files().get(fileId=fid, supportsAllDrives=True, fields='id,name,mimeType,size'))
        mime = meta.get('mimeType')
        if isinstance(mime, str) and mime.startswith(_GOOGLE_NATIVE_PREFIX):
            raise ValueError(
                f'file_download cannot download the Google-native file {fid!r} (mimeType {mime}). '
                'Native Docs/Sheets/Slides have no binary blob — use file_export with a target '
                'mimeType (e.g. application/pdf) instead.'
            )
        size_str = meta.get('size')
        if size_str is not None:
            try:
                size_int = int(size_str)
            except (TypeError, ValueError):
                size_int = None
            if size_int is not None and size_int > _MAX_DOWNLOAD:
                raise ValueError(
                    f'file_download: {fid!r} is {size_int} bytes, over the {_MAX_DOWNLOAD}-byte (10 MiB) cap. '
                    'Fetch a smaller file, or retrieve this file out of band.'
                )
        raw = execute_media(self._files().get_media(fileId=fid, supportsAllDrives=True))
        raw = bytes(raw or b'')
        if len(raw) > _MAX_DOWNLOAD:
            raise ValueError(
                f'file_download: {fid!r} is {len(raw)} bytes, over the {_MAX_DOWNLOAD}-byte (10 MiB) cap. '
                'Fetch a smaller file, or retrieve this file out of band.'
            )
        return clean_binary(fid, mime, len(raw), base64.b64encode(raw).decode('ascii'))

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['fileId', 'mimeType'],
            'properties': {
                'fileId': {'type': 'string', 'description': 'The Google-native file id to export'},
                'mimeType': {
                    'type': 'string',
                    'description': (
                        'Export target mimeType, e.g. application/pdf, text/plain, '
                        'application/vnd.openxmlformats-officedocument.wordprocessingml.document (.docx), '
                        'text/csv (Sheets).'
                    ),
                },
            },
        },
        description=(
            'Export a Google-native file (Docs/Sheets/Slides) to a chosen format and return the bytes as '
            'base64 in {fileId, mimeType, size, data_base64}. Native files must be EXPORTED, not '
            'downloaded (use file_download for non-native binaries). The export API caps output at ~10 MiB.'
        ),
    )
    def file_export(self, args: dict) -> dict:
        """Export a Google-native file to a target format as base64. Read-only."""
        args = normalize_tool_input(args, tool_name='tool_drive')
        fid = require_str(args, 'fileId', tool_name='file_export')
        mime = require_str(args, 'mimeType', tool_name='file_export')
        raw = execute_media(self._files().export_media(fileId=fid, mimeType=mime))
        raw = bytes(raw or b'')
        return clean_binary(fid, mime, len(raw), base64.b64encode(raw).decode('ascii'))

    @tool_function(
        input_schema={
            'type': 'object',
            'properties': {
                'pageSize': {'type': 'integer', 'description': 'Max shared drives to return (1-100, default 25)'},
                'pageToken': {'type': 'string', 'description': 'Page token from a previous call'},
            },
        },
        description='List the shared drives the account can access. Returns {drives:[{id,name}], nextPageToken}.',
    )
    def drives_list(self, args: dict) -> dict:
        """List accessible shared drives. Read-only."""
        args = normalize_tool_input(args, tool_name='tool_drive')
        params: dict = {
            'pageSize': int_arg(args, 'pageSize', default=25, lo=1, hi=100),
            'fields': 'nextPageToken, drives(id,name)',
        }
        page_token = optional_str(args, 'pageToken', tool_name='drives_list')
        if page_token and page_token.strip():
            params['pageToken'] = page_token
        data = execute(self._svc().drives().list(**params))
        out: dict = {'drives': [clean_drive(d) for d in data.get('drives') or []]}
        if data.get('nextPageToken'):
            out['nextPageToken'] = data['nextPageToken']
        return out

    @tool_function(
        input_schema={
            'type': 'object',
            'properties': {
                'pageToken': {
                    'type': 'string',
                    'description': (
                        'The change page token. If omitted, this returns a startPageToken to call again with — '
                        'changes are only tracked from that token forward.'
                    ),
                },
                'driveId': {'type': 'string', 'description': 'Track changes on a specific shared drive'},
            },
        },
        description=(
            'Track file changes. Call with no pageToken first to get {startPageToken}; then call again '
            'passing it as pageToken to receive changes since then. Returns {changes:[{fileId,removed,time,'
            'file}], newStartPageToken, nextPageToken}. Save newStartPageToken for the next poll.'
        ),
    )
    def changes_list(self, args: dict) -> dict:
        """List Drive changes since a page token (bootstrapping a token when none is given). Read-only."""
        args = normalize_tool_input(args, tool_name='tool_drive')
        page_token = args.get('pageToken')
        drive_id = optional_str(args, 'driveId', tool_name='changes_list')
        if page_token is None or (isinstance(page_token, str) and not page_token.strip()):
            # Start tokens are per corpus: without driveId a shared-drive caller
            # would get a My-Drive token that the next (driveId) call rejects.
            boot_params: dict = {'supportsAllDrives': True}
            if drive_id and drive_id.strip():
                boot_params['driveId'] = drive_id
            data = execute(self._svc().changes().getStartPageToken(**boot_params))
            return {
                'startPageToken': data.get('startPageToken'),
                'message': (
                    'No pageToken was supplied. Call changes_list again with this startPageToken as '
                    '"pageToken" to fetch changes made from now on.'
                ),
            }
        if not isinstance(page_token, str):
            raise ValueError('changes_list: "pageToken" must be a string')
        params: dict = {
            'pageToken': page_token,
            'supportsAllDrives': True,
            'includeItemsFromAllDrives': True,
            'fields': f'newStartPageToken, nextPageToken, changes(fileId,removed,time,file({_FILE_FIELDS}))',
        }
        if drive_id and drive_id.strip():
            params['driveId'] = drive_id
        data = execute(self._svc().changes().list(**params))
        out: dict = {'changes': [clean_change(c) for c in data.get('changes') or []]}
        if data.get('newStartPageToken'):
            out['newStartPageToken'] = data['newStartPageToken']
        if data.get('nextPageToken'):
            out['nextPageToken'] = data['nextPageToken']
        return out

    # =======================================================================
    # FILES — write
    # =======================================================================

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['name'],
            'properties': {
                'name': {'type': 'string', 'description': 'Name for the new file'},
                'parents': {
                    'type': 'array',
                    'items': {'type': 'string'},
                    'description': 'Optional parent folder id(s) to create the file in',
                },
                'mimeType': {'type': 'string', 'description': 'Optional mimeType for the new file'},
                'description': {'type': 'string', 'description': 'Optional description for the new file'},
                'content_base64': {
                    'type': 'string',
                    'description': 'Optional base64 file content (uploaded as the file body)',
                },
            },
        },
        description=(
            'Create a new Drive file. Optionally place it in parent folder(s), set its mimeType and '
            'description, and upload base64 content as the body. Returns the cleaned file. Requires '
            'the write tier. For a folder use folder_create.'
        ),
    )
    def file_create(self, args: dict) -> dict:
        """Create a Drive file (optionally with content). Requires the write tier."""
        args = normalize_tool_input(args, tool_name='tool_drive')
        self._access().require_write('file_create')
        name = require_str(args, 'name', tool_name='file_create')
        body: dict = {'name': name}
        parents = optional_str_list(args, 'parents', tool_name='file_create')
        if parents:
            body['parents'] = parents
        mime = optional_str(args, 'mimeType', tool_name='file_create')
        if mime and mime.strip():
            body['mimeType'] = mime
        description = optional_str(args, 'description', tool_name='file_create')
        if description and description.strip():
            body['description'] = description
        content = self._decode_content(args, 'content_base64', 'file_create')
        params: dict = {'body': body, 'supportsAllDrives': True, 'fields': _FILE_FIELDS}
        if content is not None:
            from googleapiclient.http import MediaInMemoryUpload

            params['media_body'] = MediaInMemoryUpload(content, mimetype=(mime or 'application/octet-stream'))
        data = execute(self._files().create(**params))
        return clean_file(data)

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['fileId'],
            'properties': {
                'fileId': {'type': 'string', 'description': 'The file id to update'},
                'name': {'type': 'string', 'description': 'Optional new name'},
                'description': {'type': 'string', 'description': 'Optional new description'},
                'content_base64': {
                    'type': 'string',
                    'description': 'Optional base64 content that REPLACES the file body',
                },
            },
        },
        description=(
            'Update a file: rename, set its description, and/or replace its content with new base64 bytes. '
            'Returns the cleaned file. Requires the write tier.'
        ),
    )
    def file_update(self, args: dict) -> dict:
        """Update a file's name/description and optionally replace its content. Requires the write tier."""
        args = normalize_tool_input(args, tool_name='tool_drive')
        self._access().require_write('file_update')
        fid = require_str(args, 'fileId', tool_name='file_update')
        body: dict = {}
        name = optional_str(args, 'name', tool_name='file_update')
        if name and name.strip():
            body['name'] = name
        desc = optional_str(args, 'description', tool_name='file_update')
        if desc is not None:
            body['description'] = desc
        content = self._decode_content(args, 'content_base64', 'file_update')
        if not body and content is None:
            raise ValueError('file_update: provide at least one field to change')
        params: dict = {'fileId': fid, 'body': body, 'supportsAllDrives': True, 'fields': _FILE_FIELDS}
        if content is not None:
            from googleapiclient.http import MediaInMemoryUpload

            params['media_body'] = MediaInMemoryUpload(content, mimetype='application/octet-stream')
        data = execute(self._files().update(**params))
        return clean_file(data)

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['fileId'],
            'properties': {
                'fileId': {'type': 'string', 'description': 'The file id to copy'},
                'name': {'type': 'string', 'description': 'Optional name for the copy'},
                'description': {'type': 'string', 'description': 'Optional description for the copy'},
                'parents': {
                    'type': 'array',
                    'items': {'type': 'string'},
                    'description': 'Optional parent folder id(s) for the copy',
                },
            },
        },
        description=(
            'Copy a file. Optionally rename the copy, set its description, and place it in specific '
            'folder(s). Requires the write tier.'
        ),
    )
    def file_copy(self, args: dict) -> dict:
        """Copy a file. Requires the write tier."""
        args = normalize_tool_input(args, tool_name='tool_drive')
        self._access().require_write('file_copy')
        fid = require_str(args, 'fileId', tool_name='file_copy')
        body: dict = {}
        name = optional_str(args, 'name', tool_name='file_copy')
        if name and name.strip():
            body['name'] = name
        description = optional_str(args, 'description', tool_name='file_copy')
        if description and description.strip():
            body['description'] = description
        parents = optional_str_list(args, 'parents', tool_name='file_copy')
        if parents:
            body['parents'] = parents
        data = execute(self._files().copy(fileId=fid, body=body, supportsAllDrives=True, fields=_FILE_FIELDS))
        return clean_file(data)

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['fileId', 'addParents'],
            'properties': {
                'fileId': {'type': 'string', 'description': 'The file id to move'},
                'addParents': {
                    'type': 'array',
                    'items': {'type': 'string'},
                    'description': 'Destination parent folder id(s) to add',
                },
                'removeParents': {
                    'type': 'array',
                    'items': {'type': 'string'},
                    'description': "Parent id(s) to remove; defaults to the file's current parents",
                },
            },
        },
        description=(
            'Move a file to different folder(s) by adding new parents and removing old ones. If '
            "removeParents is omitted, the file's current parents are removed (a plain move). "
            'Requires the write tier.'
        ),
    )
    def file_move(self, args: dict) -> dict:
        """Move a file between folders (add/remove parents). Requires the write tier."""
        args = normalize_tool_input(args, tool_name='tool_drive')
        self._access().require_write('file_move')
        fid = require_str(args, 'fileId', tool_name='file_move')
        add_parents = optional_str_list(args, 'addParents', tool_name='file_move')
        if not add_parents:
            raise ValueError('file_move: "addParents" must be a non-empty list of destination folder id(s)')
        remove_parents = optional_str_list(args, 'removeParents', tool_name='file_move')
        if remove_parents is None:
            current = execute(self._files().get(fileId=fid, supportsAllDrives=True, fields='parents'))
            remove_parents = current.get('parents') or []
        data = execute(
            self._files().update(
                fileId=fid,
                addParents=','.join(add_parents),
                removeParents=','.join(remove_parents),
                body={},
                supportsAllDrives=True,
                fields=_FILE_FIELDS,
            )
        )
        return clean_file(data)

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['fileId'],
            'properties': {'fileId': {'type': 'string', 'description': 'The file id to move to Trash'}},
        },
        description=(
            'Move a file to Trash (recoverable). This is the safe, reversible alternative to file_delete. '
            'Requires the write tier.'
        ),
    )
    def file_trash(self, args: dict) -> dict:
        """Move a file to Trash (recoverable). Requires the write tier."""
        args = normalize_tool_input(args, tool_name='tool_drive')
        self._access().require_write('file_trash')
        fid = require_str(args, 'fileId', tool_name='file_trash')
        data = execute(
            self._files().update(fileId=fid, body={'trashed': True}, supportsAllDrives=True, fields=_FILE_FIELDS)
        )
        return clean_file(data)

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['fileId'],
            'properties': {'fileId': {'type': 'string', 'description': 'The file id to restore from Trash'}},
        },
        description='Restore a file from Trash. Requires the write tier.',
    )
    def file_untrash(self, args: dict) -> dict:
        """Restore a file from Trash. Requires the write tier."""
        args = normalize_tool_input(args, tool_name='tool_drive')
        self._access().require_write('file_untrash')
        fid = require_str(args, 'fileId', tool_name='file_untrash')
        data = execute(
            self._files().update(fileId=fid, body={'trashed': False}, supportsAllDrives=True, fields=_FILE_FIELDS)
        )
        return clean_file(data)

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['name'],
            'properties': {
                'name': {'type': 'string', 'description': 'Name for the new folder'},
                'description': {'type': 'string', 'description': 'Optional description for the new folder'},
                'parents': {
                    'type': 'array',
                    'items': {'type': 'string'},
                    'description': 'Optional parent folder id(s) to create the folder in',
                },
            },
        },
        description=(
            'Create a new folder. Optionally set its description and nest it under parent folder(s). '
            'Requires the write tier.'
        ),
    )
    def folder_create(self, args: dict) -> dict:
        """Create a folder. Requires the write tier."""
        args = normalize_tool_input(args, tool_name='tool_drive')
        self._access().require_write('folder_create')
        name = require_str(args, 'name', tool_name='folder_create')
        body: dict = {'name': name, 'mimeType': _FOLDER_MIME}
        description = optional_str(args, 'description', tool_name='folder_create')
        if description and description.strip():
            body['description'] = description
        parents = optional_str_list(args, 'parents', tool_name='folder_create')
        if parents:
            body['parents'] = parents
        data = execute(self._files().create(body=body, supportsAllDrives=True, fields=_FILE_FIELDS))
        return clean_file(data)

    # =======================================================================
    # PERMISSIONS (sharing) — write
    # =======================================================================

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['fileId'],
            'properties': {
                'fileId': {'type': 'string', 'description': 'The file id'},
                'pageToken': {'type': 'string', 'description': 'Page token from a previous call'},
            },
        },
        description=(
            'List the permissions (sharing entries) on a file: id, type, role, emailAddress, domain, '
            'allowFileDiscovery. Available at the read-only tier.'
        ),
    )
    def permission_list(self, args: dict) -> dict:
        """List a file's permissions. Read-only."""
        args = normalize_tool_input(args, tool_name='tool_drive')
        fid = require_str(args, 'fileId', tool_name='permission_list')
        params: dict = {
            'fileId': fid,
            'supportsAllDrives': True,
            'fields': f'nextPageToken, permissions({_PERM_FIELDS})',
        }
        page_token = optional_str(args, 'pageToken', tool_name='permission_list')
        if page_token and page_token.strip():
            params['pageToken'] = page_token
        data = execute(self._svc().permissions().list(**params))
        out: dict = {'permissions': [clean_permission(p) for p in data.get('permissions') or []]}
        if data.get('nextPageToken'):
            out['nextPageToken'] = data['nextPageToken']
        return out

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['fileId', 'permissionId', 'role'],
            'properties': {
                'fileId': {'type': 'string', 'description': 'The file id'},
                'permissionId': {'type': 'string', 'description': 'The permission id (from permission_list)'},
                'role': {
                    'type': 'string',
                    'enum': list(_PERM_ROLES),
                    'description': 'New role: reader, commenter, writer, fileOrganizer, organizer, or owner',
                },
            },
        },
        description='Change the role of an existing permission. Requires the write tier.',
    )
    def permission_update(self, args: dict) -> dict:
        """Update an existing permission's role. Requires the write tier."""
        args = normalize_tool_input(args, tool_name='tool_drive')
        self._access().require_write('permission_update')
        fid = require_str(args, 'fileId', tool_name='permission_update')
        pid = require_str(args, 'permissionId', tool_name='permission_update')
        role = self._enum_arg(args, 'role', _PERM_ROLES, None)
        if role is None:
            raise ValueError(f'permission_update: "role" is required, one of {list(_PERM_ROLES)}')
        # Deliberate asymmetry: updates re-run the sharing gate even when narrowing;
        # delete/revoke stays ungated so permission removal remains fail-closed.
        # Broadening an existing grant is sharing too: an ungated update could
        # widen a public/external permission the create-gate would have refused,
        # so run the same gate against the existing grantee before changing it.
        current = execute(
            self._svc().permissions().get(fileId=fid, permissionId=pid, supportsAllDrives=True, fields=_PERM_FIELDS)
        )
        self._require_sharing_allowed(
            {
                'type': current.get('type'),
                'domain': current.get('domain'),
                'emailAddress': current.get('emailAddress'),
            }
        )
        data = execute(
            self._svc()
            .permissions()
            .update(fileId=fid, permissionId=pid, body={'role': role}, supportsAllDrives=True, fields=_PERM_FIELDS)
        )
        return clean_permission(data)

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['fileId', 'permissionId'],
            'properties': {
                'fileId': {'type': 'string', 'description': 'The file id'},
                'permissionId': {'type': 'string', 'description': 'The permission id to revoke'},
            },
        },
        description='Revoke (delete) a permission, removing that access. Requires the write tier.',
    )
    def permission_delete(self, args: dict) -> dict:
        """Revoke a permission. Requires the write tier."""
        args = normalize_tool_input(args, tool_name='tool_drive')
        self._access().require_write('permission_delete')
        fid = require_str(args, 'fileId', tool_name='permission_delete')
        pid = require_str(args, 'permissionId', tool_name='permission_delete')
        execute(self._svc().permissions().delete(fileId=fid, permissionId=pid, supportsAllDrives=True))
        return {'deleted': True, 'fileId': fid, 'permissionId': pid}

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['fileId', 'type', 'role'],
            'properties': {
                'fileId': {'type': 'string', 'description': 'The file id to share'},
                'type': {
                    'type': 'string',
                    'enum': list(_PERM_TYPES),
                    'description': 'Grantee type: user, group, domain, or anyone',
                },
                'role': {
                    'type': 'string',
                    'enum': list(_PERM_ROLES),
                    'description': 'reader, commenter, writer, fileOrganizer, organizer, or owner',
                },
                'emailAddress': {'type': 'string', 'description': 'Required for type user/group'},
                'domain': {'type': 'string', 'description': 'Required for type domain'},
                'sendNotificationEmail': {
                    'type': 'boolean',
                    'description': 'For user/group grants: email the grantee (default true; always sent)',
                },
            },
        },
        description=(
            'Grant access to a file. GATED sharing: a grant to type "anyone" (public link) or to a domain '
            "or user OUTSIDE the account's own domain requires the node's allowPublicSharing flag to be on; "
            'same-domain and internal user/group grants are always allowed. When the account domain is '
            'unknown, anyone/domain grants are gated and user/group grants are treated as internal. '
            'user/group grants always send a notification email by default. Requires the write tier.'
        ),
    )
    def permission_create(self, args: dict) -> dict:
        """Grant access to a file (gated for public / external sharing). Requires the write tier."""
        args = normalize_tool_input(args, tool_name='tool_drive')
        # require_write FIRST, then the sharing gate.
        self._access().require_write('permission_create')
        fid = require_str(args, 'fileId', tool_name='permission_create')
        ptype = self._enum_arg(args, 'type', _PERM_TYPES, None)
        if ptype is None:
            raise ValueError(f'permission_create: "type" is required, one of {list(_PERM_TYPES)}')
        role = self._enum_arg(args, 'role', _PERM_ROLES, None)
        if role is None:
            raise ValueError(f'permission_create: "role" is required, one of {list(_PERM_ROLES)}')
        body: dict = {'type': ptype, 'role': role}
        if ptype in ('user', 'group'):
            body['emailAddress'] = require_str(args, 'emailAddress', tool_name='permission_create')
        elif ptype == 'domain':
            body['domain'] = require_str(args, 'domain', tool_name='permission_create')

        # Sharing gate: reads the (validated) type/domain/emailAddress.
        self._require_sharing_allowed(args)

        params: dict = {'fileId': fid, 'body': body, 'supportsAllDrives': True, 'fields': _PERM_FIELDS}
        if ptype in ('user', 'group'):
            # Documented default true, always sent explicitly.
            send = args.get('sendNotificationEmail')
            params['sendNotificationEmail'] = send if isinstance(send, bool) else True
        # anyone/domain grants: Drive only accepts sendNotificationEmail for
        # user/group; the key is omitted entirely for other types.
        data = execute(self._svc().permissions().create(**params))
        return clean_permission(data)

    # =======================================================================
    # GATED — permanent delete
    # =======================================================================

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['fileId'],
            'properties': {'fileId': {'type': 'string', 'description': 'The file id to permanently delete'}},
        },
        description=(
            'PERMANENTLY delete a file, bypassing Trash. This is IRREVERSIBLE. Requires the write tier AND '
            "the node's allowHardDelete flag. Prefer file_trash (recoverable) unless permanent deletion is "
            'explicitly required.'
        ),
    )
    def file_delete(self, args: dict) -> dict:
        """Permanently delete a file, bypassing Trash (irreversible). Requires write + allowHardDelete."""
        args = normalize_tool_input(args, tool_name='tool_drive')
        self._access().require_write('file_delete')
        self._access().require_flag('allowHardDelete', 'file_delete')
        fid = require_str(args, 'fileId', tool_name='file_delete')
        execute(self._files().delete(fileId=fid, supportsAllDrives=True))
        return {'deleted': True, 'fileId': fid, 'permanent': True}
