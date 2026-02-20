"""Filesystem storage implementation."""

import aiofiles
import aiofiles.os
import asyncio
import hashlib
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
    """

    # =========================================================================
    # Initialization
    # =========================================================================

    def __init__(self, url: str, secret_key: str = None):
        """Initialize filesystem storage."""
        super().__init__(url, secret_key)

        if url.startswith('filesystem://'):
            self._root_path = Path(url[len('filesystem://') :])
        else:
            raise ValueError(f'Invalid filesystem URL: {url}')

        self._root_path = self._root_path.resolve()

    # =========================================================================
    # Public Methods (IStore Interface Implementation)
    # =========================================================================

    async def write_file(self, filename: str, data: str) -> None:
        """Write data to file."""
        try:
            full_path = self._get_full_path(filename)

            # Create parent directories
            full_path.parent.mkdir(parents=True, exist_ok=True)

            # Write file
            async with aiofiles.open(full_path, 'w', encoding='utf-8') as f:
                await f.write(data)

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

            # Create lock file for this resource
            lock_path = full_path.parent / f'.{full_path.name}.lock'

            # Ensure parent directory exists
            full_path.parent.mkdir(parents=True, exist_ok=True)

            # Open/create lock file
            lock_fd = os.open(str(lock_path), os.O_CREAT | os.O_RDWR, 0o644)

            try:
                # Acquire shared lock (allows multiple concurrent reads)
                await self._acquire_lock(lock_fd, shared=True)

                # Read file while holding shared lock
                async with aiofiles.open(full_path, 'r', encoding='utf-8') as f:
                    return await f.read()

            finally:
                # Release lock
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

            # Create lock file for this resource
            lock_path = full_path.parent / f'.{full_path.name}.lock'

            # Ensure parent directory exists
            full_path.parent.mkdir(parents=True, exist_ok=True)

            # Open/create lock file
            lock_fd = os.open(str(lock_path), os.O_CREAT | os.O_RDWR, 0o644)

            try:
                # Acquire shared lock (allows multiple concurrent reads)
                await self._acquire_lock(lock_fd, shared=True)

                # Read file while holding shared lock
                async with aiofiles.open(full_path, 'r', encoding='utf-8') as f:
                    content = await f.read()

                # Calculate version
                version = hashlib.sha256(content.encode('utf-8')).hexdigest()
                return (content, version)

            finally:
                # Release lock
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

            # Create parent directories
            full_path.parent.mkdir(parents=True, exist_ok=True)

            # Create lock file for this resource
            lock_path = full_path.parent / f'.{full_path.name}.lock'

            # Open/create lock file
            lock_fd = os.open(str(lock_path), os.O_CREAT | os.O_RDWR, 0o644)

            try:
                # Acquire exclusive lock (blocks until available)
                # This makes the entire read-check-write sequence atomic
                # Exclusive lock blocks both readers and other writers
                await self._acquire_lock(lock_fd, shared=False)

                # Now we have exclusive access - check version
                if full_path.exists():
                    # File exists - expected_version is REQUIRED for updates
                    if expected_version is None:
                        raise StorageError(f'Expected version is required when updating existing file: {filename}')

                    # Read current content and verify version
                    async with aiofiles.open(full_path, 'r', encoding='utf-8') as f:
                        current_content = await f.read()
                    current_version = hashlib.sha256(current_content.encode('utf-8')).hexdigest()

                    if current_version != expected_version:
                        raise VersionMismatchError(
                            filename=filename,
                            expected_version=expected_version,
                            actual_version=current_version,
                        )

                # Write file while holding lock
                async with aiofiles.open(full_path, 'w', encoding='utf-8') as f:
                    await f.write(data)

                # Calculate new version
                new_version = hashlib.sha256(data.encode('utf-8')).hexdigest()

                return new_version

            finally:
                # Release lock and close file descriptor
                await self._release_lock(lock_fd)
                os.close(lock_fd)

        except StorageError:
            raise
        except Exception as e:
            raise StorageError(f'Failed to write file {filename}: {e}') from e

    async def delete_file(self, filename: str, expected_version: Optional[str] = None) -> None:
        """
        Delete file with optional version check.

        Uses file locking to prevent race conditions during read-check-delete sequence.
        """
        try:
            full_path = self._get_full_path(filename)

            if not full_path.exists():
                raise StorageError(f'File not found: {filename}')

            # Create lock file for this resource
            lock_path = full_path.parent / f'.{full_path.name}.lock'

            # Open/create lock file
            lock_fd = os.open(str(lock_path), os.O_CREAT | os.O_RDWR, 0o644)

            try:
                # Acquire exclusive lock
                # Blocks until no readers or writers
                await self._acquire_lock(lock_fd, shared=False)

                # Check file still exists (might have been deleted while waiting for lock)
                if not full_path.exists():
                    raise StorageError(f'File not found: {filename}')

                # expected_version is REQUIRED for delete operations
                if expected_version is None:
                    raise StorageError(f'Expected version is required when deleting file: {filename}')

                # Verify version matches
                async with aiofiles.open(full_path, 'r', encoding='utf-8') as f:
                    current_content = await f.read()
                current_version = hashlib.sha256(current_content.encode('utf-8')).hexdigest()

                if current_version != expected_version:
                    raise VersionMismatchError(
                        filename=filename,
                        expected_version=expected_version,
                        actual_version=current_version,
                    )

                # Delete file while holding lock
                full_path.unlink()

            finally:
                # Release lock and close file descriptor
                await self._release_lock(lock_fd)
                os.close(lock_fd)

                # Clean up lock file if it exists
                try:
                    if lock_path.exists():
                        lock_path.unlink()
                except Exception:  # noqa: S110
                    pass  # Ignore cleanup errors

        except StorageError:
            raise
        except Exception as e:
            raise StorageError(f'Failed to delete file {filename}: {e}') from e

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
                    # If prefix points to a file, return just that file
                    relative_path = str(search_path.relative_to(self._root_path))
                    files.append(relative_path.replace('\\', '/'))
                elif search_path.is_dir():
                    # If prefix points to a directory, list all files recursively
                    for item in search_path.rglob('*'):
                        if item.is_file():
                            relative_path = str(item.relative_to(self._root_path))
                            files.append(relative_path.replace('\\', '/'))

            return sorted(files)

        except Exception as e:
            raise StorageError(f'Failed to list files with prefix {prefix}: {e}') from e

    # =========================================================================
    # Private Methods
    # =========================================================================

    async def _acquire_lock(self, lock_fd: int, shared: bool = False) -> None:
        """
        Acquire file lock (platform-specific).

        Args:
            lock_fd: File descriptor for lock file
            shared: If True, acquire shared lock (multiple readers).
                   If False, acquire exclusive lock (single writer).

        Note: Windows doesn't support shared locks, so all locks are exclusive on Windows.
        """

        def _lock():
            if sys.platform == 'win32':
                # Windows: Only supports exclusive locks
                # All operations (read/write) will be serialized
                msvcrt.locking(lock_fd, msvcrt.LK_LOCK, 1)
            else:
                # Unix: Support both shared and exclusive locks
                if shared:
                    fcntl.flock(lock_fd, fcntl.LOCK_SH)  # Shared lock for reads
                else:
                    fcntl.flock(lock_fd, fcntl.LOCK_EX)  # Exclusive lock for writes

        await asyncio.get_event_loop().run_in_executor(None, _lock)

    async def _release_lock(self, lock_fd: int) -> None:
        """Release file lock (platform-specific)."""

        def _unlock():
            if sys.platform == 'win32':
                # Windows: Unlock first byte of file
                msvcrt.locking(lock_fd, msvcrt.LK_UNLCK, 1)
            else:
                # Unix: Use flock (works for both shared and exclusive)
                fcntl.flock(lock_fd, fcntl.LOCK_UN)

        await asyncio.get_event_loop().run_in_executor(None, _unlock)

    def _get_full_path(self, path: str) -> Path:
        """Convert relative path to full filesystem path."""
        path = path.replace('\\', '/')
        full_path = self._root_path / path

        # Security check: ensure path is within root
        try:
            full_path = full_path.resolve()
            full_path.relative_to(self._root_path.resolve())
        except ValueError as exc:
            raise StorageError(f'Path traversal detected: {path}') from exc

        return full_path
