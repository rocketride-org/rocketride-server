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
Supabase Storage: agent tools.

Seven tools over buckets and files. Reads (``list_buckets``, ``list_files``,
``download_file``, ``create_signed_url``) need the ``read`` access level,
``upload_file`` needs ``write``, and ``create_bucket`` and ``delete_file``
need ``admin``.

Size rules (from the node settings):

* ``download_file`` returns the content inline (text or base64) only up to
  the inline limit (256 KB by default). A larger file comes back as a signed
  URL instead, and the result says so.
* ``upload_file`` refuses content above the upload limit (10 MB by default)
  before anything is sent.

Bucket names and object paths are checked here, before any call: no empty
names, no ``.``/``..`` segments, no empty segments, no backslashes and no
control characters, so a path always names exactly the object it reads.
Nothing is written to local disk.
"""

from __future__ import annotations

import base64
import binascii
import mimetypes
from typing import Any, Dict, List, Optional
from urllib.parse import quote

from rocketlib import tool_function

from ai.common.utils import int_arg, optional_bool, optional_str, require_str, require_str_list

from ..IInstance import ADMIN, READ, WRITE, SupabaseInstanceBase, requires_access
from .IGlobal import SIGNED_URL_SECONDS_MAX, SIGNED_URL_SECONDS_MIN, IGlobal

ENCODINGS = ('text', 'base64')

# Storage API limits: bucket names up to 100 characters, object keys up to
# 1024, and at most 1000 objects per delete request.
_MAX_BUCKET_LENGTH = 100
_MAX_PATH_LENGTH = 1024
_MAX_DELETE_PATHS = 1000

_BUCKET_FIELDS = ('id', 'name', 'public', 'created_at', 'updated_at', 'file_size_limit', 'allowed_mime_types')


def _has_control_chars(text: str) -> bool:
    return any(ord(ch) < 32 or ord(ch) == 127 for ch in text)


def _object_path(bucket: str, path: str) -> str:
    """The Storage API path that downloads an object with the secret key (as storage3's download)."""
    segments = [bucket, *path.split('/')]
    return '/storage/v1/object/' + '/'.join(quote(segment, safe='') for segment in segments)


class IInstance(SupabaseInstanceBase):
    """Node instance exposing Supabase Storage buckets and files as agent tools."""

    IGlobal: IGlobal

    # ------------------------------------------------------------------
    # Input checks
    # ------------------------------------------------------------------

    def _bucket(self, args: Dict[str, Any], tool_name: str, key: str = 'bucket') -> str:
        """A bucket name: non-empty, no '/', no control characters, at most 100 characters."""
        bucket = require_str(args, key, tool_name=tool_name)
        if (
            '/' in bucket
            or '\\' in bucket
            or bucket in ('.', '..')
            or _has_control_chars(bucket)
            or len(bucket) > _MAX_BUCKET_LENGTH
        ):
            raise ValueError(
                f'{tool_name}: "{key}" must be a bucket name (no "/" or "\\", not "." or "..", '
                f'at most {_MAX_BUCKET_LENGTH} characters)'
            )
        return bucket

    def _check_path(self, path: str, tool_name: str, key: str) -> str:
        """Refuse a path that would not name exactly one object."""
        problem = ''
        if path.startswith('/'):
            problem = 'must be relative to the bucket (no leading "/")'
        elif '\\' in path:
            problem = 'must use "/" as the separator, not "\\"'
        elif _has_control_chars(path):
            problem = 'must not contain control characters'
        elif len(path) > _MAX_PATH_LENGTH:
            problem = f'must be at most {_MAX_PATH_LENGTH} characters'
        elif any(segment in ('', '.', '..') for segment in path.split('/')):
            problem = 'must not contain empty, "." or ".." segments'
        if problem:
            raise ValueError(f'{tool_name}: "{key}" {problem}')
        return path

    def _path(self, args: Dict[str, Any], tool_name: str, key: str = 'path') -> str:
        """A required object path inside the bucket, e.g. "reports/2026/q1.pdf"."""
        return self._check_path(require_str(args, key, tool_name=tool_name), tool_name, key)

    def _prefix(self, args: Dict[str, Any], tool_name: str) -> str:
        """An optional folder inside the bucket ('' = the bucket root). A trailing '/' is allowed."""
        prefix = optional_str(args, 'prefix', default='', tool_name=tool_name).strip()
        prefix = prefix.rstrip('/')
        if not prefix:
            return ''
        return self._check_path(prefix, tool_name, 'prefix')

    def _bucket_api(self, bucket: str) -> Any:
        return self._client().storage.from_(bucket)

    # ------------------------------------------------------------------
    # Read tools
    # ------------------------------------------------------------------

    @tool_function(
        input_schema={'type': 'object', 'properties': {}},
        output_schema={
            'type': 'object',
            'properties': {
                'buckets': {'type': 'array', 'items': {'type': 'object'}},
                'count': {'type': 'integer'},
                'truncated': {'type': 'boolean'},
            },
        },
        description=(
            'List the storage buckets of the project. No arguments. Needs the read access level. Returns '
            'buckets (id, name, public, created_at, updated_at, file_size_limit, allowed_mime_types), count, '
            'and truncated (true when there were more buckets than the node list limit, 100 unless changed).'
        ),
    )
    @requires_access(READ)
    def list_buckets(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """All buckets, up to the list limit."""
        buckets = self._client().storage.list_buckets() or []
        limit = self.IGlobal.list_limit
        rows = [self._output(b) for b in buckets[:limit]]
        rows = [{k: r[k] for k in _BUCKET_FIELDS if k in r} for r in rows if isinstance(r, dict)]
        return {'buckets': rows, 'count': len(rows), 'truncated': len(buckets) > limit}

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['bucket'],
            'properties': {
                'bucket': {'type': 'string', 'description': 'Bucket name.'},
                'prefix': {
                    'type': 'string',
                    'description': 'Folder inside the bucket, e.g. "reports/2026". Default: the bucket root.',
                },
                'limit': {
                    'type': 'integer',
                    'minimum': 1,
                    'description': 'Most entries to return. Default and maximum: the node list limit (100 unless changed).',
                },
                'offset': {'type': 'integer', 'minimum': 0, 'description': 'Entries to skip, for paging. Default 0.'},
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'bucket': {'type': 'string'},
                'prefix': {'type': 'string'},
                'files': {'type': 'array', 'items': {'type': 'object'}},
                'count': {'type': 'integer'},
                'more_may_exist': {'type': 'boolean'},
            },
        },
        description=(
            'List the files and sub-folders directly inside one folder of a bucket (not recursive). '
            'Arguments: bucket, prefix (folder, default the bucket root), limit (default and maximum: the node '
            'list limit, 100 unless changed; larger values are lowered), offset (default 0). Needs the read '
            'access level. Returns files (name, path, is_folder, size, content_type, updated_at), count, and '
            'more_may_exist (true when the list is full: call again with offset + count).'
        ),
    )
    @requires_access(READ)
    def list_files(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """One folder's entries."""
        tool = self._tool('list_files')
        bucket = self._bucket(args, tool)
        prefix = self._prefix(args, tool)
        cap = self.IGlobal.list_limit
        limit = int_arg(args, 'limit', default=cap, lo=1, hi=cap, tool_name=tool)
        offset = int_arg(args, 'offset', default=0, lo=0, hi=10_000_000, tool_name=tool)
        entries = self._bucket_api(bucket).list(prefix, {'limit': limit, 'offset': offset}) or []
        files: List[Dict[str, Any]] = []
        for entry in self._output(entries):
            if not isinstance(entry, dict) or not entry.get('name'):
                continue
            metadata = entry.get('metadata') if isinstance(entry.get('metadata'), dict) else None
            # Storage lists a sub-folder as an entry with no id and no metadata.
            is_folder = entry.get('id') is None and metadata is None
            files.append(
                {
                    'name': entry['name'],
                    'path': f'{prefix}/{entry["name"]}' if prefix else entry['name'],
                    'is_folder': is_folder,
                    'size': (metadata or {}).get('size'),
                    'content_type': (metadata or {}).get('mimetype'),
                    'updated_at': entry.get('updated_at'),
                }
            )
        return {
            'bucket': bucket,
            'prefix': prefix,
            'files': files,
            'count': len(files),
            'more_may_exist': len(entries) >= limit,
        }

    def _signed_url(self, bucket: str, path: str, seconds: int, tool_name: str) -> str:
        response = self._bucket_api(bucket).create_signed_url(path, seconds)
        url = None
        if isinstance(response, dict):
            # storage3 returns the same URL under both spellings.
            url = response.get('signedURL') or response.get('signedUrl')
        if not isinstance(url, str) or not url:
            raise RuntimeError(f'{tool_name}: Supabase returned no signed URL for {bucket}/{path}')
        return url

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['bucket', 'path'],
            'properties': {
                'bucket': {'type': 'string', 'description': 'Bucket name.'},
                'path': {'type': 'string', 'description': 'File path inside the bucket, e.g. "reports/q1.csv".'},
                'as': {
                    'type': 'string',
                    'enum': list(ENCODINGS),
                    'description': 'text (UTF-8, the default) or base64 (for binary files).',
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'bucket': {'type': 'string'},
                'path': {'type': 'string'},
                'size': {
                    'type': ['integer', 'null'],
                    'description': 'File size in bytes; null when Supabase did not say and the file is over the limit.',
                },
                'content_type': {'type': 'string'},
                'inline': {'type': 'boolean', 'description': 'true: content is here; false: use signed_url.'},
                'encoding': {'type': 'string'},
                'content': {'type': 'string'},
                'signed_url': {'type': 'string'},
                'expires_in': {'type': 'integer'},
                'message': {'type': 'string'},
            },
        },
        description=(
            'Read a file. Arguments: bucket, path, as (text, the default, or base64 for binary files). Needs '
            'the read access level. A file up to the node inline limit (256 KB unless changed) comes back '
            'inline: {"inline": true, "encoding", "content", "size", "content_type"}. A larger file is NOT '
            'returned inline: you get {"inline": false, "signed_url", "expires_in", "size", "message"} and the '
            'file can be fetched from signed_url until it expires. as=text fails for a file that is not UTF-8 '
            'text; use base64 then.'
        ),
    )
    @requires_access(READ)
    def download_file(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """Inline content up to the inline limit, otherwise a signed URL."""
        tool = self._tool('download_file')
        bucket = self._bucket(args, tool)
        path = self._path(args, tool)
        encoding = self._enum_arg(args, 'as', ENCODINGS, 'text', tool_name=tool)
        limit = self.IGlobal.inline_limit_bytes
        files = self._bucket_api(bucket)

        # Ask for the size first so a large file is never downloaded just to
        # be thrown away. storage-api answers /object/info with size and
        # content_type at the top level.
        info = self._output(files.info(path))
        info = info if isinstance(info, dict) else {}
        size = info.get('size')
        size = size if isinstance(size, int) and not isinstance(size, bool) else None
        content_type = info.get('content_type') if isinstance(info.get('content_type'), str) else None

        data: Optional[bytes] = None
        too_large = size is not None and size > limit
        if not too_large:
            # One capped read for every inline download: at most limit + 1
            # bytes are ever held, whatever /object/info said (it can be
            # missing, or stale when the object was replaced since).
            result = self._api().request(
                'GET',
                _object_path(bucket, path),
                max_bytes=limit,
                what=f'Storage download of {bucket}/{path}',
            )
            too_large = result.truncated
            # The bytes received decide; when cut, the server's length if it gave one.
            size = result.size
            content_type = content_type or result.headers.get('content-type') or None
            data = None if too_large else result.content

        if too_large:
            seconds = self.IGlobal.signed_url_seconds
            described = f'{size} bytes' if size is not None else f'larger than {limit} bytes'
            return {
                'bucket': bucket,
                'path': path,
                'size': size,
                'content_type': content_type,
                'inline': False,
                'signed_url': self._signed_url(bucket, path, seconds, tool),
                'expires_in': seconds,
                'message': (
                    f'The file is {described}, above the inline limit of {limit} bytes, so its content is not '
                    f'included. Fetch it from signed_url within {seconds} seconds.'
                ),
            }

        if encoding == 'text':
            try:
                content = data.decode('utf-8')
            except UnicodeDecodeError:
                raise ValueError(f'{tool}: {bucket}/{path} is not UTF-8 text; call again with "as": "base64"') from None
        else:
            content = base64.b64encode(data).decode('ascii')
        return {
            'bucket': bucket,
            'path': path,
            'size': size,
            'content_type': content_type,
            'inline': True,
            'encoding': encoding,
            'content': content,
        }

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['bucket', 'path'],
            'properties': {
                'bucket': {'type': 'string', 'description': 'Bucket name.'},
                'path': {'type': 'string', 'description': 'File path inside the bucket.'},
                'expires_in': {
                    'type': 'integer',
                    'minimum': SIGNED_URL_SECONDS_MIN,
                    'maximum': SIGNED_URL_SECONDS_MAX,
                    'description': 'Seconds the URL stays valid. Default: the node setting (3600 unless changed).',
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'bucket': {'type': 'string'},
                'path': {'type': 'string'},
                'signed_url': {'type': 'string'},
                'expires_in': {'type': 'integer'},
            },
        },
        description=(
            'Make a temporary download link for a file, for a person or another system to fetch it. '
            f'Arguments: bucket, path, expires_in (seconds, {SIGNED_URL_SECONDS_MIN} to {SIGNED_URL_SECONDS_MAX}; '
            'default the node setting, 3600 unless changed; values outside the range are moved into it). Needs '
            'the read access level. Returns signed_url and expires_in. Anyone with the URL can download the '
            'file until it expires.'
        ),
    )
    @requires_access(READ)
    def create_signed_url(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """A signed download URL."""
        tool = self._tool('create_signed_url')
        bucket = self._bucket(args, tool)
        path = self._path(args, tool)
        seconds = int_arg(
            args,
            'expires_in',
            default=self.IGlobal.signed_url_seconds,
            lo=SIGNED_URL_SECONDS_MIN,
            hi=SIGNED_URL_SECONDS_MAX,
            tool_name=tool,
        )
        url = self._signed_url(bucket, path, seconds, tool)
        return {'bucket': bucket, 'path': path, 'signed_url': url, 'expires_in': seconds}

    # ------------------------------------------------------------------
    # Write tools
    # ------------------------------------------------------------------

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['bucket', 'path', 'content'],
            'properties': {
                'bucket': {'type': 'string', 'description': 'Bucket name.'},
                'path': {'type': 'string', 'description': 'File path inside the bucket, e.g. "notes/today.md".'},
                'content': {'type': 'string', 'description': 'The file content, as text or base64 (see encoding).'},
                'encoding': {
                    'type': 'string',
                    'enum': list(ENCODINGS),
                    'description': 'text (stored as UTF-8, the default) or base64 (binary content).',
                },
                'content_type': {
                    'type': 'string',
                    'description': 'MIME type, e.g. "text/csv". Default: guessed from the path.',
                },
                'upsert': {
                    'type': 'boolean',
                    'description': 'true replaces an existing file at that path. Default false (fails if it exists).',
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'bucket': {'type': 'string'},
                'path': {'type': 'string'},
                'size': {'type': 'integer'},
                'content_type': {'type': 'string'},
                'upsert': {'type': 'boolean'},
            },
        },
        description=(
            'Upload a file. Arguments: bucket, path, content, encoding (text, the default, or base64), '
            'content_type (optional, guessed from the path), upsert (optional, default false: fails if the '
            'file exists; true replaces it). Needs the write access level. Content above the node upload limit '
            '(10 MB unless changed) is refused before sending. Returns bucket, path, size, content_type, upsert.'
        ),
    )
    @requires_access(WRITE)
    def upload_file(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """Upload content, refusing it above the upload limit before anything is sent."""
        tool = self._tool('upload_file')
        bucket = self._bucket(args, tool)
        path = self._path(args, tool)
        encoding = self._enum_arg(args, 'encoding', ENCODINGS, 'text', tool_name=tool)
        content = args.get('content')
        if not isinstance(content, str):
            raise ValueError(f'{tool}: "content" is required and must be a string')
        limit = self.IGlobal.upload_limit_bytes
        too_large = f'{tool}: the content is larger than the upload limit of {limit} bytes'

        if encoding == 'text':
            data = content.encode('utf-8')
        else:
            # Base64 is 4 characters per 3 bytes: refuse an oversized string
            # before decoding it into memory.
            if len(content) > (limit // 3 + 1) * 4 + 4:
                raise ValueError(too_large)
            try:
                data = base64.b64decode(''.join(content.split()), validate=True)
            except (binascii.Error, ValueError):
                raise ValueError(f'{tool}: "content" is not valid base64') from None
        if len(data) > limit:
            raise ValueError(too_large)

        content_type = optional_str(args, 'content_type', default='', tool_name=tool).strip()
        if not content_type:
            guessed, _ = mimetypes.guess_type(path)
            if guessed:
                content_type = guessed
            else:
                content_type = 'text/plain;charset=UTF-8' if encoding == 'text' else 'application/octet-stream'
        upsert = optional_bool(args, 'upsert', default=False, tool_name=tool)

        options: Dict[str, str] = {'content-type': content_type}
        if upsert:
            # storage3 sends this as the x-upsert header, which must be a string.
            options['upsert'] = 'true'
        self._bucket_api(bucket).upload(path, data, options)
        return {'bucket': bucket, 'path': path, 'size': len(data), 'content_type': content_type, 'upsert': upsert}

    # ------------------------------------------------------------------
    # Admin tools
    # ------------------------------------------------------------------

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['name'],
            'properties': {
                'name': {'type': 'string', 'description': 'Bucket name, e.g. "invoices".'},
                'public': {
                    'type': 'boolean',
                    'description': 'true lets anyone read files by URL without a key. Default false (private).',
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {'name': {'type': 'string'}, 'public': {'type': 'boolean'}},
        },
        description=(
            'Create a bucket. Arguments: name, public (optional, default false; true makes every file in it '
            'readable by anyone with its URL). Needs the admin access level. Returns name and public. Fails if '
            'the bucket already exists.'
        ),
    )
    @requires_access(ADMIN)
    def create_bucket(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """Create a bucket (private unless asked)."""
        tool = self._tool('create_bucket')
        name = self._bucket(args, tool, key='name')
        public = optional_bool(args, 'public', default=False, tool_name=tool)
        self._client().storage.create_bucket(name, options={'public': public})
        return {'name': name, 'public': public}

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['bucket', 'paths'],
            'properties': {
                'bucket': {'type': 'string', 'description': 'Bucket name.'},
                'paths': {
                    'type': 'array',
                    'items': {'type': 'string'},
                    'description': f'File paths inside the bucket, at most {_MAX_DELETE_PATHS}.',
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'bucket': {'type': 'string'},
                'deleted': {'type': 'array', 'items': {'type': 'string'}},
                'not_found': {'type': 'array', 'items': {'type': 'string'}},
            },
        },
        description=(
            f'Delete files permanently. Arguments: bucket, paths (list of file paths, at most {_MAX_DELETE_PATHS}). '
            'Needs the admin access level. Returns deleted (paths Supabase removed) and not_found (paths that '
            'did not exist). Folders are not deleted recursively: list them with list_files and pass the file paths.'
        ),
    )
    @requires_access(ADMIN)
    def delete_file(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """Delete up to 1000 files in one bucket."""
        tool = self._tool('delete_file')
        bucket = self._bucket(args, tool)
        raw = require_str_list(args, 'paths', tool_name=tool)
        if len(raw) > _MAX_DELETE_PATHS:
            raise ValueError(f'{tool}: "paths" may hold at most {_MAX_DELETE_PATHS} paths per call')
        paths: List[str] = []
        for item in raw:
            path = self._check_path(item.strip(), tool, 'paths')
            if path not in paths:
                paths.append(path)
        removed = self._output(self._bucket_api(bucket).remove(paths)) or []
        names = {r.get('name') for r in removed if isinstance(r, dict)}
        return {
            'bucket': bucket,
            'deleted': [p for p in paths if p in names],
            'not_found': [p for p in paths if p not in names],
        }
