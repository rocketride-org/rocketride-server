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
OneDrive tool node instance.

Exposes the Microsoft Graph drive API as agent tools: list and search items,
read metadata, download and upload content, create folders, copy/move/rename,
trash/restore, and manage sharing (links and permission grants). Write
operations require the ``write`` tier; anonymous sharing links require the
``allowPublicSharing`` gate, invites require every recipient to resolve to an
individual directory user unless ``allowPublicSharing`` is on, and permanent
delete requires the ``allowHardDelete`` gate.

Operational targets (item path/id, folder, permission id) are always
invoke-time parameters — never node config.
"""

from __future__ import annotations

import urllib.parse

import base64
import binascii

from rocketlib import tool_function

from ai.common.utils import normalize_tool_input, optional_str, require_str, require_str_list

from .. import graph_client
from ..IInstance import MicrosoftToolInstanceBase
from .client import (
    CHUNK_SIZE,
    DOWNLOAD_INLINE_LIMIT,
    SERVICE,
    SIMPLE_UPLOAD_LIMIT,
    _seg,
    clean_item,
    clean_permission,
    it,
    parent_ref,
    request,
    upload_chunk,
)
from .IGlobal import IGlobal


class IInstance(MicrosoftToolInstanceBase):
    IGlobal: IGlobal
    SERVICE = SERVICE

    # -----------------------------------------------------------------------
    # Helpers
    # -----------------------------------------------------------------------

    def _base(self) -> str:
        return graph_client.user_base(self.IGlobal.cfg)

    def _it(self, item: str) -> str:
        return it(self._base(), item)

    def _chunked_upload(self, path: str, content: bytes) -> dict:
        """Resumable upload: create a session, then PUT CHUNK_SIZE-byte pieces."""
        session = request(
            self.IGlobal.auth,
            'POST',
            f'{self._base()}/drive/root:/{urllib.parse.quote(path, safe=chr(47))}:/createUploadSession',
            json_body={'item': {'@microsoft.graph.conflictBehavior': 'replace'}},
        )
        upload_url = session.get('uploadUrl')
        if not upload_url:
            raise graph_client.GraphError('onedrive_upload: createUploadSession returned no uploadUrl')
        total = len(content)
        result: dict = {}
        for start in range(0, total, CHUNK_SIZE):
            end = min(start + CHUNK_SIZE, total) - 1
            result = upload_chunk(self.IGlobal.auth, upload_url, content[start : end + 1], start, end, total)
        return result

    def _require_individual_directory_user(self, email: str) -> None:
        """Fail closed unless ``email`` resolves to an individual directory user.

        Looked up via ``GET /users/{email}?$select=id`` — a directory lookup
        under GRAPH_BASE, not the acting user's drive. Only ``id`` is selected:
        it is within the ``User.ReadBasic.All`` property set (``userType`` is
        not, and would turn the lookup into a 403 under that scope). Any failure
        (404 = not a user, e.g. a distribution list; 403 = missing lookup
        permission; anything else) refuses the invite rather than guessing.
        """
        try:
            request(self.IGlobal.auth, 'GET', f'/users/{_seg(email)}', params={'$select': 'id'})
        except Exception as exc:
            is_permission_error = isinstance(exc, graph_client.GraphError) and 'access denied' in str(exc)
            hint = (
                'grant a directory-read scope (User.ReadBasic.All delegated / User.Read.All application) '
                'to look up recipients'
                if is_permission_error
                else 'enable onedrive.allowPublicSharing to allow unrestricted invites'
            )
            raise graph_client.GraphError(
                f"onedrive_invite: recipient '{email}' does not resolve to an individual directory user "
                f'({exc}). With allowPublicSharing off, invites are only allowed to addresses that resolve '
                f'to individual directory users (distribution lists and unresolvable addresses are '
                f'refused); {hint}.'
            ) from exc

    # =======================================================================
    # DIAGNOSTICS
    # =======================================================================

    @tool_function(
        description=(
            'Check the OneDrive/Graph connection and verify that the granted OAuth scopes cover the '
            "node's configured access tier. Call this when a OneDrive operation fails with a scope or "
            'permission error. Returns connection_ok: true when the required scopes are present.'
        ),
        input_schema={'type': 'object', 'properties': {}, 'required': []},
    )
    def onedrive_check_connection(self, args: dict) -> dict:
        """Check the OneDrive connection and whether granted OAuth scopes cover the access tier. Read-only."""
        base = self._base()

        def _probe(auth):
            request(auth, 'GET', f'{base}/drive')

        return self._check_connection_impl(probe=_probe)

    # =======================================================================
    # READ — list, search, metadata, download
    # =======================================================================

    @tool_function(
        input_schema={
            'type': 'object',
            'properties': {
                'folder': {
                    'type': 'string',
                    'description': "Path (e.g. 'Reports') or item id of the folder to list; empty/omitted lists the drive root",
                },
            },
        },
        description='List the items (files and folders) directly inside a OneDrive folder. Returns each item id, name, size, webUrl, folder/file marker, and lastModifiedDateTime.',
    )
    def onedrive_list_items(self, args: dict) -> dict:
        """List the items directly inside a OneDrive folder (root by default). Read-only."""
        args = normalize_tool_input(args, tool_name='tool_onedrive')
        folder = optional_str(args, 'folder', default='', tool_name='onedrive_list_items') or ''
        data = request(self.IGlobal.auth, 'GET', f'{self._it(folder)}/children')  # '' -> drive root
        return {'items': [clean_item(i) for i in data.get('value') or []]}

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['query'],
            'properties': {
                'query': {'type': 'string', 'description': 'Search text (file/folder name or content match)'},
            },
        },
        description="Search the acting user's OneDrive by name/content. Returns matching items.",
    )
    def onedrive_search(self, args: dict) -> dict:
        """Search OneDrive by name/content. Read-only."""
        args = normalize_tool_input(args, tool_name='tool_onedrive')
        query = require_str(args, 'query', tool_name='onedrive_search')
        path = f"{self._base()}/drive/root/search(q='{_seg(query)}')"
        data = request(self.IGlobal.auth, 'GET', path)
        return {'items': [clean_item(i) for i in data.get('value') or []]}

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['item'],
            'properties': {
                'item': {'type': 'string', 'description': "Path (e.g. 'Docs/a.pdf') or drive item id"},
            },
        },
        description='Get metadata for a OneDrive item (file or folder): id, name, size, webUrl, folder/file marker, lastModifiedDateTime, and parent path.',
    )
    def onedrive_get_metadata(self, args: dict) -> dict:
        """Get metadata for a OneDrive item. Read-only."""
        args = normalize_tool_input(args, tool_name='tool_onedrive')
        item = require_str(args, 'item', tool_name='onedrive_get_metadata')
        data = request(self.IGlobal.auth, 'GET', self._it(item))
        return clean_item(data)

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['item'],
            'properties': {
                'item': {'type': 'string', 'description': "Path (e.g. 'Docs/a.pdf') or drive item id"},
            },
        },
        description=(
            "Download a OneDrive file's content. Files at or under 1 MiB are returned inline as "
            '{name, content_base64}. Larger files return {downloadUrl}: a short-lived, pre-authenticated '
            'URL the caller fetches directly rather than round-tripping the bytes through the agent.'
        ),
    )
    def onedrive_download(self, args: dict) -> dict:
        """Download a OneDrive file's content (inline base64, or a downloadUrl for larger files). Read-only."""
        args = normalize_tool_input(args, tool_name='tool_onedrive')
        item = require_str(args, 'item', tool_name='onedrive_download')
        item_path = self._it(item)
        meta = request(self.IGlobal.auth, 'GET', item_path)
        size = meta.get('size') or 0
        if size > DOWNLOAD_INLINE_LIMIT:
            download_url = meta.get('@microsoft.graph.downloadUrl')
            if not download_url:
                raise graph_client.GraphError('onedrive_download: item metadata has no @microsoft.graph.downloadUrl')
            return {'downloadUrl': download_url}
        raw = request(self.IGlobal.auth, 'GET', f'{item_path}/content', binary=True)
        return {'name': meta.get('name'), 'content_base64': base64.b64encode(raw).decode('ascii')}

    # =======================================================================
    # WRITE — upload, folders, copy/move/rename
    # =======================================================================

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['path', 'content_base64'],
            'properties': {
                'path': {'type': 'string', 'description': "Destination path, e.g. 'Reports/q3.pdf'"},
                'content_base64': {'type': 'string', 'description': 'File content, base64-encoded'},
            },
        },
        description=(
            'Upload (or overwrite) a file at a OneDrive path from base64-encoded content. Files at or '
            'under 4 MB upload in a single request; larger files use a chunked resumable upload session. '
            'Requires the write tier.'
        ),
    )
    def onedrive_upload(self, args: dict) -> dict:
        """Upload/overwrite a file at a OneDrive path from base64 content. Requires the write tier."""
        args = normalize_tool_input(args, tool_name='tool_onedrive')
        self.IGlobal.access.require_write('onedrive_upload')
        path = require_str(args, 'path', tool_name='onedrive_upload')
        content_b64 = require_str(args, 'content_base64', tool_name='onedrive_upload')
        try:
            content = base64.b64decode(content_b64, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise ValueError(f'onedrive_upload: "content_base64" is not valid base64 ({exc})') from exc
        if len(content) <= SIMPLE_UPLOAD_LIMIT:
            data = request(
                self.IGlobal.auth,
                'PUT',
                f'{self._base()}/drive/root:/{urllib.parse.quote(path, safe=chr(47))}:/content',
                data=content,
                content_type='application/octet-stream',
            )
            return clean_item(data)
        result = self._chunked_upload(path, content)
        if 'id' in result:
            return clean_item(result)
        return {'uploaded': True, 'path': path, 'size': len(content)}

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['parent', 'name'],
            'properties': {
                'parent': {'type': 'string', 'description': "Parent folder path (e.g. 'Reports') or item id"},
                'name': {'type': 'string', 'description': 'Name for the new folder'},
            },
        },
        description='Create a new folder inside a parent OneDrive folder. Fails if a same-named item already exists there. Requires the write tier.',
    )
    def onedrive_create_folder(self, args: dict) -> dict:
        """Create a new folder inside a parent OneDrive folder. Requires the write tier."""
        args = normalize_tool_input(args, tool_name='tool_onedrive')
        self.IGlobal.access.require_write('onedrive_create_folder')
        parent = require_str(args, 'parent', tool_name='onedrive_create_folder')
        name = require_str(args, 'name', tool_name='onedrive_create_folder')
        data = request(
            self.IGlobal.auth,
            'POST',
            f'{self._it(parent)}/children',
            json_body={'name': name, 'folder': {}, '@microsoft.graph.conflictBehavior': 'fail'},
        )
        return clean_item(data)

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['item', 'target_folder'],
            'properties': {
                'item': {'type': 'string', 'description': 'Path or item id of the file/folder to copy'},
                'target_folder': {'type': 'string', 'description': 'Destination folder path or item id'},
                'new_name': {'type': 'string', 'description': 'Optional new name for the copy'},
            },
        },
        description=(
            'Copy a file or folder into another folder, optionally renaming the copy. Graph runs copies '
            'asynchronously; this returns once the copy is accepted, not once it completes. Requires the write tier.'
        ),
    )
    def onedrive_copy(self, args: dict) -> dict:
        """Copy an item into another folder, optionally renaming it. Requires the write tier."""
        args = normalize_tool_input(args, tool_name='tool_onedrive')
        self.IGlobal.access.require_write('onedrive_copy')
        item = require_str(args, 'item', tool_name='onedrive_copy')
        target_folder = require_str(args, 'target_folder', tool_name='onedrive_copy')
        new_name = optional_str(args, 'new_name', default='', tool_name='onedrive_copy') or ''
        body: dict = {'parentReference': parent_ref(target_folder)}
        if new_name:
            body['name'] = new_name
        request(self.IGlobal.auth, 'POST', f'{self._it(item)}/copy', json_body=body)
        return {'accepted': True, 'item': item, 'target_folder': target_folder, 'new_name': new_name or None}

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['item', 'target_folder'],
            'properties': {
                'item': {'type': 'string', 'description': 'Path or item id of the file/folder to move'},
                'target_folder': {'type': 'string', 'description': 'Destination folder path or item id'},
            },
        },
        description='Move a file or folder into another folder. Returns the updated item. Requires the write tier.',
    )
    def onedrive_move(self, args: dict) -> dict:
        """Move an item into another folder. Requires the write tier."""
        args = normalize_tool_input(args, tool_name='tool_onedrive')
        self.IGlobal.access.require_write('onedrive_move')
        item = require_str(args, 'item', tool_name='onedrive_move')
        target_folder = require_str(args, 'target_folder', tool_name='onedrive_move')
        data = request(
            self.IGlobal.auth, 'PATCH', self._it(item), json_body={'parentReference': parent_ref(target_folder)}
        )
        return clean_item(data)

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['item', 'new_name'],
            'properties': {
                'item': {'type': 'string', 'description': 'Path or item id of the file/folder to rename'},
                'new_name': {'type': 'string', 'description': 'New name for the item'},
            },
        },
        description='Rename a file or folder in place. Returns the updated item. Requires the write tier.',
    )
    def onedrive_rename(self, args: dict) -> dict:
        """Rename a file or folder in place. Requires the write tier."""
        args = normalize_tool_input(args, tool_name='tool_onedrive')
        self.IGlobal.access.require_write('onedrive_rename')
        item = require_str(args, 'item', tool_name='onedrive_rename')
        new_name = require_str(args, 'new_name', tool_name='onedrive_rename')
        data = request(self.IGlobal.auth, 'PATCH', self._it(item), json_body={'name': new_name})
        return clean_item(data)

    # =======================================================================
    # TRASH / RESTORE / PERMANENT DELETE
    # =======================================================================

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['item'],
            'properties': {
                'item': {'type': 'string', 'description': 'Path or item id of the file/folder to trash'},
            },
        },
        description=(
            "Move a file or folder to OneDrive's recycle bin. Requires the write tier. Recoverable via "
            'onedrive_restore on OneDrive Personal only; on work/school accounts restore it from the recycle '
            'bin in the OneDrive web UI.'
        ),
    )
    def onedrive_trash(self, args: dict) -> dict:
        """Move an item to the recycle bin. Requires the write tier."""
        args = normalize_tool_input(args, tool_name='tool_onedrive')
        self.IGlobal.access.require_write('onedrive_trash')
        item = require_str(args, 'item', tool_name='onedrive_trash')
        request(self.IGlobal.auth, 'DELETE', self._it(item))
        return {'trashed': item}

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['item'],
            'properties': {
                'item': {'type': 'string', 'description': 'Item id of the trashed file/folder to restore'},
            },
        },
        description=(
            'Restore a previously trashed file or folder back to its original location. Requires the write '
            'tier. Graph only supports restore for OneDrive Personal (personal Microsoft account) drives: '
            'it is unavailable under Entra app (service) auth and for work/school accounts.'
        ),
    )
    def onedrive_restore(self, args: dict) -> dict:
        """Restore a trashed item. Requires the write tier; OneDrive Personal only.

        ``POST /drive/items/{id}/restore`` is documented by Microsoft as
        available only for OneDrive Personal. App-only (service) auth can
        never act on a personal account, so it is refused up front with a
        clear message; a work/school user-OAuth account surfaces Graph's own
        error instead, since the account type is not knowable from config.
        """
        args = normalize_tool_input(args, tool_name='tool_onedrive')
        self.IGlobal.access.require_write('onedrive_restore')
        item = require_str(args, 'item', tool_name='onedrive_restore')
        if self._base() != '/me':
            raise graph_client.GraphError(
                'onedrive_restore: Graph supports restoring trashed items only for OneDrive Personal '
                '(personal Microsoft accounts); it is unavailable under Entra app (service) authentication. '
                'Restore the item from the OneDrive recycle bin in the web UI instead.'
            )
        data = request(self.IGlobal.auth, 'POST', f'{self._base()}/drive/items/{_seg(item)}/restore')
        return clean_item(data)

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['item'],
            'properties': {
                'item': {'type': 'string', 'description': 'Path or item id of the file/folder to permanently delete'},
            },
        },
        description=(
            'Permanently delete a file or folder, bypassing the recycle bin — irreversible. Requires the '
            "write tier and the node's allowHardDelete flag; onedrive_trash is the recoverable alternative."
        ),
    )
    def onedrive_permanently_delete(self, args: dict) -> dict:
        """Permanently delete an item, bypassing the recycle bin. Requires write + allowHardDelete."""
        args = normalize_tool_input(args, tool_name='tool_onedrive')
        self.IGlobal.access.require_write('onedrive_permanently_delete')
        item = require_str(args, 'item', tool_name='onedrive_permanently_delete')
        self.IGlobal.access.require_flag('allowHardDelete', 'onedrive_permanently_delete')
        request(self.IGlobal.auth, 'POST', f'{self._it(item)}/permanentDelete')
        return {'permanentlyDeleted': item}

    # =======================================================================
    # SHARING — links, permissions, invites
    # =======================================================================

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['item'],
            'properties': {
                'item': {'type': 'string', 'description': 'Path or item id of the file/folder to share'},
                'link_type': {
                    'type': 'string',
                    'description': "'view' (default), 'edit', or 'embed'",
                },
                'scope': {
                    'type': 'string',
                    'description': "'organization' (default, anyone in the tenant), 'anonymous' (anyone with the link), or 'users'",
                },
            },
        },
        description=(
            'Create a sharing link for a file or folder. A scope of "anonymous" (anyone with the link, no '
            "sign-in required) additionally requires the node's allowPublicSharing flag. Requires the write tier."
        ),
    )
    def onedrive_create_sharing_link(self, args: dict) -> dict:
        """Create a sharing link for an item. scope='anonymous' requires write + allowPublicSharing."""
        args = normalize_tool_input(args, tool_name='tool_onedrive')
        self.IGlobal.access.require_write('onedrive_create_sharing_link')
        item = require_str(args, 'item', tool_name='onedrive_create_sharing_link')
        link_type = self._enum_arg(args, 'link_type', ('view', 'edit', 'embed'), 'view')
        scope = self._enum_arg(args, 'scope', ('anonymous', 'organization', 'users'), 'organization')
        if scope == 'anonymous':
            self.IGlobal.access.require_flag('allowPublicSharing', 'onedrive_create_sharing_link (scope=anonymous)')
        data = request(
            self.IGlobal.auth, 'POST', f'{self._it(item)}/createLink', json_body={'type': link_type, 'scope': scope}
        )
        return {'id': data.get('id'), 'link': data.get('link') or {}}

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['item'],
            'properties': {
                'item': {'type': 'string', 'description': 'Path or item id of the file/folder'},
            },
        },
        description='List the sharing permissions (links and user/group grants) on a file or folder.',
    )
    def onedrive_list_permissions(self, args: dict) -> dict:
        """List the sharing permissions on an item. Read-only."""
        args = normalize_tool_input(args, tool_name='tool_onedrive')
        item = require_str(args, 'item', tool_name='onedrive_list_permissions')
        data = request(self.IGlobal.auth, 'GET', f'{self._it(item)}/permissions')
        return {'permissions': [clean_permission(p) for p in data.get('value') or []]}

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['item', 'emails'],
            'properties': {
                'item': {'type': 'string', 'description': 'Path or item id of the file/folder to share'},
                'emails': {
                    'type': 'array',
                    'items': {'type': 'string'},
                    'description': 'Recipient email addresses (must be non-empty)',
                },
                'role': {'type': 'string', 'description': "'read' (default) or 'write'"},
                'message': {'type': 'string', 'description': 'Optional message included in the invitation email'},
            },
        },
        description=(
            "Grant access to a file or folder by inviting specific people by email. When the node's "
            'allowPublicSharing flag is off (the default), every recipient is looked up in the directory '
            'and must resolve to an individual user — distribution lists and unresolvable addresses are '
            'refused, and the whole invite is refused if any one recipient fails the check. Turn on '
            'allowPublicSharing to skip the lookup and invite any address. Requires the write tier.'
        ),
    )
    def onedrive_invite(self, args: dict) -> dict:
        """Invite people by email to access an item. With allowPublicSharing off, every recipient must
        resolve to an individual directory user. Requires the write tier.
        """
        args = normalize_tool_input(args, tool_name='tool_onedrive')
        self.IGlobal.access.require_write('onedrive_invite')
        item = require_str(args, 'item', tool_name='onedrive_invite')
        emails = require_str_list(args, 'emails', tool_name='onedrive_invite')
        role = self._enum_arg(args, 'role', ('read', 'write'), 'read')
        message = optional_str(args, 'message', default='', tool_name='onedrive_invite') or ''
        if not self.IGlobal.access.flags.get('allowPublicSharing', False):
            for email in emails:
                self._require_individual_directory_user(email)
        data = request(
            self.IGlobal.auth,
            'POST',
            f'{self._it(item)}/invite',
            json_body={
                'recipients': [{'email': e} for e in emails],
                'message': message,
                'requireSignIn': True,
                'sendInvitation': True,
                'roles': [role],
            },
        )
        return {'permissions': [clean_permission(p) for p in data.get('value') or []]}

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['item', 'permission_id'],
            'properties': {
                'item': {'type': 'string', 'description': 'Path or item id of the file/folder'},
                'permission_id': {'type': 'string', 'description': 'Permission id (from onedrive_list_permissions)'},
            },
        },
        description='Revoke a sharing permission (link or user/group grant) from a file or folder. Requires the write tier.',
    )
    def onedrive_delete_permission(self, args: dict) -> dict:
        """Revoke a sharing permission from an item. Requires the write tier."""
        args = normalize_tool_input(args, tool_name='tool_onedrive')
        self.IGlobal.access.require_write('onedrive_delete_permission')
        item = require_str(args, 'item', tool_name='onedrive_delete_permission')
        permission_id = require_str(args, 'permission_id', tool_name='onedrive_delete_permission')
        request(self.IGlobal.auth, 'DELETE', f'{self._it(item)}/permissions/{_seg(permission_id)}')
        return {'deleted': permission_id}
