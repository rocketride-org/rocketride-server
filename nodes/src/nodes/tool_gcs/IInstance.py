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

from __future__ import annotations

import os
import tempfile
from typing import Any

from rocketlib import IInstanceBase, tool_function

from .IGlobal import IGlobal


def join_gcs_prefix(node_prefix: str, extra: str = '') -> str:
    """Join the configured bucket prefix with an optional runtime path.

    A non-empty node prefix always ends with ``/`` so ``list_blobs`` matches
    that directory rather than any key that merely starts with the same text.
    """
    full_prefix = ''
    if node_prefix:
        full_prefix = node_prefix.rstrip('/') + '/'
    if extra:
        full_prefix += extra.lstrip('/')
    return full_prefix


def _as_dict(args: Any) -> dict:
    return args if isinstance(args, dict) else {}


class IInstance(IInstanceBase):
    """GCS instance, providing tool functions for reading and listing files."""

    IGlobal: IGlobal

    @tool_function(
        description=(
            'Download a file from Google Cloud Storage. Returns a dictionary containing '
            'the local temporary path of the downloaded file. Only the most recent download '
            'is retained; a new download deletes the previous temp file. Remaining files are '
            'removed when the node shuts down (endGlobal). Objects larger than the configured '
            'maxDownloadBytes are rejected.'
        ),
        input_schema={
            'type': 'object',
            'required': ['file_name'],
            'properties': {
                'file_name': {
                    'type': 'string',
                    'description': 'The name/path of the file in the bucket to download.',
                },
            },
        },
    )
    def download_file(self, args: dict | None = None) -> dict[str, Any]:
        args = _as_dict(args)
        file_name = str(args.get('file_name') or '')

        client = self.IGlobal.client
        if not client:
            return {'error': 'GCS client is not connected.'}

        bucket_name = self.IGlobal.bucket_name
        if not bucket_name:
            return {'error': 'Bucket name not configured.'}

        file_name = join_gcs_prefix(self.IGlobal.prefix, file_name)

        temp_path = None
        try:
            bucket = client.bucket(bucket_name)
            blob = bucket.blob(file_name)
            blob.reload()
            size = blob.size or 0
            max_bytes = self.IGlobal.max_download_bytes
            if size > max_bytes:
                return {
                    'error': (
                        f'Object {file_name!r} is {size} bytes, which exceeds '
                        f'maxDownloadBytes ({max_bytes}). Increase the limit or download a smaller object.'
                    )
                }

            # Download to a temporary file
            fd, temp_path = tempfile.mkstemp(prefix='gcs_')
            os.close(fd)
            blob.download_to_filename(temp_path)
            # Re-check after download: the object can change between reload() and fetch.
            actual_size = os.path.getsize(temp_path)
            if actual_size > max_bytes:
                os.remove(temp_path)
                temp_path = None
                return {
                    'error': (
                        f'Object {file_name!r} downloaded {actual_size} bytes, which exceeds '
                        f'maxDownloadBytes ({max_bytes}). Increase the limit or download a smaller object.'
                    )
                }

            self.IGlobal.retain_temp_file(temp_path)
            return {'success': True, 'local_path': temp_path, 'size': actual_size}
        except Exception as e:
            if temp_path and os.path.exists(temp_path):
                os.remove(temp_path)
            return {'error': f'Failed to download file: {e}'}

    @tool_function(
        description='List files in the configured Google Cloud Storage bucket.',
        input_schema={
            'type': 'object',
            'properties': {
                'prefix': {'type': 'string', 'description': 'Optional prefix to filter files.'},
                'max_results': {
                    'type': 'integer',
                    'description': 'Maximum number of files to return (default 10).',
                },
            },
        },
    )
    def list_files(self, args: dict | None = None) -> list[str]:
        args = _as_dict(args)
        prefix = str(args.get('prefix') or '')
        try:
            max_results = int(args.get('max_results') or 10)
        except (TypeError, ValueError):
            max_results = 10

        client = self.IGlobal.client
        if not client:
            return ['Error: GCS client is not connected.']

        bucket_name = self.IGlobal.bucket_name
        if not bucket_name:
            return ['Error: Bucket name not configured.']

        full_prefix = join_gcs_prefix(self.IGlobal.prefix, prefix)

        try:
            bucket = client.bucket(bucket_name)
            blobs = bucket.list_blobs(prefix=full_prefix, max_results=max_results)
            return [blob.name for blob in blobs]
        except Exception as e:
            return [f'Failed to list files: {e}']
