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
Google Cloud Storage tool node instance.

The bucket, the object prefix and the download cap are this call's
(``self.settings``). A download is written to the control owner's file store
(``self.files``), not to the engine host's disk, so whichever replica serves
the next call, and the filesystem tool, can read it. Only the most recent
download is kept: its path is the node's state, and a new download deletes
it from any replica.
"""

from __future__ import annotations

from typing import Any

from rocketlib import IInstanceBase, tool_function, warning

from .IGlobal import IGlobal

# ==== Constants ==================================================================

#: Where downloads land in the owner's file store.
DOWNLOAD_ROOT = 'gcs'

#: The state key holding the path of the most recent download.
LAST_DOWNLOAD_KEY = 'last_download'


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


def download_path(object_name: str) -> str:
    """
    The file-store path a downloaded object lands at.

    Args:
        object_name: The object's full name in the bucket (prefix included).

    Returns:
        A relative path under ``gcs/`` that keeps the object's own path.
    """
    parts = [part for part in object_name.replace('\\', '/').split('/') if part not in ('', '.', '..')]
    return '/'.join([DOWNLOAD_ROOT, *parts]) if parts else f'{DOWNLOAD_ROOT}/object'


class IInstance(IInstanceBase):
    """GCS instance, providing tool functions for reading and listing files."""

    IGlobal: IGlobal

    def _bucket_settings(self) -> tuple[str, str]:
        """This call's bucket name and object prefix."""
        settings = self.settings
        return str(settings.bucketName or '').strip(), str(settings.prefix or '').strip()

    def _replace_last_download(self, path: str) -> None:
        """Record ``path`` as the most recent download and delete the one it replaces."""
        with self.state.lock(LAST_DOWNLOAD_KEY):
            previous = self.state.get(LAST_DOWNLOAD_KEY)
            self.state.put(LAST_DOWNLOAD_KEY, path)
        if previous and previous != path:
            try:
                self.files.delete(previous)
            except Exception as e:
                warning(f'tool_gcs: failed to remove the previous download {previous}: {e}')

    @staticmethod
    def _read_capped(blob: Any, max_bytes: int) -> bytes | None:
        """
        Read one object, refusing more than ``max_bytes``.

        Args:
            blob: The object's blob handle.
            max_bytes: This call's download cap.

        Returns:
            The object's bytes, or None when it grew past the cap since it was sized.
        """
        with blob.open('rb') as reader:
            data = reader.read(max_bytes + 1)
        return None if len(data) > max_bytes else data

    @tool_function(
        description=(
            "Download a file from Google Cloud Storage into the pipeline owner's file store. Returns a "
            'dictionary containing the file-store path of the downloaded file (readable with the '
            'filesystem tool). Only the most recent download is kept: a new download deletes the '
            'previous one. Objects larger than the configured maxDownloadBytes are rejected.'
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

        client = self.IGlobal.gcs_client()
        if not client:
            return {'error': 'GCS client is not connected.'}

        bucket_name, prefix = self._bucket_settings()
        if not bucket_name:
            return {'error': 'Bucket name not configured.'}

        file_name = join_gcs_prefix(prefix, file_name)
        max_bytes = self.settings.maxDownloadBytes

        try:
            bucket = client.bucket(bucket_name)
            blob = bucket.blob(file_name)
            blob.reload()
            size = blob.size or 0
            if size > max_bytes:
                return {
                    'error': (
                        f'Object {file_name!r} is {size} bytes, which exceeds '
                        f'maxDownloadBytes ({max_bytes}). Increase the limit or download a smaller object.'
                    )
                }

            # Into the owner's file store; the object can change between reload() and the read
            data = self._read_capped(blob, max_bytes)
            if data is None:
                return {
                    'error': (
                        f'Object {file_name!r} grew past maxDownloadBytes ({max_bytes}) while it was read. '
                        'Increase the limit or download a smaller object.'
                    )
                }

            path = download_path(file_name)
            self.files.write(path, data)
            self._replace_last_download(path)
            return {'success': True, 'path': path, 'size': len(data)}
        except Exception as e:
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

        client = self.IGlobal.gcs_client()
        if not client:
            return ['Error: GCS client is not connected.']

        bucket_name, node_prefix = self._bucket_settings()
        if not bucket_name:
            return ['Error: Bucket name not configured.']

        full_prefix = join_gcs_prefix(node_prefix, prefix)

        try:
            bucket = client.bucket(bucket_name)
            blobs = bucket.list_blobs(prefix=full_prefix, max_results=max_results)
            return [blob.name for blob in blobs]
        except Exception as e:
            return [f'Failed to list files: {e}']
