"""
FileStore - General-purpose binary file system interface for RocketRide.

Provides directory-like semantics (read, write, delete, list_dir, mkdir, stat)
over the flat key-value IStore backends (Filesystem, S3, Azure). Each FileStore
instance is scoped to a single account via client_id.

Supports handle-based I/O for streaming reads and writes:
    handle = await fs.open_write(path, connection_id)
    await fs.write_chunk(handle, chunk1)
    await fs.write_chunk(handle, chunk2)
    await fs.close_write(handle)

Usage:
    from ai.account.store import Store

    store = Store.create()
    fs = store.get_file_store(client_id='user-123')

    await fs.write('data/input.csv', b'col1,col2\\n1,2\\n', connection_id=1)
    data = await fs.read('data/input.csv', connection_id=1)
    entries = await fs.list_dir('data/')
"""

import uuid
from dataclasses import dataclass, field
from enum import Enum
from pathlib import PurePosixPath
from typing import Any

from .store import IStore, StorageError

# Sentinel file used to represent empty directories on object stores
DIR_MARKER = '.dirmarker'


class FileHandleMode(Enum):
    """Mode for an open file handle."""

    READ = 'r'
    WRITE = 'w'


@dataclass
class FileHandle:
    """Tracks an open file handle and its backend-specific context."""

    handle_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    path: str = ''
    mode: FileHandleMode = FileHandleMode.READ
    connection_id: int = 0
    context: Any = None
    offset: int = 0
    bytes_written: int = 0
    closed: bool = False


class FileStore:
    """
    General-purpose binary file system interface built on top of IStore.

    All paths are scoped to ``users/<client_id>/files/`` within the storage
    backend, providing per-account isolation. All I/O is raw bytes.

    Handle-based operations (open_write/read, write_chunk/read_chunk, close)
    allow streaming large files without buffering everything in memory.
    Each handle is tagged with a connection_id so it can be cleaned up when
    the owning connection terminates.
    """

    def __init__(self, store: IStore, client_id: str):
        """Initialize FileStore scoped to a specific account."""
        if not client_id:
            raise ValueError('client_id is required')
        self._store = store
        self._client_id = client_id
        self._handles: dict[str, FileHandle] = {}
        self._write_locks: set[str] = set()

    # =========================================================================
    # Handle-Based Write Operations
    # =========================================================================

    async def open_write(self, path: str, connection_id: int) -> str:
        """
        Open a file for writing.

        Args:
            path: Relative path within the account store.
            connection_id: ID of the owning connection (for cleanup on disconnect).

        Returns:
            Handle ID string.

        Raises:
            StorageError: If the path is already open for writing.
        """
        full_path = self._full_path(path)
        if full_path in self._write_locks:
            raise StorageError(f'File already open for writing: {path}')

        result = await self._store.open_write(full_path)
        handle = FileHandle(
            path=full_path,
            mode=FileHandleMode.WRITE,
            connection_id=connection_id,
            context=result['context'],
        )
        self._handles[handle.handle_id] = handle
        self._write_locks.add(full_path)
        return handle.handle_id

    async def write_chunk(self, handle_id: str, data: bytes) -> int:
        """
        Write data to an open write handle.

        Args:
            handle_id: Handle returned by open_write.
            data: Bytes to append.

        Returns:
            Number of bytes written.
        """
        handle = self._get_handle(handle_id, FileHandleMode.WRITE)
        written = await self._store.write_chunk(handle.path, handle.context, data)
        handle.bytes_written += written
        return written

    async def close_write(self, handle_id: str) -> None:
        """Close a write handle, committing the data."""
        handle = self._get_handle(handle_id, FileHandleMode.WRITE)
        try:
            await self._store.close_write(handle.path, handle.context)
        finally:
            self._release_handle(handle)

    # =========================================================================
    # Handle-Based Read Operations
    # =========================================================================

    async def open_read(self, path: str, connection_id: int, offset: int = 0) -> dict:
        """
        Open a file for reading.

        Args:
            path: Relative path within the account store.
            connection_id: ID of the owning connection (for cleanup on disconnect).
            offset: Initial byte offset.

        Returns:
            Dict with 'handle' (str) and 'size' (int).
        """
        full_path = self._full_path(path)
        result = await self._store.open_read(full_path)
        handle = FileHandle(
            path=full_path,
            mode=FileHandleMode.READ,
            connection_id=connection_id,
            context=result['context'],
            offset=offset,
        )
        self._handles[handle.handle_id] = handle
        return {'handle': handle.handle_id, 'size': result['size']}

    async def read_chunk(self, handle_id: str, length: int = 4_194_304) -> bytes:
        """
        Read data from an open read handle.

        Args:
            handle_id: Handle returned by open_read.
            length: Max bytes to read (default 4 MB).

        Returns:
            Bytes read. Empty bytes indicates EOF.
        """
        handle = self._get_handle(handle_id, FileHandleMode.READ)
        data = await self._store.read_chunk(handle.path, handle.context, handle.offset, length)
        handle.offset += len(data)
        return data

    async def close_read(self, handle_id: str) -> None:
        """Close a read handle."""
        handle = self._get_handle(handle_id, FileHandleMode.READ)
        try:
            await self._store.close_read(handle.path, handle.context)
        finally:
            self._release_handle(handle)

    # =========================================================================
    # Connection Cleanup
    # =========================================================================

    async def close_all_handles(self, connection_id: int) -> None:
        """
        Force-close all handles owned by the given connection.

        Called when a connection terminates to prevent resource leaks.
        Write handles are committed with whatever data has been written.
        """
        handles_to_close = [h for h in self._handles.values() if h.connection_id == connection_id]
        for handle in handles_to_close:
            await self._force_close_handle(handle.handle_id)

    # =========================================================================
    # Convenience Methods (fire-and-forget, use handles internally)
    # =========================================================================

    async def read(self, path: str, connection_id: int = 0) -> bytes:
        """
        Read file contents as raw bytes.

        Args:
            path: Relative path within the account store.
            connection_id: Owning connection ID.

        Returns:
            Raw bytes of the file.

        Raises:
            StorageError: If the file does not exist or read fails.
        """
        info = await self.open_read(path, connection_id)
        try:
            chunks = []
            while True:
                chunk = await self.read_chunk(info['handle'])
                if not chunk:
                    break
                chunks.append(chunk)
            return b''.join(chunks)
        finally:
            await self.close_read(info['handle'])

    async def write(self, path: str, data: bytes, connection_id: int = 0) -> None:
        """
        Write raw bytes to a file.

        Args:
            path: Relative path within the account store.
            data: Raw bytes to write.
            connection_id: Owning connection ID.

        Raises:
            StorageError: If write fails.
        """
        handle_id = await self.open_write(path, connection_id)
        try:
            await self.write_chunk(handle_id, data)
            await self.close_write(handle_id)
        except Exception:
            await self._force_close_handle(handle_id)
            raise

    async def delete(self, path: str) -> None:
        """
        Delete a file.

        Args:
            path: Relative path within the account store.

        Raises:
            StorageError: If file does not exist or delete fails.
        """
        full_path = self._full_path(path)
        await self._store.delete_file(full_path)

    async def list_dir(self, path: str = '') -> dict:
        """
        List immediate children of a directory.

        Args:
            path: Relative directory path (default: account root).

        Returns:
            Dict with keys: entries (list of {name, type, modified?}), count.
            File entries include a modified epoch timestamp.
        """
        prefix = self._full_path(path)
        if not prefix.endswith('/'):
            prefix += '/'

        all_files = await self._store.list_files(prefix)

        # Track entries; for files, keep the full path for mtime lookup
        entries_map: dict[str, dict] = {}
        for file_path in all_files:
            relative = file_path[len(prefix) :]
            if not relative:
                continue

            parts = relative.split('/')
            name = parts[0]

            if name == DIR_MARKER:
                continue

            if len(parts) == 1:
                if name not in entries_map:
                    entries_map[name] = {'type': 'file', 'full_path': file_path}
            else:
                entries_map[name] = {'type': 'dir'}

        entries = []
        for name in sorted(entries_map):
            info = entries_map[name]
            entry: dict = {'name': name, 'type': info['type']}
            if info['type'] == 'file':
                try:
                    entry['modified'] = await self._store.get_modified_time(info['full_path'])
                except StorageError:
                    pass
            entries.append(entry)

        return {'entries': entries, 'count': len(entries)}

    async def mkdir(self, path: str) -> None:
        """
        Create a directory.

        Writes a zero-length .dirmarker sentinel file for object store
        compatibility.

        Args:
            path: Relative directory path.
        """
        marker_path = self._full_path(path.rstrip('/') + '/' + DIR_MARKER)
        await self._store.write_bytes(marker_path, b'')

    async def stat(self, path: str) -> dict:
        """
        Get file or directory metadata.

        Args:
            path: Relative path within the account store.

        Returns:
            Dict with keys: exists, type (file|dir), modified (epoch timestamp, files only).
        """
        full_path = self._full_path(path)

        # Try as directory first (check for children under path/)
        dir_prefix = full_path.rstrip('/') + '/'
        files = await self._store.list_files(dir_prefix)
        # Only count as directory if there are files strictly inside the prefix
        if any(f != full_path and f.startswith(dir_prefix) for f in files):
            return {'exists': True, 'type': 'dir'}

        # Try as file
        try:
            modified = await self._store.get_modified_time(full_path)
            return {'exists': True, 'type': 'file', 'modified': modified}
        except StorageError:
            pass

        return {'exists': False}

    # =========================================================================
    # Private Methods
    # =========================================================================

    def _get_handle(self, handle_id: str, expected_mode: FileHandleMode) -> FileHandle:
        """Look up a handle and validate its state."""
        handle = self._handles.get(handle_id)
        if handle is None:
            raise StorageError(f'Invalid handle: {handle_id}')
        if handle.closed:
            raise StorageError(f'Handle already closed: {handle_id}')
        if handle.mode != expected_mode:
            raise StorageError(f'Wrong handle mode: expected {expected_mode.value}, got {handle.mode.value}')
        return handle

    def _release_handle(self, handle: FileHandle) -> None:
        """Remove a handle from the registry and release any write lock."""
        handle.closed = True
        self._handles.pop(handle.handle_id, None)
        if handle.mode == FileHandleMode.WRITE:
            self._write_locks.discard(handle.path)

    async def _force_close_handle(self, handle_id: str) -> None:
        """Force-close a handle, committing any written data. Best-effort."""
        handle = self._handles.get(handle_id)
        if handle is None or handle.closed:
            return
        try:
            if handle.mode == FileHandleMode.WRITE:
                await self._store.close_write(handle.path, handle.context)
            else:
                await self._store.close_read(handle.path, handle.context)
        except Exception:
            pass
        finally:
            self._release_handle(handle)

    @staticmethod
    def _validate_path(path: str) -> str:
        """Validate and normalize a user-provided path."""
        path = path.replace('\\', '/')

        if path.startswith('/'):
            path = path.lstrip('/')

        parts = path.split('/')
        if '..' in parts:
            raise ValueError(f'Path traversal not allowed: {path}')

        normalized = str(PurePosixPath(path)) if path else ''
        if normalized == '.':
            normalized = ''

        return normalized

    def _full_path(self, path: str) -> str:
        """Build the full storage path: users/<client_id>/files/<path>."""
        validated = self._validate_path(path)
        if validated:
            return f'users/{self._client_id}/files/{validated}'
        return f'users/{self._client_id}/files'


__all__ = [
    'FileStore',
    'FileHandle',
    'FileHandleMode',
    'DIR_MARKER',
]
