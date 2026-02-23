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

import os
import re
import json
import tempfile
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Optional

from .account import AccountInfo


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

    # =========================================================================
    # Public Methods - Proxy (Direct pass-through to IStore)
    # =========================================================================

    async def read_file(self, path: str) -> str:
        """
        Read file contents from storage.

        Args:
            path: Relative path to file within storage root

        Returns:
            str: File contents as string

        Raises:
            StorageError: If file doesn't exist or read fails
        """
        return await self._store.read_file(path)

    async def write_file(self, path: str, content: str) -> None:
        """
        Write file to storage (non-atomic, overwrites existing).

        For atomic writes with version checking, use write_file_atomic() instead.

        Args:
            path: Relative path to file within storage root
            content: File contents to write

        Raises:
            StorageError: If write fails
        """
        return await self._store.write_file(path, content)

    async def read_file_with_metadata(self, path: str):
        """
        Read file contents along with version metadata.

        Returns version information (hash/ETag) for use in atomic operations.

        Args:
            path: Relative path to file within storage root

        Returns:
            tuple: (content: str, version: str) where version is hash or ETag

        Raises:
            StorageError: If file doesn't exist or read fails
        """
        return await self._store.read_file_with_metadata(path)

    async def write_file_atomic(self, path: str, content: str, expected_version: Optional[str] = None) -> str:
        """
        Write file atomically with optimistic locking.

        For updates/deletes of existing files, expected_version MUST be provided.
        For new file creation, expected_version should be None.

        Implementation varies by backend:
        - Filesystem: Uses OS-level file locking (fcntl/msvcrt)
        - S3: Uses conditional PutObject with IfMatch ETag
        - Azure: Uses conditional upload_blob with match_condition

        Args:
            path: Relative path to file within storage root
            content: File contents to write
            expected_version: Expected current version (hash/ETag) for conflict detection

        Returns:
            str: New version identifier (hash/ETag) after write

        Raises:
            StorageError: If write fails or version mismatch (conflict)
        """
        return await self._store.write_file_atomic(path, content, expected_version)

    async def delete_file(self, path: str, expected_version: Optional[str] = None) -> None:
        """
        Delete file atomically with optimistic locking.

        For deleting existing files, expected_version MUST be provided to prevent
        accidental deletion if file was modified by another process.

        Args:
            path: Relative path to file within storage root
            expected_version: Expected current version (hash/ETag) for conflict detection

        Raises:
            StorageError: If file doesn't exist, delete fails, or version mismatch
        """
        return await self._store.delete_file(path, expected_version)

    async def list_files(self, prefix: str = '') -> list:
        """
        List all files under a given path prefix.

        Args:
            prefix: Path prefix to filter files (e.g., 'user-123/.projects/')
                   Empty string lists all files

        Returns:
            list[str]: List of relative file paths matching the prefix
        """
        return await self._store.list_files(prefix)

    # =========================================================================
    # Public Methods - Project Operations (User-Scoped)
    # =========================================================================

    async def save_project(self, account_info, project_id: str, pipeline: dict, expected_version: Optional[str] = None) -> dict:
        """
        Save a project for a user.

        Args:
            account_info: AccountInfo object containing clientid
            project_id: Project ID (used for filename)
            pipeline: Pipeline configuration dictionary
            expected_version: Expected current version for atomic update (optional)

        Returns:
            dict: Result with success status, project_id, and new version

        Raises:
            ValueError: If parameters are invalid
            StorageError: If storage operation fails or version mismatch
        """
        if not isinstance(account_info, AccountInfo):
            raise ValueError('account_info must be an AccountInfo instance')
        if not project_id:
            raise ValueError('project_id is required')
        if not pipeline:
            raise ValueError('pipeline is required')

        file_path = Store._construct_store_path(account_info.clientid, project_id)
        return await self._save_item(file_path, project_id, 'project_id', pipeline, expected_version)

    async def get_project(self, account_info, project_id: str) -> dict:
        """
        Get a project by ID.

        Args:
            account_info: AccountInfo object containing clientid
            project_id: Project ID to retrieve

        Returns:
            dict: Result with success status, project data, and version

        Raises:
            StorageError: If project not found or read fails
        """
        if not isinstance(account_info, AccountInfo):
            raise ValueError('account_info must be an AccountInfo instance')

        file_path = Store._construct_store_path(account_info.clientid, project_id)
        return await self._get_item(file_path)

    async def delete_project(self, account_info, project_id: str, expected_version: Optional[str] = None) -> dict:
        """
        Delete a project by ID.

        Args:
            account_info: AccountInfo object containing clientid
            project_id: Project ID to delete
            expected_version: Expected current version for atomic delete (optional)

        Returns:
            dict: Result with success status

        Raises:
            StorageError: If project not found, delete fails, or version mismatch
        """
        if not isinstance(account_info, AccountInfo):
            raise ValueError('account_info must be an AccountInfo instance')

        file_path = Store._construct_store_path(account_info.clientid, project_id)
        return await self._delete_item(file_path, project_id, 'project_id', expected_version)

    async def get_all_projects(self, account_info) -> dict:
        """
        Get all projects for a user.

        Args:
            account_info: AccountInfo object containing clientid

        Returns:
            dict: Result with success status, projects array, and count
        """
        if not isinstance(account_info, AccountInfo):
            raise ValueError('account_info must be an AccountInfo instance')

        prefix = Store._construct_store_path(account_info.clientid)
        return await self._get_all_items(prefix, 'id', 'projects')

    # =========================================================================
    # Public Methods - Template Operations (System-Wide)
    # =========================================================================

    async def save_template(self, template_id: str, pipeline: dict, expected_version: Optional[str] = None) -> dict:
        """
        Save a template (system-wide, accessible to all users).

        Args:
            template_id: Template ID (used for filename)
            pipeline: Pipeline configuration dictionary
            expected_version: Expected current version for atomic update (optional)

        Returns:
            dict: Result with success status, template_id, and new version

        Raises:
            ValueError: If parameters are invalid
            StorageError: If storage operation fails or version mismatch
        """
        if not template_id:
            raise ValueError('template_id is required')
        if not pipeline:
            raise ValueError('pipeline is required')

        file_path = Store._construct_template_path(template_id)
        return await self._save_item(file_path, template_id, 'template_id', pipeline, expected_version)

    async def get_template(self, template_id: str) -> dict:
        """
        Get a template by ID.

        Args:
            template_id: Template ID to retrieve

        Returns:
            dict: Result with success status, template data, and version

        Raises:
            StorageError: If template not found or read fails
        """
        if not template_id:
            raise ValueError('template_id is required')

        file_path = Store._construct_template_path(template_id)
        return await self._get_item(file_path)

    async def delete_template(self, template_id: str, expected_version: Optional[str] = None) -> dict:
        """
        Delete a template by ID.

        Args:
            template_id: Template ID to delete
            expected_version: Expected current version for atomic delete (optional)

        Returns:
            dict: Result with success status

        Raises:
            StorageError: If template not found, delete fails, or version mismatch
        """
        if not template_id:
            raise ValueError('template_id is required')

        file_path = Store._construct_template_path(template_id)
        return await self._delete_item(file_path, template_id, 'template_id', expected_version)

    async def get_all_templates(self) -> dict:
        """
        Get all templates (system-wide).

        Returns:
            dict: Result with success status, templates array, and count
        """
        prefix = Store._construct_template_path()
        return await self._get_all_items(prefix, 'id', 'templates')

    # =========================================================================
    # Public Methods - Log Operations (User-Scoped, Per-Project)
    # =========================================================================

    async def save_log(self, account_info, project_id: str, source: str, contents: dict) -> dict:
        """
        Save a log file for a source run.

        Creates or overwrites a log file in the users/<client-id>/.logs/<project_id>/ directory.
        The filename is constructed as <source>-<start_time>.log where start_time
        is extracted from contents['body']['startTime'].

        Args:
            account_info: AccountInfo object containing clientid
            project_id: Project ID
            source: Name of the source
            contents: Log contents dictionary containing body.startTime

        Returns:
            dict: Result with success status and filename

        Raises:
            ValueError: If parameters are invalid
            StorageError: If storage operation fails
        """
        if not isinstance(account_info, AccountInfo):
            raise ValueError('account_info must be an AccountInfo instance')
        if not project_id:
            raise ValueError('project_id is required')
        if not source:
            raise ValueError('source is required')
        if not contents:
            raise ValueError('contents is required')

        # Extract start_time from contents
        start_time = contents.get('body', {}).get('startTime')
        if start_time is None:
            raise ValueError('contents must contain body.startTime')

        # Construct filename: source-<start_time>.log
        filename = f'{source}-{start_time}.log'
        file_path = Store._construct_log_path(account_info.clientid, project_id, filename)

        # Serialize contents to JSON
        contents_json = json.dumps(contents, indent=2)

        # Save file (overwrite if exists)
        await self._store.write_file(file_path, contents_json)

        return {'success': True, 'filename': filename}

    async def get_log(self, account_info, project_id: str, source: str, start_time: float) -> dict:
        """
        Get a log file by source name and start time.

        Args:
            account_info: AccountInfo object containing clientid
            project_id: Project ID
            source: Name of the source
            start_time: Start time of the run

        Returns:
            dict: Result with success status and log contents

        Raises:
            ValueError: If parameters are invalid
            StorageError: If log not found or read fails
        """
        if not isinstance(account_info, AccountInfo):
            raise ValueError('account_info must be an AccountInfo instance')
        if not project_id:
            raise ValueError('project_id is required')
        if not source:
            raise ValueError('source is required')
        if start_time is None:
            raise ValueError('start_time is required')

        # Construct filename: source-<start_time>.log
        filename = f'{source}-{start_time}.log'
        file_path = Store._construct_log_path(account_info.clientid, project_id, filename)

        # Read log file
        contents_json = await self._store.read_file(file_path)
        contents = json.loads(contents_json)

        return {'success': True, 'contents': contents}

    async def list_logs(self, account_info, project_id: str, source: Optional[str] = None, page: Optional[int] = None) -> dict:
        """
        List log files for a project.

        Args:
            account_info: AccountInfo object containing clientid
            project_id: Project ID
            source: Optional source name to filter logs (filters files starting with '<source>-')
            page: Page number (0-indexed). If negative or None, defaults to 0.
                  Page size is LOG_PAGE_SIZE (100).

        Returns:
            dict: Result with success status, logs array, count, total_count, page, and total_pages
        """
        if not isinstance(account_info, AccountInfo):
            raise ValueError('account_info must be an AccountInfo instance')
        if not project_id:
            raise ValueError('project_id is required')

        # Normalize page number
        if page is None or page < 0:
            page = 0

        # Get directory prefix
        prefix = Store._construct_log_path(account_info.clientid, project_id)

        # List all files in directory
        file_paths = await self._store.list_files(prefix)

        # Filter to only .log files
        log_files = [f for f in file_paths if f.endswith('.log')]

        # If source provided, filter files starting with source-
        if source:
            log_files = [f for f in log_files if Path(f).name.startswith(f'{source}-')]

        # Sort files
        log_files.sort()

        # Calculate pagination
        total_count = len(log_files)
        total_pages = (total_count + LOG_PAGE_SIZE - 1) // LOG_PAGE_SIZE if total_count > 0 else 1
        start_idx = page * LOG_PAGE_SIZE
        end_idx = start_idx + LOG_PAGE_SIZE

        # Get page of files
        page_files = log_files[start_idx:end_idx]

        # Extract just filenames from paths
        logs = [Path(f).name for f in page_files]

        return {
            'success': True,
            'logs': logs,
            'count': len(logs),
            'total_count': total_count,
            'page': page,
            'total_pages': total_pages,
        }

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
            storage_path = home / '.rocketlib' / 'dtc'
        except Exception:
            # Fallback to temp directory if home cannot be determined
            storage_path = Path(tempfile.gettempdir()) / '.rocketlib' / 'dtc'

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

    @staticmethod
    def _construct_path(components: list, item_id: Optional[str] = None) -> str:
        """
        Construct storage path for items (projects or templates).

        Args:
            components: List of path components (e.g., ['users', client_id, '.projects'])
            item_id: Item ID (optional)

        Returns:
            str: File path if item_id provided, directory path otherwise
        """
        # Use Path for cross-platform path construction, convert to POSIX-style string
        # (forward slashes) for storage consistency across platforms
        base_path = Path(*components)

        if item_id:
            file_path = base_path / f'{item_id}.json'
            return file_path.as_posix()
        else:
            # Return directory path with trailing slash
            return base_path.as_posix() + '/'

    @staticmethod
    def _construct_store_path(client_id: str, project_id: Optional[str] = None) -> str:
        """
        Construct storage path for projects.

        Args:
            client_id: Client/user ID
            project_id: Project ID (optional)

        Returns:
            str: File path if project_id provided, directory path otherwise
                - With project_id: "users/<client_id>/.projects/<project_id>.json"
                - Without project_id: "users/<client_id>/.projects/"
        """
        return Store._construct_path(['users', client_id, '.projects'], project_id)

    @staticmethod
    def _construct_template_path(template_id: Optional[str] = None) -> str:
        """
        Construct storage path for templates.

        Templates are stored in a system-wide location accessible to all users.

        Args:
            template_id: Template ID (optional)

        Returns:
            str: File path if template_id provided, directory path otherwise
                - With template_id: "system/.templates/<template_id>.json"
                - Without template_id: "system/.templates/"
        """
        return Store._construct_path(['system', '.templates'], template_id)

    @staticmethod
    def _construct_log_path(client_id: str, project_id: str, filename: Optional[str] = None) -> str:
        """
        Construct storage path for log files.

        Args:
            client_id: Client/user ID
            project_id: Project ID
            filename: Log filename (optional)

        Returns:
            str: File path if filename provided, directory path otherwise
                - With filename: "users/<client_id>/.logs/<project_id>/<filename>"
                - Without filename: "users/<client_id>/.logs/<project_id>/"
        """
        base_path = Path('users', client_id, '.logs', project_id)
        if filename:
            file_path = base_path / filename
            return file_path.as_posix()
        else:
            return base_path.as_posix() + '/'

    # =========================================================================
    # Private Methods
    # =========================================================================

    async def _save_item(self, file_path: str, item_id: str, id_key: str, pipeline: dict, expected_version: Optional[str] = None) -> dict:
        """
        Save an item (project or template).

        Args:
            file_path: Storage path for the item
            item_id: Item ID
            id_key: Key name for ID in response (e.g., 'project_id' or 'template_id')
            pipeline: Pipeline configuration dictionary
            expected_version: Expected current version for atomic update (optional)

        Returns:
            dict: Result with success status, item ID, and new version
        """
        # Serialize pipeline to JSON
        pipeline_json = json.dumps(pipeline, indent=2)

        # Save atomically using the wrapped store
        new_version = await self._store.write_file_atomic(file_path, pipeline_json, expected_version)

        return {'success': True, id_key: item_id, 'version': new_version}

    async def _get_item(self, file_path: str) -> dict:
        """
        Get an item (project or template) by path.

        Args:
            file_path: Storage path for the item

        Returns:
            dict: Result with success status, pipeline data, and version
        """
        # Read pipeline with version using the wrapped store
        pipeline_json, version = await self._store.read_file_with_metadata(file_path)
        pipeline = json.loads(pipeline_json)

        return {'success': True, 'pipeline': pipeline, 'version': version}

    async def _delete_item(self, file_path: str, item_id: str, id_key: str, expected_version: Optional[str] = None) -> dict:
        """
        Delete an item (project or template).

        Args:
            file_path: Storage path for the item
            item_id: Item ID
            id_key: Key name for ID in response (e.g., 'project_id' or 'template_id')
            expected_version: Expected current version for atomic delete (optional)

        Returns:
            dict: Result with success status
        """
        # Delete atomically using the wrapped store
        await self._store.delete_file(file_path, expected_version)

        return {'success': True, id_key: item_id}

    async def _get_all_items(self, prefix: str, id_key: str, list_key: str) -> dict:
        """
        Get all items (projects or templates) from a directory.

        Args:
            prefix: Directory prefix to list
            id_key: Key name for ID in summaries (e.g., 'id')
            list_key: Key name for the list in response (e.g., 'projects' or 'templates')

        Returns:
            dict: Result with success status, items array, and count
        """
        # List all files in directory using the wrapped store
        file_paths = await self._store.list_files(prefix)

        # Filter to only .json files
        item_files = [f for f in file_paths if f.endswith('.json')]

        # Read each item and extract summary
        items = []
        for file_path in item_files:
            try:
                # Extract item_id from filename
                item_id = Path(file_path).stem  # Gets filename without extension

                # Read pipeline data
                pipeline_json = await self._store.read_file(file_path)
                pipeline = json.loads(pipeline_json)

                # Extract name (from pipeline.name or source component name)
                pipeline_name = pipeline.get('name', 'Untitled')
                pipeline_desc = pipeline.get('description', '')

                # Extract sources (all components where config.mode == 'Source')
                sources = []
                pipeline_components = pipeline.get('components', [])
                for component in pipeline_components:
                    config = component.get('config', {})
                    if config.get('mode') == 'Source':
                        sources.append({
                            'id': component.get('id'),
                            'provider': component.get('provider'),
                            'name': config.get('name', component.get('id'))
                        })

                summary = {
                    id_key: item_id,
                    'name': pipeline_name,
                    'description': pipeline_desc,
                    'sources': sources,
                    'totalComponents': len(pipeline_components)
                }
                items.append(summary)
            except Exception:
                # Skip files that can't be read or parsed
                continue

        return {'success': True, list_key: items, 'count': len(items)}


__all__ = [
    'Store',
    'IStore',
    'StorageError',
    'VersionMismatchError',
    'STORE_MAX_RETRY_ATTEMPTS',
    'LOG_PAGE_SIZE',
]
