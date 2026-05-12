"""Filesystem storage implementation."""

import aiofiles
import aiofiles.os
import asyncio
import os
import sys
from pathlib import Path
from typing import Optional
from ..store import IStore, StorageError, VersionMismatchError

# Import platform-specific locking
if sys.platform == 'win32':
    import msvcrt
else:
    import fcntl  # type: ignore # Unix-only, not available on Windows


class FilesystemStore(IStore):
    """
    Filesystem storage implementation.

    Stores data in local or network filesystem with persistent file handles.
    Uses OS-level file locking for atomic operations.

    Fix F-05 / F-11: write_file and write_bytes now acquire an exclusive
    lock before writing, consistent with write_file_atomic and read_file.
    """

    def __init__(self, url: str, secret_key: str = None):
        """Initialize filesystem storage."""
        super().__init__(url, secret_key)

        if url.startswith('filesystem://'):
            self._root_path = Path(url[len('filesystem://'):])
        else:
            raise ValueError(f'Invalid filesystem URL: {url}')

        self._root_path = self._root_path.resolve()

    # =========================================================================
    # Public Methods (IStore Interface Implementation)
    # =========================================================================

    async def write_file(self, filename: str, data: str) -> None:
        """
        Write data to file.

        Fix F-05: acquires an exclusive flock before writing so that
        concurrent coroutines writing to the same path are serialised and
        cannot interleave their output.
        """
        try:
            full_path = self._get_full_path(filename)
            full_path.parent.mkdir(parents=True, exist_ok=True)

            lock_path = full_path.parent / f'.{full_path.name}.lock'
            lock_fd = os.open(str(lock_path), os.O_CREAT | os.O_RDWR, 0o644)

            try:
                await self._acquire_lock(lock_fd, shared=False)
                async with aiofiles.open(full_path, 'w', encoding='utf-8') as f:
                    await f.write(data)
            finally:
                await self._release_lock(lock_fd)
                os.close(lock_fd)

        except Exception as e:
            raise StorageError(f'Failed to write file {filename}: {e}') from e

    async def read_file(self, filename: str) -> str:
        """
        Read data from file.

        Uses shared locking to prevent reading while write is in progress.
        """
        try:
            full_path = self._get_full_path(filename)

            if not full_path.exists():
                raise StorageError(f'File not found: {filename}')

            lock_path = full_path.parent / f'.{full_path.name}.lock'
            full_path.parent.mkdir(parents=True, exist_ok=True)
            lock_fd = os.open(str(lock_path), os.O_CREAT | os.O_RDWR, 0o644)

            try:
                await self._acquire_lock(lock_fd, shared=True)
                async with aiofiles.open(full_path, 'r', encoding='utf-8') as f:
                    return await f.read()
            finally:
                await self._release_lock(lock_fd)
                os.close(lock_fd)

        except StorageError:
            raise
        except Exception as e:
            raise StorageError(f'Failed to read file {filename}: {e}') from e

    async def read_file_with_metadata(self, filename: str) -> tuple:
        """
        Read data from file with metadata.

        Uses shared locking to prevent reading while write is in progress.
        """
        try:
            full_path = self._get_full_path(filename)

            if not full_path.exists():
                raise StorageError(f'File not found: {filename}')

            lock_path = full_path.parent / f'.{full_path.name}.lock'
            full_path.parent.mkdir(parents=True, exist_ok=True)
            lock_fd = os.open(str(lock_path), os.O_CREAT | os.O_RDWR, 0o644)

            try:
                await self._acquire_lock(lock_fd, shared=True)
                async with aiofiles.open(full_path, 'r', encoding='utf-8') as f:
                    content = await f.read()
                mtime = full_path.stat().st_mtime
                return (content, str(mtime))
            finally:
                await self._release_lock(lock_fd)
                os.close(lock_fd)

        except StorageError:
            raise
        except Exception as e:
            raise StorageError(f'Failed to read file {filename}: {e}') from e

    async def write_file_atomic(self, filename: str, data: str, expected_version: Optional[str] = None) -> str:
        """
        Write data to file atomically with version check.

        Uses file locking to prevent race conditions during read-check-write sequence.
        """
        try:
            full_path = self._get_full_path(filename)
            full_path.parent.mkdir(parents=True, exist_ok=True)

            lock_path = full_path.parent / f'.{full_path.name}.lock'
            lock_fd = os.open(str(lock_path), os.O_CREAT | os.O_RDWR, 0o644)

            try:
                await self._acquire_lock(lock_fd, shared=False)

                if full_path.exists() and expected_version is not None:
                    current_mtime = str(full_path.stat().st_mtime)
                    if current_mtime != expected_version:
                        raise VersionMismatchError(
                            filename=filename,
                            expected_version=expected_version,
                            actual_version=current_mtime,
                        )

                async with aiofiles.open(full_path, 'w', encoding='utf-8') as f:
                    await f.write(data)

                return str(full_path.stat().st_mtime)

            finally:
                await self._release_lock(lock_fd)
                os.close(lock_fd)

        except StorageError:
            raise
        except Exception as e:
            raise StorageError(f'Failed to write file {filename}: {e}') from e

    async def delete_file(self, filename: str, expected_version: Optional[str] = None) -> None:
        """Delete file with optional version check."""
        try:
            full_path = self._get_full_path(filename)

            if not full_path.exists():
                raise StorageError(f'File not found: {filename}')

            lock_path = full_path.parent / f'.{full_path.name}.lock'
            lock_fd = os.open(str(lock_path), os.O_CREAT | os.O_RDWR, 0o644)

            try:
                await self._acquire_lock(lock_fd, shared=False)

                if not full_path.exists():
                    raise StorageError(f'File not found: {filename}')

                if expected_version is not None:
                    current_mtime = str(full_path.stat().st_mtime)
                    if current_mtime != expected_version:
                        raise VersionMismatchError(
                            filename=filename,
                            expected_version=expected_version,
                            actual_version=current_mtime,
                        )

                full_path.unlink()

            finally:
                await self._release_lock(lock_fd)
                os.close(lock_fd)

                try:
                    if lock_path.exists():
                        lock_path.unlink()
                except Exception:
                    pass

        except StorageError:
            raise
        except Exception as e:
            raise StorageError(f'Failed to delete file {filename}: {e}') from e

    async def get_modified_time(self, filename: str) -> float:
        """Get the last modified time of a file as an epoch timestamp."""
        info = await self.get_file_info(filename)
        return info['modified']

    async def get_file_info(self, filename: str) -> dict:
        """Get file size and modification time in a single stat call."""
        try:
            full_path = self._get_full_path(filename)
            if not full_path.is_file():
                raise StorageError(f'File not found: {filename}')
            st = full_path.stat()
            return {'size': st.st_size, 'modified': st.st_mtime}
        except StorageError:
            raise
        except Exception as e:
            raise StorageError(f'Failed to stat file {filename}: {e}') from e

    async def write_bytes(self, filename: str, data: bytes) -> None:
        """
        Write binary data to file.

        Fix F-11: acquires an exclusive lock before writing binary data,
        consistent with the text write_file fix (F-05).
        """
        try:
            full_path = self._get_full_path(filename)
            full_path.parent.mkdir(parents=True, exist_ok=True)

            lock_path = full_path.parent / f'.{full_path.name}.lock'
            lock_fd = os.open(str(lock_path), os.O_CREAT | os.O_RDWR, 0o644)

            try:
                await self._acquire_lock(lock_fd, shared=False)
                async with aiofiles.open(full_path, 'wb') as f:
                    await f.write(data)
            finally:
                await self._release_lock(lock_fd)
                os.close(lock_fd)

        except Exception as e:
            raise StorageError(f'Failed to write file {filename}: {e}') from e

    async def read_bytes(self, filename: str) -> bytes:
        """Read binary data from file."""
        try:
            full_path = self._get_full_path(filename)
            if not full_path.exists():
                raise StorageError(f'File not found: {filename}')
            async with aiofiles.open(full_path, 'rb') as f:
                return await f.read()
        except StorageError:
            raise
        except Exception as e:
            raise StorageError(f'Failed to read file {filename}: {e}') from e

    async def list_files(self, prefix: str = '') -> list:
        """List all files with given prefix."""
        try:
            if prefix:
                search_path = self._get_full_path(prefix)
            else:
                search_path = self._root_path

            files = []

            if search_path.exists():
                if search_path.is_file():
                    relative_path = str(search_path.relative_to(self._root_path))
                    files.append(relative_path.replace('\\', '/'))
                elif search_path.is_dir():
                    for item in search_path.rglob('*'):
                        if item.is_file():
                            relative_path = str(item.relative_to(self._root_path))
                            files.append(relative_path.replace('\\', '/'))

            return sorted(files)

        except Exception as e:
            raise StorageError(f'Failed to list files with prefix {prefix}: {e}') from e

    # =========================================================================
    # Handle-Based I/O
    # =========================================================================

    async def open_write(self, filename: str) -> dict:
        """Open a file for writing. Returns context with aiofiles handle."""
        try:
            full_path = self._get_full_path(filename)
            full_path.parent.mkdir(parents=True, exist_ok=True)
            f = await aiofiles.open(full_path, 'wb')
            return {'context': {'file': f, 'path': full_path}}
        except Exception as e:
            raise StorageError(f'Failed to open file {filename} for writing: {e}') from e

    async def write_chunk(self, filename: str, context, data: bytes) -> int:
        """Write a chunk to the open file handle."""
        try:
            f = context['file']
            await f.write(data)
            return len(data)
        except Exception as e:
            raise StorageError(f'Failed to write chunk to {filename}: {e}') from e

    async def close_write(self, filename: str, context) -> None:
        """Close the file handle, committing the data."""
        try:
            f = context['file']
            await f.close()
        except Exception as e:
            raise StorageError(f'Failed to close file {filename}: {e}') from e

    async def open_read(self, filename: str) -> dict:
        """Open a file for reading. Returns context with aiofiles handle and file size."""
        try:
            full_path = self._get_full_path(filename)
            if not full_path.exists():
                raise StorageError(f'File not found: {filename}')
            size = full_path.stat().st_size
            f = await aiofiles.open(full_path, 'rb')
            return {'context': {'file': f, 'path': full_path}, 'size': size}
        except StorageError:
            raise
        except Exception as e:
            raise StorageError(f'Failed to open file {filename} for reading: {e}') from e

    async def read_chunk(self, filename: str, context, offset: int, length: int = 4_194_304) -> bytes:
        """Read a chunk from the open file handle at the given offset."""
        try:
            f = context['file']
            await f.seek(offset)
            return await f.read(length)
        except Exception as e:
            raise StorageError(f'Failed to read chunk from {filename}: {e}') from e

    async def close_read(self, filename: str, context) -> None:
        """Close the read file handle."""
        try:
            f = context['file']
            await f.close()
        except Exception as e:
            raise StorageError(f'Failed to close file {filename}: {e}') from e

    # =========================================================================
    # Private Methods
    # =========================================================================

    async def _acquire_lock(self, lock_fd: int, shared: bool = False) -> None:
        """Acquire file lock (platform-specific)."""

        def _lock():
            if sys.platform == 'win32':
                msvcrt.locking(lock_fd, msvcrt.LK_LOCK, 1)
            else:
                if shared:
                    fcntl.flock(lock_fd, fcntl.LOCK_SH)
                else:
                    fcntl.flock(lock_fd, fcntl.LOCK_EX)

        await asyncio.get_event_loop().run_in_executor(None, _lock)

    async def _release_lock(self, lock_fd: int) -> None:
        """Release file lock (platform-specific)."""

        def _unlock():
            if sys.platform == 'win32':
                msvcrt.locking(lock_fd, msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(lock_fd, fcntl.LOCK_UN)

        await asyncio.get_event_loop().run_in_executor(None, _unlock)

    def _get_full_path(self, path: str) -> Path:
        """Convert relative path to full filesystem path."""
        path = path.replace('\\', '/')
        full_path = self._root_path / path

        try:
            full_path = full_path.resolve()
            full_path.relative_to(self._root_path.resolve())
        except ValueError as exc:
            raise StorageError(f'Path traversal detected: {path}') from exc

        return full_path
