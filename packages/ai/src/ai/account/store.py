"""
Storage Interface for RocketRide Account Data.

Unified storage abstraction supporting multiple backends:
- Filesystem: Local or network file storage
- AWS S3: Amazon S3 object storage
- Azure Blob: Azure Blob Storage

Configuration via STORE_URL environment variable.
Defaults to filesystem://~/.rocketlib/dtc if not set (user home directory).
Falls back to temp directory if home directory cannot be determined.
"""

import io
import os
import re
import tempfile
from abc import ABC, abstractmethod
from pathlib import Path
from typing import TYPE_CHECKING, Any, Optional

if TYPE_CHECKING:
    from .file_store import FileStore


# Retry configuration for cloud storage operations
STORE_MAX_RETRY_ATTEMPTS = 10

# Pagination configuration for log listing
LOG_PAGE_SIZE = 100


class StorageError(Exception):
    """Base exception for storage operations."""

    pass


class VersionMismatchError(StorageError):
    """
    Exception raised when a version mismatch is detected during atomic operations.

    This error indicates that the file was modified by another process between
    reading and writing. Callers should handle this by re-reading the file
    and retrying the operation.

    Attributes:
        filename: The file that had a version mismatch
        expected_version: The version that was expected
        actual_version: The actual version found (may be None if unknown)
    """

    def __init__(self, filename: str, expected_version: Optional[str] = None, actual_version: Optional[str] = None):
        """
        Initialize VersionMismatchError.

        Args:
            filename (str): name of the file with version mismatch
            expected_version (Optional[str], optional): Expected version Defaults to None.
            actual_version (Optional[str], optional): Actual version. Defaults to None.
        """
        self.filename = filename
        self.expected_version = expected_version
        self.actual_version = actual_version

        # Build descriptive message
        msg = f'Version mismatch for {filename}'
        if expected_version is not None and actual_version is not None:
            msg += f': expected {expected_version}, found {actual_version}'
        elif expected_version is not None:
            msg += f': expected {expected_version}'

        super().__init__(msg)


class IStore(ABC):
    """Abstract base class for storage implementations."""

    def __init__(self, url: str, secret_key: Optional[str] = None):
        """
        Initialize storage backend.

        Args:
            url: Storage URL
            secret_key: Optional authentication credentials
        """
        self._url = url
        self._secret_key = secret_key

    @abstractmethod
    async def write_file(self, filename: str, data: str) -> None:  # noqa: D102
        """
        Write data to file.

        Args:
            filename: Relative path to file
            data: String data to write

        Raises:
            StorageError: If write operation fails
        """
        pass

    @abstractmethod
    async def read_file(self, filename: str) -> str:  # noqa: D102
        """
        Read data from file.

        Args:
            filename: Relative path to file

        Returns:
            File contents as string

        Raises:
            StorageError: If file doesn't exist or read fails
        """
        pass

    @abstractmethod
    async def read_file_with_metadata(self, filename: str) -> tuple:  # noqa: D102
        """
        Read data from file with metadata (version/etag).

        Args:
            filename: Relative path to file

        Returns:
            Tuple of (content, version_identifier)

        Raises:
            StorageError: If file doesn't exist or read fails
        """
        pass

    @abstractmethod
    async def write_file_atomic(self, filename: str, data: str, expected_version: Optional[str] = None) -> str:  # noqa: D102
        """
        Write data to file atomically with optional version check.

        Args:
            filename: Relative path to file
            data: String data to write
            expected_version: Expected current version (for atomic update)

        Returns:
            New version identifier after write

        Raises:
            StorageError: If write fails or version mismatch
        """
        pass

    @abstractmethod
    async def delete_file(self, filename: str, expected_version: Optional[str] = None) -> None:  # noqa: D102
        """
        Delete file with optional version check.

        Args:
            filename: Relative path to file
            expected_version: Expected current version (for atomic delete)

        Raises:
            StorageError: If file doesn't exist, delete fails, or version mismatch
        """
        pass

    async def get_modified_time(self, filename: str) -> float:
        """
        Get the last modified time of a file as an epoch timestamp.

        Default implementation delegates to get_file_info.

        Args:
            filename: Relative path to file

        Returns:
            float: Last modified time as Unix epoch timestamp

        Raises:
            StorageError: If file doesn't exist
        """
        info = await self.get_file_info(filename)
        return info['modified']

    async def get_file_info(self, filename: str) -> dict:
        """
        Get file metadata: size and modification time.

        Default implementation reads the file to confirm existence and
        returns approximate values. Backends should override with native
        metadata (stat, head_object, get_blob_properties).

        Args:
            filename: Relative path to file

        Returns:
            dict with 'size' (int, bytes) and 'modified' (float, epoch timestamp)

        Raises:
            StorageError: If file doesn't exist
        """
        import time

        data = await self.read_bytes(filename)
        return {'size': len(data), 'modified': time.time()}

    async def write_bytes(self, filename: str, data: bytes) -> None:
        """
        Write binary data to file.

        Default implementation encodes to string via latin-1.
        Backends should override for proper binary I/O.

        Args:
            filename: Relative path to file
            data: Binary data to write

        Raises:
            StorageError: If write operation fails
        """
        await self.write_file(filename, data.decode('latin-1'))

    async def read_bytes(self, filename: str) -> bytes:
        """
        Read binary data from file.

        Default implementation decodes from string via latin-1.
        Backends should override for proper binary I/O.

        Args:
            filename: Relative path to file

        Returns:
            File contents as bytes

        Raises:
            StorageError: If file doesn't exist or read fails
        """
        content = await self.read_file(filename)
        return content.encode('latin-1')

    # =========================================================================
    # Handle-Based I/O — open / read / write / close
    # =========================================================================
    #
    # Default implementations buffer everything in memory and delegate to
    # read_bytes/write_bytes on close.  Backends should override with native
    # streaming (S3 multipart, Azure staged blocks, filesystem fd).

    async def open_write(self, filename: str) -> dict:
        """
        Begin a write session for the given file.

        Returns:
            dict with backend-specific context. Must include key 'context'.
        """
        return {'context': {'buffer': bytearray(), 'filename': filename}}

    async def write_chunk(self, filename: str, context: Any, data: bytes) -> int:
        """
        Append a chunk of data to an open write session.

        Returns:
            Number of bytes written.
        """
        context['buffer'].extend(data)
        return len(data)

    async def close_write(self, filename: str, context: Any) -> None:
        """Finalize and commit the write session."""
        await self.write_bytes(filename, bytes(context['buffer']))

    async def open_read(self, filename: str) -> dict:
        """
        Begin a read session for the given file.

        Returns:
            dict with 'context' (opaque) and 'size' (total bytes).
        """
        data = await self.read_bytes(filename)
        buf = io.BytesIO(data)
        return {'context': {'buf': buf}, 'size': len(data)}

    async def read_chunk(self, filename: str, context: Any, offset: int, length: int = 4_194_304) -> bytes:
        """
        Read a chunk of data from an open read session.

        Args:
            filename: The file being read.
            context: Opaque context from open_read.
            offset: Byte offset to read from.
            length: Number of bytes to read (default 4 MB).

        Returns:
            The requested bytes. Empty bytes indicates EOF.
        """
        buf: io.BytesIO = context['buf']
        buf.seek(offset)
        return buf.read(length)

    async def close_read(self, filename: str, context: Any) -> None:
        """Close a read session and release resources."""
        buf = context.get('buf')
        if buf:
            buf.close()

    @abstractmethod
    async def list_files(self, prefix: str = '') -> list:  # noqa: D102
        """
        List all files with given prefix.

        Args:
            prefix: Path prefix to filter files

        Returns:
            List of relative file paths

        Raises:
            StorageError: If listing fails
        """
        pass


class Store:
    """
    Unified storage interface with multi-backend support and high-level project operations.

    Store provides a two-layer architecture:
    1. **Low-level operations**: Direct file I/O via proxy methods to IStore implementations
    2. **High-level operations**: Business logic for project management (save, get, delete, list)

    Architecture:
    -------------
    - Factory pattern: Store.create() instantiates backend-specific IStore implementations
    - Wrapper pattern: Store wraps IStore to add high-level business logic
    - Strategy pattern: Different storage backends (Filesystem, S3, Azure) via IStore interface

    Supported Backends:
    -------------------
    - **Filesystem**: Local or network file storage with OS-level locking
    - **AWS S3**: Cloud object storage with ETag-based versioning
    - **Azure Blob**: Cloud blob storage with ETag-based versioning

    Key Features:
    -------------
    - Atomic operations with version checking (optimistic locking)
    - Automatic retry with exponential backoff for cloud operations
    - Environment variable expansion in storage URLs
    - Per-user project isolation using client IDs

    Usage Example:
    --------------
    ```python
    from ai.account.store import Store
    from ai.account import AccountInfo

    # Create store (uses STORE_URL env var or defaults to filesystem)
    store = Store.create()

    # Or specify backend explicitly
    store = Store.create('s3://my-bucket/data', secret_key='{"access_key_id": "..."}')

    # High-level project operations
    account_info = AccountInfo(clientid='user-123', ...)
    result = await store.save_project(account_info, 'proj-1', pipeline_data)
    project = await store.get_project(account_info, 'proj-1')

    # Low-level file operations
    content = await store.read_file('path/to/file.json')
    await store.write_file('path/to/file.json', '{"key": "value"}')
    ```

    Thread Safety:
    --------------
    - Instance methods are async and should be called from the same event loop
    - Multiple Store instances can safely access the same backend
    - Atomic operations use backend-specific locking mechanisms

    Attributes:
    -----------
    _store : IStore
        The underlying storage backend implementation (Filesystem, S3, Azure)
    """

    # =========================================================================
    # Initialization
    # =========================================================================

    def __init__(self, store: IStore):
        """
        Initialize Store wrapper with an IStore backend.

        Note: Typically you should use Store.create() factory method instead
        of calling this constructor directly.

        Args:
            store: Backend storage implementation (FilesystemStore, S3Store, AzureBlobStore)
        """
        self._store = store
        self._file_stores: dict = {}

    # =========================================================================
    # Public Static Methods
    # =========================================================================

    @staticmethod
    def create(
        url: Optional[str] = None,
        secret_key: Optional[str] = None,
    ) -> 'Store':
        """
        Create storage instance.

        Args:
            url: Storage URL (overrides STORE_URL env var)
                 Default: filesystem://~/.rocketlib/dtc (user home directory)
                 Fallback: filesystem://<temp>/.rocketlib/dtc (if home unavailable)
            secret_key: Authentication credentials (overrides STORE_SECRET_KEY env var)

        Returns:
            Store instance wrapping the appropriate storage backend

        Raises:
            ValueError: If URL format is invalid or backend not supported
        """
        # Get configuration from environment if not provided
        if url is None:
            url = os.environ.get('STORE_URL')

        # Use default if not provided
        if url is None:
            url = Store._get_default_storage_url()

        if secret_key is None:
            secret_key = os.environ.get('STORE_SECRET_KEY')

        # Expand environment variables
        url = Store._expand_url_path(url)

        # Parse URL scheme
        if '://' not in url:
            raise ValueError(f'Invalid storage URL format: {url}')

        scheme, _ = url.split('://', 1)
        scheme = scheme.lower()

        # Create appropriate backend
        if scheme == 'filesystem':
            from .store_providers.filesystem import FilesystemStore

            backend = FilesystemStore(url, secret_key)

        elif scheme == 's3':
            from .store_providers.s3 import S3Store

            backend = S3Store(url, secret_key)

        elif scheme == 'azureblob' or scheme == 'azure':
            from .store_providers.azure import AzureBlobStore

            backend = AzureBlobStore(url, secret_key)

        else:
            raise ValueError(f'Unsupported storage backend: {scheme}')

        # Wrap backend in Store instance
        return Store(backend)

    def get_file_store(self, client_id: str) -> 'FileStore':
        """
        Get a FileStore instance scoped to a specific account.

        FileStore instances are cached per client_id to avoid repeated
        instantiation for the same account.

        Args:
            client_id: Account identifier for path scoping.

        Returns:
            FileStore instance scoped to the given account.
        """
        if client_id not in self._file_stores:
            from .file_store import FileStore

            self._file_stores[client_id] = FileStore(self._store, client_id)
        return self._file_stores[client_id]

    # =========================================================================
    # Private Static Methods
    # =========================================================================

    @staticmethod
    def _get_default_storage_url() -> str:
        """
        Get the default storage URL for RocketRide DTC data.

        Priority:
        1. User home directory: ~/.rocketlib/dtc
        2. Temp directory: <temp>/.rocketlib/dtc (fallback if home unavailable)

        Returns:
            str: Filesystem URL for the default storage path
        """
        try:
            # Try to get user's home directory (works on Windows/Linux/Mac)
            home = Path.home()
            storage_path = home / '.rocketlib' / 'store'
        except Exception:
            # Fallback to temp directory if home cannot be determined
            storage_path = Path(tempfile.gettempdir()) / '.rocketlib' / 'store'

        return f'filesystem://{storage_path.as_posix()}'

    @staticmethod
    def _expand_url_path(url: str) -> str:
        """Expand environment variables and tilde in URL."""

        # Expand %VAR% style (Windows)
        def replace_percent(match):
            var_name = match.group(1)
            return os.environ.get(var_name, match.group(0))

        url = re.sub(r'%([^%]+)%', replace_percent, url)

        # Expand ${VAR} style (Unix)
        def replace_brace(match):
            var_name = match.group(1)
            return os.environ.get(var_name, match.group(0))

        url = re.sub(r'\$\{([^}]+)\}', replace_brace, url)

        # Expand ~ to user home directory (only for filesystem URLs)
        if url.startswith('filesystem://'):
            scheme, path = url.split('://', 1)
            if path.startswith('~'):
                expanded_path = os.path.expanduser(path)
                url = f'{scheme}://{expanded_path}'

        return url


__all__ = [
    'Store',
    'IStore',
    'StorageError',
    'VersionMismatchError',
    'STORE_MAX_RETRY_ATTEMPTS',
    'LOG_PAGE_SIZE',
]
