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

    def __init__(self, **kwargs):
        """Initialize storage capabilities."""
        super().__init__(**kwargs)

    # =========================================================================
    # Handle-Based I/O
    # =========================================================================

    async def fs_open(self, path: str, mode: str = 'r', offset: int = 0) -> Dict[str, Any]:
        """
        Open a file handle for reading or writing.

        Args:
            path: Relative path within the account store.
            mode: 'r' for read, 'w' for write.
            offset: Initial byte offset (read mode only).

        Returns:
            Dict with 'handle' (str). Read mode also includes 'size' (int).
        """
        args: Dict[str, Any] = {'subcommand': 'fs_open', 'path': path, 'mode': mode}
        if mode == 'r' and offset > 0:
            args['offset'] = offset
        request = self.build_request(command='rrext_store', arguments=args)
        response = await self.request(request)
        self._check_response(response)
        return response.get('body', {})

    async def fs_read(self, handle: str, length: int = 4_194_304) -> bytes:
        """
        Read data from an open read handle.

        Args:
            handle: Handle ID returned by fs_open.
            length: Max bytes to read (default 4 MB).

        Returns:
            Bytes read. Empty bytes indicates EOF.
        """
        request = self.build_request(command='rrext_store', arguments={'subcommand': 'fs_read', 'handle': handle, 'length': length})
        response = await self.request(request)
        self._check_response(response)
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
        request = self.build_request(command='rrext_store', arguments={'subcommand': 'fs_write', 'handle': handle, 'data': data})
        response = await self.request(request)
        self._check_response(response)
        return response.get('body', {}).get('bytesWritten', 0)

    async def fs_close(self, handle: str, mode: str = 'r') -> None:
        """
        Close a file handle.

        Args:
            handle: Handle ID returned by fs_open.
            mode: 'r' or 'w' (must match the mode used in fs_open).
        """
        request = self.build_request(command='rrext_store', arguments={'subcommand': 'fs_close', 'handle': handle, 'mode': mode})
        response = await self.request(request)
        self._check_response(response)

    # =========================================================================
    # Other File Operations
    # =========================================================================

    async def fs_delete(self, path: str) -> None:
        """
        Delete a file.

        Args:
            path: Relative path within the account store.
        """
        request = self.build_request(command='rrext_store', arguments={'subcommand': 'fs_delete', 'path': path})
        response = await self.request(request)
        self._check_response(response)

    async def fs_list_dir(self, path: str = '') -> Dict[str, Any]:
        """
        List immediate children of a directory.

        Args:
            path: Relative directory path (default: account root).

        Returns:
            Dict with keys: entries (list of {name, type, modified?}), count.
            File entries include a modified epoch timestamp.
        """
        request = self.build_request(command='rrext_store', arguments={'subcommand': 'fs_list_dir', 'path': path})
        response = await self.request(request)
        self._check_response(response)
        return response.get('body', {})

    async def fs_mkdir(self, path: str) -> None:
        """
        Create a directory.

        Args:
            path: Relative directory path.
        """
        request = self.build_request(command='rrext_store', arguments={'subcommand': 'fs_mkdir', 'path': path})
        response = await self.request(request)
        self._check_response(response)

    async def fs_stat(self, path: str) -> Dict[str, Any]:
        """
        Get file or directory metadata.

        Args:
            path: Relative path within the account store.

        Returns:
            Dict with keys: exists, type (file|dir), modified (epoch timestamp, files only).
        """
        request = self.build_request(command='rrext_store', arguments={'subcommand': 'fs_stat', 'path': path})
        response = await self.request(request)
        self._check_response(response)
        return response.get('body', {})

    # =========================================================================
    # Convenience Wrappers (text/JSON over binary)
    # =========================================================================

    async def fs_read_string(self, path: str, encoding: str = 'utf-8') -> str:
        """Read a file as a decoded string."""
        info = await self.fs_open(path, 'r')
        handle = info['handle']
        try:
            chunks = []
            while True:
                chunk = await self.fs_read(handle)
                if not chunk:
                    break
                chunks.append(chunk)
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

    async def save_project(self, project_id: str, pipeline: Dict[str, Any]) -> None:
        """Save a project pipeline to .projects/<project_id>.json."""
        if not project_id:
            raise ValueError('project_id is required')
        if not pipeline or not isinstance(pipeline, dict):
            raise ValueError('pipeline must be a non-empty dictionary')

        await self.fs_write_json(f'.projects/{project_id}.json', pipeline)

    async def get_project(self, project_id: str) -> Dict[str, Any]:
        """Get a project by ID from .projects/<project_id>.json."""
        if not project_id:
            raise ValueError('project_id is required')

        return await self.fs_read_json(f'.projects/{project_id}.json')

    async def delete_project(self, project_id: str) -> None:
        """Delete a project by ID."""
        if not project_id:
            raise ValueError('project_id is required')

        await self.fs_delete(f'.projects/{project_id}.json')

    async def get_all_projects(self) -> Dict[str, Any]:
        """List all projects with summaries."""
        return await self._get_all_items('.projects', 'id', 'projects')

    # =========================================================================
    # Domain Convenience - Templates
    # =========================================================================

    async def save_template(self, template_id: str, pipeline: Dict[str, Any]) -> None:
        """Save a template pipeline to .templates/<template_id>.json."""
        if not template_id:
            raise ValueError('template_id is required')
        if not pipeline or not isinstance(pipeline, dict):
            raise ValueError('pipeline must be a non-empty dictionary')

        await self.fs_write_json(f'.templates/{template_id}.json', pipeline)

    async def get_template(self, template_id: str) -> Dict[str, Any]:
        """Get a template by ID from .templates/<template_id>.json."""
        if not template_id:
            raise ValueError('template_id is required')

        return await self.fs_read_json(f'.templates/{template_id}.json')

    async def delete_template(self, template_id: str) -> None:
        """Delete a template by ID."""
        if not template_id:
            raise ValueError('template_id is required')

        await self.fs_delete(f'.templates/{template_id}.json')

    async def get_all_templates(self) -> Dict[str, Any]:
        """List all templates with summaries."""
        return await self._get_all_items('.templates', 'id', 'templates')

    # =========================================================================
    # Domain Convenience - Logs
    # =========================================================================

    async def save_log(self, project_id: str, source: str, contents: Dict[str, Any]) -> str:
        """Save a log file to .logs/<project_id>/<source>-<start_time>.log. Returns filename."""
        if not project_id:
            raise ValueError('project_id is required')
        if not source:
            raise ValueError('source is required')
        if not contents or not isinstance(contents, dict):
            raise ValueError('contents must be a non-empty dictionary')

        start_time = contents.get('body', {}).get('startTime')
        if start_time is None:
            raise ValueError('contents must contain body.startTime')

        filename = f'{source}-{start_time}.log'
        await self.fs_write_json(f'.logs/{project_id}/{filename}', contents)
        return filename

    async def get_log(self, project_id: str, source: str, start_time: float) -> Dict[str, Any]:
        """Get a log file by source name and start time."""
        if not project_id:
            raise ValueError('project_id is required')
        if not source:
            raise ValueError('source is required')
        if start_time is None:
            raise ValueError('start_time is required')

        filename = f'{source}-{start_time}.log'
        return await self.fs_read_json(f'.logs/{project_id}/{filename}')

    async def list_logs(self, project_id: str, source: Optional[str] = None) -> Dict[str, Any]:
        """List log files for a project."""
        if not project_id:
            raise ValueError('project_id is required')

        dir_result = await self.fs_list_dir(f'.logs/{project_id}')
        logs = [e['name'] for e in dir_result.get('entries', []) if e['type'] == 'file' and e['name'].endswith('.log')]

        if source:
            logs = [f for f in logs if f.startswith(f'{source}-')]

        logs.sort()
        return {'success': True, 'logs': logs, 'count': len(logs)}

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
            except Exception:
                continue

        return {list_key: items, 'count': len(items)}

    def _check_response(self, response: Dict[str, Any]) -> None:
        """Raise RuntimeError if the response indicates failure."""
        if self.did_fail(response):
            raise RuntimeError(response.get('message', 'Unknown storage error'))
