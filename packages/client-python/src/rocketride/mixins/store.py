# MIT License
#
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

"""
Storage Management for RocketRide Client.

Handle-based I/O: use fs_open/fs_read/fs_write/fs_close for streaming.
Convenience wrappers (fs_read_string, fs_write_json, etc.) handle
open/close internally.
"""

import json
from typing import Dict, Any, Optional
from ..core import DAPClient


class StoreMixin(DAPClient):
    """
    Provides handle-based file store and domain storage capabilities.

    Core methods (fs_open, fs_read, fs_write, fs_close) use handles for
    streaming I/O. Convenience wrappers handle open/close internally.
    Domain methods (save_project, get_template, etc.) are client-side
    wrappers that call the convenience methods with well-known paths.
    """

    _INVALID_PATH_CHARS = frozenset('*?<>|"\x00')

    def __init__(self, **kwargs):
        """Initialize storage capabilities."""
        super().__init__(**kwargs)

    # =========================================================================
    # Handle-Based I/O
    # =========================================================================

    async def fs_open(self, path: str, mode: str = 'r') -> Dict[str, Any]:
        """
        Open a file handle for reading or writing.

        Args:
            path: Relative path within the account store.
            mode: 'r' for read, 'w' for write.

        Returns:
            Dict with 'handle' (str). Read mode also includes 'size' (int).
        """
        self._validate_store_path(path)
        return await self.call('rrext_store', subcommand='fs_open', path=path, mode=mode)

    async def fs_read(self, handle: str, offset: int = 0, length: int = 4_194_304) -> bytes:
        """
        Read data from an open read handle.

        Args:
            handle: Handle ID returned by fs_open.
            offset: Byte offset to read from.
            length: Max bytes to read (default 4 MB).

        Returns:
            Bytes read. Empty bytes indicates EOF.
        """
        # fs_read returns binary data in response.arguments (not body), so use raw request
        request = self.build_request(command='rrext_store', arguments={'subcommand': 'fs_read', 'handle': handle, 'offset': offset, 'length': length})
        response = await self.request(request)
        if self.did_fail(response):
            raise RuntimeError(response.get('message', 'Failed to read from handle'))
        return response.get('arguments', {}).get('data', b'')

    async def fs_write(self, handle: str, data: bytes) -> int:
        """
        Write data to an open write handle.

        Args:
            handle: Handle ID returned by fs_open.
            data: Raw bytes to write.

        Returns:
            Number of bytes written.
        """
        body = await self.call('rrext_store', subcommand='fs_write', handle=handle, data=data)
        return body.get('bytesWritten', 0)

    async def fs_close(self, handle: str, mode: str = 'r') -> None:
        """
        Close a file handle.

        Args:
            handle: Handle ID returned by fs_open.
            mode: 'r' or 'w' (must match the mode used in fs_open).
        """
        await self.call('rrext_store', subcommand='fs_close', handle=handle, mode=mode)

    # =========================================================================
    # Other File Operations
    # =========================================================================

    async def fs_delete(self, path: str) -> None:
        """
        Delete a file.

        Args:
            path: Relative path within the account store.
        """
        self._validate_store_path(path)
        await self.call('rrext_store', subcommand='fs_delete', path=path)

    async def fs_list_dir(self, path: str = '') -> Dict[str, Any]:
        """
        List immediate children of a directory.

        Args:
            path: Relative directory path (default: account root).

        Returns:
            Dict with keys: entries (list of {name, type, size?, modified?}), count.
            File entries include size (bytes) and modified (epoch timestamp).
        """
        if path:
            self._validate_store_path(path)
        return await self.call('rrext_store', subcommand='fs_list_dir', path=path)

    async def fs_mkdir(self, path: str) -> None:
        """
        Create a directory.

        Args:
            path: Relative directory path.
        """
        self._validate_store_path(path)
        await self.call('rrext_store', subcommand='fs_mkdir', path=path)

    async def fs_rmdir(self, path: str, *, recursive: bool = False) -> None:
        """
        Remove a directory.

        Args:
            path: Relative directory path. Must be non-empty and must not start
                with ``/`` or ``\\`` — destructive ops reject absolute-like
                paths so a bad input cannot act on the account root.
            recursive: Keyword-only. If True, delete all contents recursively
                (default: False).

        Raises:
            ValueError: If ``path`` is empty or absolute-like.
            RuntimeError: If directory is not empty and recursive is False.
        """
        self._validate_relative_path(path, 'path')
        await self.call('rrext_store', subcommand='fs_rmdir', path=path, recursive=recursive)

    async def fs_stat(self, path: str) -> Dict[str, Any]:
        """
        Get file or directory metadata.

        Args:
            path: Relative path within the account store.

        Returns:
            Dict with keys: exists, type (file|dir), size (bytes, files only),
            modified (epoch timestamp, files only).
        """
        self._validate_store_path(path)
        return await self.call('rrext_store', subcommand='fs_stat', path=path)

    async def fs_rename(self, old_path: str, new_path: str) -> None:
        """
        Rename a file or directory.

        On object stores this is implemented as copy + delete. For directories,
        all contents are moved recursively.

        Args:
            old_path: Current relative path within the account store. Must be
                non-empty and must not start with ``/`` or ``\\``.
            new_path: New relative path within the account store. Same
                constraints as ``old_path``.

        Raises:
            ValueError: If either path is empty or absolute-like.
            RuntimeError: If old_path does not exist or rename fails.
        """
        self._validate_relative_path(old_path, 'old_path')
        self._validate_relative_path(new_path, 'new_path')
        await self.call('rrext_store', subcommand='fs_rename', old_path=old_path, new_path=new_path)

    # =========================================================================
    # Convenience Wrappers (text/JSON over binary)
    # =========================================================================

    async def fs_read_string(self, path: str, encoding: str = 'utf-8') -> str:
        """Read a file as a decoded string."""
        info = await self.fs_open(path, 'r')
        handle = info['handle']
        try:
            chunks = []
            offset = 0
            while True:
                chunk = await self.fs_read(handle, offset)
                if not chunk:
                    break
                chunks.append(chunk)
                offset += len(chunk)
            return b''.join(chunks).decode(encoding)
        finally:
            await self.fs_close(handle, 'r')

    async def fs_write_string(self, path: str, text: str, encoding: str = 'utf-8') -> None:
        """Write a string to a file."""
        info = await self.fs_open(path, 'w')
        handle = info['handle']
        try:
            await self.fs_write(handle, text.encode(encoding))
            await self.fs_close(handle, 'w')
        except Exception:
            try:
                await self.fs_close(handle, 'w')
            except Exception:
                pass
            raise

    async def fs_read_json(self, path: str) -> Any:
        """Read a JSON file. Returns the parsed object."""
        text = await self.fs_read_string(path)
        return json.loads(text)

    async def fs_write_json(self, path: str, obj: Any) -> None:
        """Write an object as JSON."""
        await self.fs_write_string(path, json.dumps(obj, indent=2))

    # =========================================================================
    # Domain Convenience - Projects
    # =========================================================================
    # Domain Convenience - Templates
    # =========================================================================

    async def save_template(self, template_id: str, pipeline: Dict[str, Any]) -> None:
        """Save a template pipeline to .templates/<template_id>.json."""
        self._validate_id(template_id, 'template_id')
        if not pipeline or not isinstance(pipeline, dict):
            raise ValueError('pipeline must be a non-empty dictionary')

        await self.fs_write_json(f'.templates/{template_id}.json', pipeline)

    async def get_template(self, template_id: str) -> Dict[str, Any]:
        """Get a template by ID from .templates/<template_id>.json."""
        self._validate_id(template_id, 'template_id')

        return await self.fs_read_json(f'.templates/{template_id}.json')

    async def delete_template(self, template_id: str) -> None:
        """Delete a template by ID."""
        self._validate_id(template_id, 'template_id')

        await self.fs_delete(f'.templates/{template_id}.json')

    async def get_all_templates(self) -> Dict[str, Any]:
        """List all templates with summaries."""
        return await self._get_all_items('.templates', 'id', 'templates')

    # =========================================================================
    # Domain Convenience - Logs
    # =========================================================================

    async def save_log(self, project_id: str, source: str, contents: Dict[str, Any]) -> str:
        """Save a log file to .logs/<project_id>/<source>-<start_time>.log. Returns filename."""
        self._validate_id(project_id, 'project_id')
        self._validate_id(source, 'source')
        if not contents or not isinstance(contents, dict):
            raise ValueError('contents must be a non-empty dictionary')

        start_time = contents.get('body', {}).get('startTime')
        if start_time is None:
            raise ValueError('contents must contain body.startTime')

        filename = f'{source}-{start_time}.log'
        await self.fs_write_json(f'.logs/{project_id}/{filename}', contents)
        return filename

    async def get_log(self, project_id: str, name: str) -> Dict[str, Any]:
        """Get a log file by name (as returned by list_logs or save_log)."""
        self._validate_id(project_id, 'project_id')
        if not name:
            raise ValueError('name is required')

        return await self.fs_read_json(f'.logs/{project_id}/{name}')

    async def delete_log(self, project_id: str, name: str) -> None:
        """Delete a log file by name."""
        self._validate_id(project_id, 'project_id')
        if not name:
            raise ValueError('name is required')

        await self.fs_delete(f'.logs/{project_id}/{name}')

    async def list_logs(self, project_id: str, source: Optional[str] = None) -> list[dict]:
        """List log files for a project. Returns list of {name, modified} sorted by modified time."""
        self._validate_id(project_id, 'project_id')
        if source:
            self._validate_id(source, 'source')

        dir_result = await self.fs_list_dir(f'.logs/{project_id}')
        logs = [{'name': e['name'], 'modified': e.get('modified')} for e in dir_result.get('entries', []) if e['type'] == 'file' and e['name'].endswith('.log')]

        if source:
            logs = [entry for entry in logs if entry['name'].startswith(f'{source}-')]

        logs.sort(key=lambda entry: entry.get('modified') or 0)
        return logs

    # =========================================================================
    # Private
    # =========================================================================

    async def _get_all_items(self, directory: str, id_key: str, list_key: str) -> Dict[str, Any]:
        """List all items in a domain directory with pipeline summaries."""
        dir_result = await self.fs_list_dir(directory)
        json_entries = [e for e in dir_result.get('entries', []) if e['type'] == 'file' and e['name'].endswith('.json')]

        items = []
        for entry in json_entries:
            try:
                item_id = entry['name'][:-5]
                pipeline = await self.fs_read_json(f'{directory}/{entry["name"]}')
                sources = []
                for component in pipeline.get('components', []):
                    config = component.get('config', {})
                    if config.get('mode') == 'Source':
                        sources.append({'id': component.get('id'), 'provider': component.get('provider'), 'name': config.get('name', component.get('id'))})
                items.append({id_key: item_id, 'name': pipeline.get('name', 'Untitled'), 'description': pipeline.get('description', ''), 'sources': sources, 'totalComponents': len(pipeline.get('components', []))})
            except Exception as e:
                import logging

                logging.getLogger(__name__).debug('Failed to read %s/%s: %s', directory, entry['name'], e)
                continue

        return {list_key: items, 'count': len(items)}

    @staticmethod
    def _validate_store_path(path: str) -> None:
        """Validate a store path before sending to the server."""
        for segment in path.replace('\\', '/').split('/'):
            if segment == '..':
                raise ValueError(f'Path traversal not allowed: {path}')
            if segment and any(c in StoreMixin._INVALID_PATH_CHARS or ord(c) < 0x20 for c in segment):
                raise ValueError(f'Path contains invalid characters: {path}')

    @staticmethod
    def _validate_relative_path(path: str, name: str = 'path') -> None:
        """
        Validate a path for destructive operations (rmdir, rename).

        Stricter than ``_validate_store_path``: rejects empty strings and paths
        with a leading ``/`` or ``\\`` so a bad input cannot slip past and act
        on the account root. Delegates to ``_validate_store_path`` for the
        per-segment character/traversal checks.
        """
        if not isinstance(path, str) or not path:
            raise ValueError(f'{name} must be a non-empty string')
        if path.startswith('/') or path.startswith('\\'):
            raise ValueError(f'{name} must be a relative path (got {path!r})')
        StoreMixin._validate_store_path(path)

    @staticmethod
    def _validate_id(value: str, name: str) -> None:
        """Validate that a domain identifier is a safe single path segment."""
        if not value:
            raise ValueError(f'{name} is required')
        if '/' in value or '\\' in value:
            raise ValueError(f'{name} must not contain path separators')
        if any(c in StoreMixin._INVALID_PATH_CHARS or ord(c) < 0x20 for c in value):
            raise ValueError(f'{name} contains invalid characters: {value}')

    def _check_response(self, response: Dict[str, Any]) -> None:
        """Raise RuntimeError if the response indicates failure."""
        if self.did_fail(response):
            raise RuntimeError(response.get('message', 'Unknown storage error'))
