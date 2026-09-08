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

"""File tools: upload, link, download and manage attachments."""

from __future__ import annotations

import base64

from ..pipedrive_client import clean_file
from ..tool_groups import pipedrive_tool
from ._base import (
    ENUM,
    INT,
    PAGING,
    STR,
    PipedriveToolsBase,
    args_of,
    body_from,
    params_from,
    require_id,
    require_text,
    schema,
)

_ATTACH_KEYS = ('deal_id', 'person_id', 'org_id', 'product_id', 'activity_id', 'lead_id')

_ATTACH_PROPS = {
    'deal_id': INT('Attach the file to this deal.'),
    'person_id': INT('Attach the file to this person.'),
    'org_id': INT('Attach the file to this organization.'),
    'product_id': INT('Attach the file to this product.'),
    'activity_id': INT('Attach the file to this activity.'),
    'lead_id': STR('Attach the file to this lead uuid.'),
}


#: /files documents a maximum ``limit`` of 100, below the 500 the other v1
#: collections accept — asking for more is rejected rather than clamped.
_FILES_MAX_LIMIT = 100


class FilesMixin(PipedriveToolsBase):
    """Tools for the ``files`` group."""

    @pipedrive_tool(
        group='files',
        input_schema=schema(sort=STR('Sort clause, e.g. "update_time DESC".'), **PAGING(_FILES_MAX_LIMIT)),
        description='List files stored in Pipedrive.',
    )
    def file_list(self, args):
        args = args_of(args)
        return self._list('/files', args, clean_file, extra=params_from(args, ('sort',)), max_limit=_FILES_MAX_LIMIT)

    @pipedrive_tool(
        group='files',
        input_schema=schema(required=['file_id'], file_id=INT('File id.')),
        description='Get the metadata of a single file.',
    )
    def file_get(self, args):
        args = args_of(args)
        return self._get(f'/files/{require_id(args, "file_id", "file_get")}', clean_file)

    @pipedrive_tool(
        group='files',
        input_schema=schema(
            required=['file_name', 'content_base64'],
            file_name=STR('Name to store the file under, including the extension.'),
            content_base64=STR('File contents, base64-encoded.'),
            **_ATTACH_PROPS,
        ),
        description='Upload a file and attach it to a deal, person, organization, product, activity or lead.',
    )
    def file_create(self, args):
        args = args_of(args)
        self._require_write()
        file_name = require_text(args, 'file_name', 'file_create')
        content_b64 = require_text(args, 'content_base64', 'file_create')
        try:
            content = base64.b64decode(content_b64, validate=True)
        except Exception as exc:
            raise ValueError('file_create: "content_base64" is not valid base64') from exc
        form = {k: args[k] for k in _ATTACH_KEYS if args.get(k) is not None}
        files = {'file': (file_name, content)}
        return clean_file(self._call('POST', '/files', form=form, files=files))

    @pipedrive_tool(
        group='files',
        input_schema=schema(
            required=['file_type', 'title', 'item_type', 'item_id', 'remote_location'],
            file_type=ENUM('Type of remote document to create.', ['gdoc', 'gslides', 'gsheet', 'gform', 'gdraw']),
            title=STR('Title of the new remote document.'),
            item_type=ENUM('Record the file is attached to.', ['deal', 'organization', 'person']),
            item_id=INT('Id of the record the file is attached to.'),
            remote_location=ENUM('Remote storage provider.', ['googledrive']),
        ),
        description='Create a new empty remote document (Google Drive) and attach it to a record.',
    )
    def file_create_remote(self, args):
        args = args_of(args)
        self._require_write()
        for key in ('file_type', 'title', 'item_type', 'remote_location'):
            require_text(args, key, 'file_create_remote')
        require_id(args, 'item_id', 'file_create_remote')
        form = body_from(args, ('file_type', 'title', 'item_type', 'item_id', 'remote_location'))
        return clean_file(self._call('POST', '/files/remote', form=form))

    @pipedrive_tool(
        group='files',
        input_schema=schema(
            required=['item_type', 'item_id', 'remote_id', 'remote_location'],
            item_type=ENUM('Record the file is attached to.', ['deal', 'organization', 'person']),
            item_id=INT('Id of the record the file is attached to.'),
            remote_id=STR('Id of the existing remote file.'),
            remote_location=ENUM('Remote storage provider.', ['googledrive']),
        ),
        description='Link an existing remote file (Google Drive) to a record.',
    )
    def file_link_remote(self, args):
        args = args_of(args)
        self._require_write()
        for key in ('item_type', 'remote_id', 'remote_location'):
            require_text(args, key, 'file_link_remote')
        require_id(args, 'item_id', 'file_link_remote')
        form = body_from(args, ('item_type', 'item_id', 'remote_id', 'remote_location'))
        return clean_file(self._call('POST', '/files/remoteLink', form=form))

    @pipedrive_tool(
        group='files',
        input_schema=schema(
            required=['file_id'],
            file_id=INT('File id to update.'),
            name=STR('New file name.'),
            description=STR('New description.'),
        ),
        description='Rename a file or change its description.',
    )
    def file_update(self, args):
        args = args_of(args)
        file_id = require_id(args, 'file_id', 'file_update')
        return self._write('PUT', f'/files/{file_id}', clean_file, body=body_from(args, ('name', 'description')))

    @pipedrive_tool(
        group='files',
        input_schema=schema(required=['file_id'], file_id=INT('File id to delete.')),
        description='Delete a file.',
    )
    def file_delete(self, args):
        args = args_of(args)
        return self._delete(f'/files/{require_id(args, "file_id", "file_delete")}')

    @pipedrive_tool(
        group='files',
        input_schema=schema(
            required=['file_id'],
            file_id=INT('File id to download.'),
            as_text=STR('Set to "1" to decode the file as UTF-8 text instead of returning base64.'),
        ),
        description='Download a file. Returns base64 content by default, or decoded text with as_text="1".',
    )
    def file_download(self, args):
        args = args_of(args)
        file_id = require_id(args, 'file_id', 'file_download')
        content = self._call('GET', f'/files/{file_id}/download', raw=True)
        if not isinstance(content, (bytes, bytearray)):
            return {'file_id': file_id, 'content': content}
        if str(args.get('as_text', '')) == '1':
            return {'file_id': file_id, 'text': content.decode('utf-8', errors='replace')}
        return {
            'file_id': file_id,
            'size': len(content),
            'content_base64': base64.b64encode(content).decode('ascii'),
        }
