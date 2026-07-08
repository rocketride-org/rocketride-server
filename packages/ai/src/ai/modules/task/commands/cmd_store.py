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
StoreCommands: DAP command handler for user-scoped file storage.

Handles the ``rrext_store`` command and its ``fs_*`` subcommands
(open, read, write, close, delete, list_dir, mkdir, rmdir, stat, rename,
geturl).

Extracted from TaskCommands so that any pod needing file storage
(EAAS, Account) can include it via MRO without pulling in the full
task lifecycle.
"""

from typing import TYPE_CHECKING, Dict, Any
from ai.common.dap import DAPConn, TransportBase

if TYPE_CHECKING:
    from ..task_server import TaskServer


# =============================================================================
# STORE COMMANDS MIXIN
# =============================================================================


class StoreCommands(DAPConn):
    """
    DAP command handler for user-scoped file storage operations.

    Provides ``on_rrext_store`` which dispatches to ``fs_*`` subcommands.
    Requires ``self._server.store`` for the Store instance and
    ``self._account_info.userId`` for user-scoped file access.
    """

    def __init__(
        self,
        connection_id: int,
        server: 'TaskServer',
        transport: TransportBase,
        **kwargs,
    ) -> None:
        """Initialise the subcommand handler lookup table."""
        # Map of store subcommand names to handler methods.
        self._store_subcommand_handlers = {
            'fs_open': self._store_fs_open,
            'fs_read': self._store_fs_read,
            'fs_write': self._store_fs_write,
            'fs_close': self._store_fs_close,
            'fs_delete': self._store_fs_delete,
            'fs_list_dir': self._store_fs_list_dir,
            'fs_mkdir': self._store_fs_mkdir,
            'fs_rmdir': self._store_fs_rmdir,
            'fs_stat': self._store_fs_stat,
            'fs_rename': self._store_fs_rename,
            'fs_geturl': self._store_fs_geturl,
        }

    # =========================================================================
    # DISPATCHER
    # =========================================================================

    async def on_rrext_store(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """
        Handle DAP 'rrext_store' command — unified file storage operations.

        Verifies permissions once and routes to the appropriate fs_* handler.

        Args:
            request: DAP request with arguments.subcommand and subcommand-specific args.

        Returns:
            DAP response (format depends on subcommand).
        """
        try:
            # Require store permission (once for all subcommands)
            self.verify_permission('task.store')

            # Extract subcommand
            args = request.get('arguments', {})
            subcommand = args.get('subcommand')

            if not subcommand:
                raise ValueError('Subcommand is required')

            # Dispatch to appropriate handler
            if handler := self._store_subcommand_handlers.get(subcommand):
                return await handler(request, args)
            else:
                raise ValueError(f'Unknown subcommand: {subcommand}')

        except Exception as e:
            self.debug_message(f'Store operation failed: {str(e)}')
            raise

    # =========================================================================
    # FILE STORE ACCESS
    # =========================================================================

    def _get_file_store(self):
        """
        Get a FileStore scoped to the authenticated user.

        Returns:
            FileStore instance that isolates all paths under the current
            user's storage namespace.
        """
        # Scope the file store to the calling user so users cannot access each
        # other's files through the store API.
        return self._server.store.get_file_store(self._account_info.userId)

    # =========================================================================
    # FS SUBCOMMAND HANDLERS
    # =========================================================================

    async def _store_fs_open(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """
        Open a file handle for reading or writing.

        Args:
            request: Original DAP request.
            args:    Must contain ``path``.  Optional ``mode`` ('r' or 'w', default 'r').

        Returns:
            DAP response with handle ID (and metadata for read mode).
        """
        fs = self._get_file_store()
        path = args.get('path')
        mode = args.get('mode', 'r')

        if mode == 'w':
            # Create a write handle tied to this connection for cleanup on disconnect
            handle_id = await fs.open_write(path, self._connection_id)
            return self.build_response(request, body={'handle': handle_id})
        else:
            # Open for reading; returns handle ID plus file metadata
            result = await fs.open_read(path, self._connection_id)
            return self.build_response(request, body=result)

    async def _store_fs_read(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """
        Read data from an open read handle.

        Args:
            request: Original DAP request.
            args:    Must contain ``handle``.  Optional ``offset`` (default 0)
                     and ``length`` (default and max 4 MiB).

        Returns:
            DAP response with body.size and arguments.data.
        """
        fs = self._get_file_store()
        handle = args.get('handle')
        offset = args.get('offset', 0)
        length = args.get('length', 4_194_304)

        # Clamp to safe defaults
        if not isinstance(offset, int) or offset < 0:
            offset = 0
        if not isinstance(length, int) or length <= 0:
            length = 4_194_304
        length = min(length, 4_194_304)

        # Read the chunk
        data = await fs.read_chunk(handle, offset, length, connection_id=self._connection_id)

        # body carries byte count; arguments carries raw data separately
        response = self.build_response(request, body={'size': len(data)})
        response['arguments'] = {'data': data}
        return response

    async def _store_fs_write(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """
        Write data to an open write handle.

        Args:
            request: Original DAP request.
            args:    Must contain ``handle``.  Optional ``data`` (bytes or str).

        Returns:
            DAP response with body.bytesWritten.
        """
        fs = self._get_file_store()
        handle = args.get('handle')
        data = args.get('data', b'')

        # Normalise string data to bytes
        if isinstance(data, str):
            data = data.encode('utf-8')

        written = await fs.write_chunk(handle, data, connection_id=self._connection_id)
        return self.build_response(request, body={'bytesWritten': written})

    async def _store_fs_close(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """
        Close a file handle.

        Args:
            request: Original DAP request.
            args:    Must contain ``handle``.  Optional ``mode`` ('r' or 'w', default 'r').

        Returns:
            Empty success DAP response.
        """
        fs = self._get_file_store()
        handle = args.get('handle')
        mode = args.get('mode', 'r')

        if mode == 'w':
            await fs.close_write(handle, connection_id=self._connection_id)
        else:
            await fs.close_read(handle, connection_id=self._connection_id)
        return self.build_response(request)

    async def _store_fs_delete(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """
        Delete a file.

        Args:
            request: Original DAP request.
            args:    Must contain ``path``.

        Returns:
            Empty success DAP response.
        """
        await self._get_file_store().delete(args.get('path'))
        return self.build_response(request)

    async def _store_fs_list_dir(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """
        List directory contents.

        Args:
            request: Original DAP request.
            args:    Optional ``path`` (defaults to root).

        Returns:
            DAP response with directory listing.
        """
        result = await self._get_file_store().list_dir(args.get('path', ''))
        return self.build_response(request, body=result)

    async def _store_fs_mkdir(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """
        Create a directory.

        Args:
            request: Original DAP request.
            args:    Must contain ``path``.

        Returns:
            Empty success DAP response.
        """
        await self._get_file_store().mkdir(args.get('path'))
        return self.build_response(request)

    async def _store_fs_rmdir(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """
        Remove a directory.

        Args:
            request: Original DAP request.
            args:    Must contain ``path`` (non-empty string).  Optional ``recursive``
                     (strict bool).

        Returns:
            Empty success DAP response, or error if validation fails.
        """
        path = args.get('path')
        if not isinstance(path, str) or not path:
            return self.build_error(request, 'rmdir requires a non-empty "path" string')

        recursive = args.get('recursive', False)
        if not isinstance(recursive, bool):
            return self.build_error(request, 'rmdir "recursive" must be a boolean')

        await self._get_file_store().rmdir(path, recursive=recursive)
        return self.build_response(request)

    async def _store_fs_stat(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """
        Get file/directory metadata.

        Args:
            request: Original DAP request.
            args:    Must contain ``path``.

        Returns:
            DAP response with metadata (size, modified time, type, etc.).
        """
        result = await self._get_file_store().stat(args.get('path'))
        return self.build_response(request, body=result)

    async def _store_fs_rename(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """
        Rename a file or directory.

        Args:
            request: Original DAP request.
            args:    Must contain ``old_path`` and ``new_path`` (non-empty strings).

        Returns:
            Empty success DAP response, or error if validation fails.
        """
        old_path = args.get('old_path')
        new_path = args.get('new_path')
        if not isinstance(old_path, str) or not old_path:
            return self.build_error(request, 'rename requires a non-empty "old_path" string')
        if not isinstance(new_path, str) or not new_path:
            return self.build_error(request, 'rename requires a non-empty "new_path" string')

        await self._get_file_store().rename(old_path, new_path)
        return self.build_response(request)

    async def _store_fs_geturl(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """
        Get a direct HTTP URL for accessing a file in the store.

        For cloud backends (S3, Azure), returns a presigned/SAS URL.
        For filesystem backends, returns a JWT-signed ``/task/fetch`` URL
        that the server's HTTP endpoint validates and serves.

        Args:
            request: Original DAP request.
            args:    Must contain ``path`` (relative store path). Optional
                     ``expires_in`` (seconds, default 3600) and ``download_name``
                     (forces a browser download with this filename via
                     ``Content-Disposition: attachment``).

        Returns:
            DAP response with ``url`` in the body, or error if validation fails.
        """
        path = args.get('path')
        if not isinstance(path, str) or not path:
            return self.build_error(request, 'geturl requires a non-empty "path" string')

        expires_in = int(args.get('expires_in', 3600))
        # Optional download filename — when present the fetch URL forces a
        # browser download via Content-Disposition: attachment.
        download_name = args.get('download_name') or None
        url = await self._get_file_store().get_url(path, expires_in, download_name=download_name)
        return self.build_response(request, body={'url': url})
