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

from rocketlib import debug

from .store import IStore, StorageError

# Sentinel file used to represent empty directories on object stores
DIR_MARKER = '.dirmarker'

# Maximum bytes a single read_chunk call may return
MAX_CHUNK_SIZE = 4_194_304  # 4 MB

# Maximum open handles per connection (DoS bound). Only enforced when
# connection_id is non-zero — zero means "unowned", used by tests.
MAX_HANDLES_PER_CONNECTION = 64

# Characters forbidden inside any single path segment. ':' blocks Windows
# drive-letter syntax (C:\...) from leaking through after the '\\' -> '/'
# conversion in _validate_path.
_INVALID_SEGMENT_CHARS = frozenset('*?<>|":\x00')


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
        if '/' in client_id or '\\' in client_id:
            raise ValueError('client_id must not contain path separators')
        if client_id in ('.', '..'):
            raise ValueError('client_id must not be "." or ".."')
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
        if connection_id and self._count_handles_for(connection_id) >= MAX_HANDLES_PER_CONNECTION:
            raise StorageError(f'Too many open handles for connection {connection_id}')

        # Acquire lock before awaiting to prevent races at suspension points
        self._write_locks.add(full_path)
        try:
            result = await self._store.open_write(full_path)
        except BaseException:
            # Catch BaseException so asyncio.CancelledError (BaseException
            # subclass since Python 3.8) still releases the lock on cancel.
            self._write_locks.discard(full_path)
            raise

        handle = FileHandle(
            path=full_path,
            mode=FileHandleMode.WRITE,
            connection_id=connection_id,
            context=result['context'],
        )
        self._handles[handle.handle_id] = handle
        return handle.handle_id

    async def write_chunk(self, handle_id: str, data: bytes, connection_id: int = 0) -> int:
        """
        Write data to an open write handle.

        Args:
            handle_id: Handle returned by open_write.
            data: Bytes to append.
            connection_id: Caller's connection ID for ownership check.

        Returns:
            Number of bytes written.
        """
        handle = self._get_handle(handle_id, FileHandleMode.WRITE, connection_id)
        written = await self._store.write_chunk(handle.path, handle.context, data)
        handle.bytes_written += written
        return written

    async def close_write(self, handle_id: str, connection_id: int = 0) -> None:
        """Close a write handle, committing the data."""
        handle = self._get_handle(handle_id, FileHandleMode.WRITE, connection_id)
        try:
            await self._store.close_write(handle.path, handle.context)
        finally:
            self._release_handle(handle)

    # =========================================================================
    # Handle-Based Read Operations
    # =========================================================================

    async def open_read(self, path: str, connection_id: int) -> dict:
        """
        Open a file for reading.

        Args:
            path: Relative path within the account store.
            connection_id: ID of the owning connection (for cleanup on disconnect).

        Returns:
            Dict with 'handle' (str) and 'size' (int).
        """
        full_path = self._full_path(path)
        if connection_id and self._count_handles_for(connection_id) >= MAX_HANDLES_PER_CONNECTION:
            raise StorageError(f'Too many open handles for connection {connection_id}')
        result = await self._store.open_read(full_path)
        handle = FileHandle(
            path=full_path,
            mode=FileHandleMode.READ,
            connection_id=connection_id,
            context=result['context'],
        )
        self._handles[handle.handle_id] = handle
        return {'handle': handle.handle_id, 'size': result['size']}

    async def read_chunk(self, handle_id: str, offset: int, length: int = MAX_CHUNK_SIZE, connection_id: int = 0) -> bytes:
        """
        Read data from an open read handle.

        Args:
            handle_id: Handle returned by open_read.
            offset: Byte offset to read from.
            length: Max bytes to read (default 4 MB, capped at MAX_CHUNK_SIZE).

        Returns:
            Bytes read. Empty bytes indicates EOF.
        """
        if offset < 0:
            raise StorageError(f'Offset must be non-negative, got {offset}')
        if length <= 0:
            raise StorageError(f'Read length must be positive, got {length}')
        length = min(length, MAX_CHUNK_SIZE)
        handle = self._get_handle(handle_id, FileHandleMode.READ, connection_id)
        return await self._store.read_chunk(handle.path, handle.context, offset, length)

    async def close_read(self, handle_id: str, connection_id: int = 0) -> None:
        """Close a read handle."""
        handle = self._get_handle(handle_id, FileHandleMode.READ, connection_id)
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
            offset = 0
            while True:
                chunk = await self.read_chunk(info['handle'], offset)
                if not chunk:
                    break
                chunks.append(chunk)
                offset += len(chunk)
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
            StorageError: If file does not exist, delete fails, or file is open for writing.
        """
        full_path = self._full_path(path)
        if full_path in self._write_locks:
            raise StorageError(f'Cannot delete file while it is open for writing: {path}')
        await self._store.delete_file(full_path)

    async def list_dir(self, path: str = '') -> dict:
        """
        List immediate children of a directory.

        Args:
            path: Relative directory path (default: account root).

        Returns:
            Dict with keys: entries (list of {name, type, size?, modified?}), count.
            File entries include size (bytes) and modified (epoch timestamp).
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
            meta = entries_map[name]
            entry: dict = {'name': name, 'type': meta['type']}
            if meta['type'] == 'file':
                try:
                    file_info = await self._store.get_file_info(meta['full_path'])
                    entry['size'] = file_info['size']
                    entry['modified'] = file_info['modified']
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

    async def rmdir(self, path: str, recursive: bool = False) -> None:
        """
        Remove a directory.

        Args:
            path: Relative directory path. Must be non-empty — an empty/root
                path is rejected to prevent accidental account wipes.
            recursive: If True, delete all contents recursively (default: False).

        Raises:
            StorageError: If the directory is not empty and recursive is False,
                any file under the prefix is currently open, or one or more
                backend deletes fail (partial-failure errors are aggregated).
        """
        # Reject empty/root paths up front: _full_path('') resolves to the
        # account root, and list_files on that prefix would enumerate every
        # file owned by the account — a single bad caller could wipe the store.
        validated = self._validate_path(path)
        if not validated:
            raise StorageError('rmdir requires a non-empty path')

        full_prefix = self._full_path(validated.rstrip('/') + '/')

        # Refuse if any open handle or write-lock lives under this prefix;
        # otherwise the writer's next write_chunk/close would reference a
        # deleted backend path with undefined behavior.
        self._assert_no_active_handles_under(full_prefix)

        all_files = await self._store.list_files(full_prefix)

        # Ignore the dirmarker sentinel when checking emptiness
        non_marker = [f for f in all_files if not f.endswith('/' + DIR_MARKER)]

        if not recursive and non_marker:
            raise StorageError(f'Directory not empty: {path}')

        # Collect per-file failures so a partial rmdir is visible to callers
        # rather than silently reported as success.
        errors: list[str] = []
        for f in all_files:
            try:
                await self._store.delete_file(f)
            except StorageError as e:
                errors.append(f'{f}: {e}')
        if errors:
            raise StorageError(f'rmdir partial failure ({len(errors)} file(s)): {"; ".join(errors)}')

    async def rename(self, old_path: str, new_path: str, overwrite: bool = False) -> None:
        """
        Rename a file or directory.

        On object stores there is no native rename, so this is implemented as
        copy + delete.  For directories every file under the old prefix is
        copied to the new prefix and then deleted.

        Args:
            old_path: Current relative path within the account store.
            new_path: New relative path within the account store.
            overwrite: When False (default) the call fails if the destination
                already exists. Pass True to replace the destination.

        Raises:
            StorageError: If old_path does not exist, is open for reading or
                writing, the destination already exists without ``overwrite``,
                or the operation fails.
        """
        old_full = self._full_path(old_path)
        new_full = self._full_path(new_path)

        # Check for directory (has children under old_path/)
        dir_prefix = old_full.rstrip('/') + '/'
        all_files = await self._store.list_files(dir_prefix)

        if all_files:
            # Directory rename: refuse if any source file is open, then check
            # destination collision before starting the copy loop.
            self._assert_no_active_handles_under(dir_prefix)
            new_dir_prefix = new_full.rstrip('/') + '/'
            self._assert_no_active_handles_under(new_dir_prefix)
            if not overwrite:
                existing = await self._store.list_files(new_dir_prefix)
                if existing:
                    raise StorageError(f'Destination already exists: {new_path}')
            for file_path in all_files:
                relative_to_old = file_path[len(dir_prefix) :]
                new_file_path = new_dir_prefix + relative_to_old
                data = await self._store.read_bytes(file_path)
                await self._store.write_bytes(new_file_path, data)
                await self._store.delete_file(file_path)
        else:
            # File rename: check both source and destination locks, then
            # check destination existence unless overwrite was requested.
            if old_full in self._write_locks:
                raise StorageError(f'Cannot rename file while it is open for writing: {old_path}')
            if new_full in self._write_locks:
                raise StorageError(f'Cannot rename onto file that is open for writing: {new_path}')
            if not overwrite:
                dest_exists = False
                try:
                    info = await self._store.get_file_info(new_full)
                    dest_exists = bool(info)
                except StorageError:
                    # get_file_info raises when the key does not exist — good,
                    # destination is clear and rename can proceed.
                    pass
                if dest_exists:
                    raise StorageError(f'Destination already exists: {new_path}')
            data = await self._store.read_bytes(old_full)
            await self._store.write_bytes(new_full, data)
            await self._store.delete_file(old_full)

    async def stat(self, path: str) -> dict:
        """
        Get file or directory metadata.

        Args:
            path: Relative path within the account store.

        Returns:
            Dict with keys: exists, type (file|dir), size (bytes, files only),
            modified (epoch timestamp, files only).
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
            file_info = await self._store.get_file_info(full_path)
            return {'exists': True, 'type': 'file', 'size': file_info['size'], 'modified': file_info['modified']}
        except StorageError:
            pass

        return {'exists': False}

    # =========================================================================
    # Private Methods
    # =========================================================================

    def _get_handle(self, handle_id: str, expected_mode: FileHandleMode, connection_id: int = 0) -> FileHandle:
        """Look up a handle and validate its state and ownership."""
        handle = self._handles.get(handle_id)
        if handle is None:
            raise StorageError(f'Invalid handle: {handle_id}')
        if handle.closed:
            raise StorageError(f'Handle already closed: {handle_id}')
        if handle.mode != expected_mode:
            raise StorageError(f'Wrong handle mode: expected {expected_mode.value}, got {handle.mode.value}')
        if connection_id and handle.connection_id and handle.connection_id != connection_id:
            raise StorageError('Handle belongs to another connection')
        return handle

    def _release_handle(self, handle: FileHandle) -> None:
        """Remove a handle from the registry and release any write lock."""
        handle.closed = True
        self._handles.pop(handle.handle_id, None)
        if handle.mode == FileHandleMode.WRITE:
            self._write_locks.discard(handle.path)

    def _count_handles_for(self, connection_id: int) -> int:
        """Count currently-open handles owned by ``connection_id`` (for the DoS cap)."""
        return sum(1 for h in self._handles.values() if h.connection_id == connection_id)

    def _assert_no_active_handles_under(self, prefix: str) -> None:
        """
        Refuse mutating operations (rmdir, rename) when any file under ``prefix``
        is currently held by a write lock or an open handle.

        Keeps the operation consistent with open writers/readers: otherwise a
        rmdir/rename would pull the rug out from under an in-flight handle,
        leading to undefined backend behavior.
        """
        for locked in self._write_locks:
            if locked == prefix.rstrip('/') or locked.startswith(prefix):
                raise StorageError(f'Cannot modify: file open for writing under {prefix}')
        for handle in self._handles.values():
            if handle.path == prefix.rstrip('/') or handle.path.startswith(prefix):
                raise StorageError(f'Cannot modify: handle open under {prefix}')

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
        except Exception as e:
            # Best-effort cleanup — log at debug level so disconnect-time
            # commit failures are traceable rather than silently lost.
            debug(f'FileStore._force_close_handle failed handle={handle_id} mode={handle.mode.value} path={handle.path}: {e}')
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

        for part in parts:
            if part and any(c in _INVALID_SEGMENT_CHARS or ord(c) < 0x20 for c in part):
                raise ValueError(f'Path contains invalid characters: {path}')

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
    'MAX_CHUNK_SIZE',
    'MAX_HANDLES_PER_CONNECTION',
    'DIR_MARKER',
]
