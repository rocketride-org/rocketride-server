"""
Storage Interface for RocketRide Account Data.

Unified storage abstraction supporting multiple backends:
- Filesystem: Local or network file storage
- AWS S3: Amazon S3 object storage
- Azure Blob: Azure Blob Storage

Configuration via RR_STORE_URL environment variable (the legacy STORE_URL
name hard-fails at startup so a stale deployment cannot silently fall back).
Defaults to filesystem://~/.rocketlib/dtc if not set (user home directory).
Falls back to temp directory if home directory cannot be determined.
"""

import io
import os
import re
import tempfile
import threading
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

    async def move_file(self, src: str, dst: str) -> None:
        """
        Move a file onto ``dst``, replacing it if it exists.

        Backends override this with their native primitive — ``os.replace`` on a filesystem,
        a server-side copy on an object store — which is what makes publishing a file written
        elsewhere safe: the destination is replaced only once the new content is in place,
        and the bytes never pass through this process.

        The default below has neither property. It reads the whole file into memory and
        writes over the destination, so a failure part-way leaves the destination damaged.
        It exists so a backend that cannot move natively still works.

        Args:
            src: Relative path to move from
            dst: Relative path to move onto

        Raises:
            StorageError: If the source is missing or the move fails
        """
        data = await self.read_bytes(src)
        await self.write_bytes(dst, data)
        await self.delete_file(src)

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

    async def get_url(
        self, filename: str, expires_in: int = 3600, content_disposition: Optional[str] = None
    ) -> Optional[str]:
        """
        Get a direct HTTP URL for accessing the file.

        Cloud backends (S3, Azure) return a presigned/SAS URL that grants
        temporary read access without further authentication.  The local
        filesystem backend returns ``None``, signaling the caller to
        generate a JWT-signed URL pointing at the ``/task/fetch`` endpoint.

        Args:
            filename: Relative path to the file within the store.
            expires_in: URL validity in seconds (default 1 hour).
            content_disposition: Optional ``Content-Disposition`` header value
                for cloud backends to bake into the URL. Ignored by the local
                filesystem backend (which handles disposition at ``/task/fetch``).

        Returns:
            A presigned URL string, or ``None`` when the backend cannot
            produce a direct URL (filesystem).
        """
        return None

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

    @abstractmethod
    async def list_entries(
        self,
        prefix: str = '',
        *,
        recursive: bool = True,
        include_files: bool = True,
        include_dirs: bool = True,
        name_pattern: Optional[str] = None,
    ) -> list:
        """
        Browse files and/or folders under a prefix.

        Directories are returned with a trailing ``/`` to distinguish them from
        files.

        Args:
            prefix: Path prefix to list under (relative to store root).
            recursive: When ``True`` (default) descend into all sub-directories.
                When ``False`` list only the immediate children of ``prefix``.
            include_files: Include regular files in the result.
            include_dirs: Include directory entries (with trailing ``/``) in the
                result.
            name_pattern: Optional glob pattern applied to the **basename** of
                each result.  Must not contain path separators (``/`` or
                ``\\``); backends will raise ``ValueError`` for patterns that
                do.

        Returns:
            Sorted list of relative paths.  Directory entries end with ``/``.

        Raises:
            StorageError: If the underlying listing operation fails.
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

    # Create store (uses RR_STORE_URL env var or defaults to filesystem)
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

    # The process-wide singleton. A server has exactly ONE store (one
    # RR_STORE_URL) — production code accesses it via Store.instance() /
    # Store.file_store(ctx), never by constructing stores ad hoc. The
    # constructor stays reachable for backend-specific tests only.
    _instance: 'Optional[Store]' = None

    # Guards lazy creation: two threads racing instance() (e.g. node init in
    # the engine subprocess via engine_file_store) must never each build a
    # Store — the loser's copy would carry its own _shared_handles /
    # _shared_write_locks and silently defeat cross-instance write exclusion.
    _instance_lock = threading.Lock()

    def __init__(self, store: IStore):
        """
        Initialize Store wrapper with an IStore backend.

        Note: Production code uses the process singleton (Store.instance() /
        Store.file_store(ctx)); constructing directly is for backend-specific
        tests and tools.

        Args:
            store: Backend storage implementation (FilesystemStore, S3Store, AzureBlobStore)
        """
        self._store = store
        # SHARED single-process guards for every FileStore constructed from
        # this Store: the open-handle registry and the set of physical paths
        # currently open for writing. They live HERE (not on FileStore)
        # because instances are per-consumer and identity-bound — two users'
        # instances addressing the same team file must still exclude each
        # other. NOT distributed locks: cross-node consistency remains the
        # backend's whole-object atomicity / CAS.
        self._shared_handles: dict = {}
        self._shared_write_locks: set = set()

    # =========================================================================
    # Singleton access
    # =========================================================================

    @classmethod
    def instance(cls) -> 'Store':
        """
        The process-wide store singleton, connected lazily on first use.

        Resolves the backend from RR_STORE_URL / RR_STORE_SECRET_KEY (see
        create() for the resolution and failure rules). Both the server and
        the engine subprocess use this — the subprocess inherits the env, so
        the SAME mechanism works on both sides of the process boundary.
        """
        # Double-checked locking: the fast path stays lock-free once built;
        # the lock only serializes first-use creation so exactly one Store
        # (and one shared handle/lock registry) ever exists per process.
        if cls._instance is None:
            with cls._instance_lock:
                if cls._instance is None:
                    cls._instance = cls.create()
        return cls._instance

    @classmethod
    def reset(cls) -> None:
        """
        Drop the process singleton (next instance() reconnects from the env).

        Lifecycle hook: used between test cases and by any future
        reconfigure-on-the-fly path. Does not close backend connections —
        backends are stateless per-operation.
        """
        cls._instance = None

    def raw_store(self) -> IStore:
        """
        The underlying IStore backend, for subsystems that operate on raw
        store paths (e.g. the deployment backend's org-registry tree).

        Public accessor so callers never reach into the private ``_store``
        attribute — identity-bound file access still goes through
        ``file_store()``.
        """
        return self._store

    @classmethod
    def file_store(cls, ctx, client_id: Optional[str] = None, root: Optional[str] = None) -> 'FileStore':
        """
        The one-liner every call site uses: an identity-bound FileStore view
        over the process singleton.

        Args:
            ctx: The per-request RequestContext (the handler's ctx, or
                 RequestContext.internal()/engine() for server subsystems).
            client_id: Whose plain-path namespace the view anchors to.
                 Sessions may omit it (derived from ctx.account_info.userId)
                 and may NOT name a foreign one (mismatch raises) — only
                 internal/engine identities address other users' namespaces,
                 and must pass it explicitly.
            root: ENGINE contexts only — the task-file storage anchor
                 (``storage.root``) all plain paths resolve under; see
                 FileStore.__init__.

        Returns:
            A new FileStore bound to (singleton store, client_id, ctx).
        """
        return cls.instance()._file_store(ctx, client_id, root)

    @staticmethod
    def _get_current_task() -> 'Optional[dict]':
        """The engine's currently-executing task file (rocketlib.getTask).

        Isolated for testability and for running outside the engine (plain
        python has no rocketlib) — both simply report 'no task'.
        """
        try:
            from rocketlib import getTask
        except ImportError:
            return None
        return getTask()

    @classmethod
    def engine_file_store(cls) -> 'Optional[FileStore]':
        """A FileStore for the CURRENT engine task — fully transparent to
        nodes: identity and the storage anchor come from the task file the
        engine published (rocketlib.getTask), never from the environment
        and never from per-node jobConfig plumbing.

        Returns:
            An engine-context FileStore anchored at the task's
            ``storage.root`` (the owner's tree for dev runs, a
            task-specific team subtree for deploy runs), or None when no
            task is running or it carries no identity.
        """
        from .file_store import FileStore  # noqa: F401  (return type)
        from .models import RequestContext

        task = cls._get_current_task() or {}
        identity = task.get('identity') or {}
        client_id = str(identity.get('userId') or '').strip()
        if not client_id:
            return None
        root = str((task.get('storage') or {}).get('root') or '').strip() or None
        return cls.file_store(RequestContext.engine(client_id), client_id=client_id, root=root)

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
            url: Storage URL (overrides the RR_STORE_URL env var)
                 Default: filesystem://~/.rocketlib/dtc (user home directory)
                 Fallback: filesystem://<temp>/.rocketlib/dtc (if home unavailable)
            secret_key: Authentication credentials (overrides RR_STORE_SECRET_KEY)

        Raises:
            EnvironmentError: If the LEGACY variable (STORE_URL /
                STORE_SECRET_KEY) is set while its RR_-prefixed replacement is
                not — a hard fail so stale deployments get updated instead of
                silently flipping to the default directory.

        Returns:
            Store instance wrapping the appropriate storage backend

        Raises:
            ValueError: If URL format is invalid or backend not supported
        """
        # Get configuration from environment if not provided. The variables
        # live in the RR_* server-internal tier; the LEGACY unprefixed names
        # are a HARD ERROR (no fallback — a fallback would never get updated,
        # and silently ignoring the legacy value would flip that deployment
        # onto the default directory, which is worse than failing).
        if url is None:
            url = os.environ.get('RR_STORE_URL')
            if url is None and os.environ.get('STORE_URL'):
                raise EnvironmentError(
                    'STORE_URL has been renamed to RR_STORE_URL — update the deployment configuration.'
                )

        # Use default if not provided
        if url is None:
            url = Store._get_default_storage_url()

        if secret_key is None:
            secret_key = os.environ.get('RR_STORE_SECRET_KEY')
            if secret_key is None and os.environ.get('STORE_SECRET_KEY'):
                raise EnvironmentError(
                    'STORE_SECRET_KEY has been renamed to RR_STORE_SECRET_KEY — update the deployment configuration.'
                )

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

    def _file_store(self, ctx, client_id: 'Optional[str]' = None, root: 'Optional[str]' = None) -> 'FileStore':
        """
        Construct an identity-bound FileStore view (see Store.file_store).

        Instances are cheap per-consumer wrappers and identity must NEVER be
        cached — a user's concurrent sessions can carry different permission
        envelopes (PAT-scoped sessions, synthetic tk_/pk_ sessions). The
        shared write-lock/handle registries live on this Store, so
        non-caching loses no coordination.

        The client_id rules make cross-namespace mistakes unwritable:
          - session ctx: client_id is DERIVED from ctx.account_info.userId;
            an explicit value must match (a session can never anchor to a
            foreign user's namespace).
          - internal/engine ctx: client_id is REQUIRED (whose namespace the
            subsystem operates in — e.g. the run-log writer targets the task
            owner's area while acting as 'internal').
        """
        from .file_store import FileStore
        from .models import RequestContext

        if not isinstance(ctx, RequestContext):
            raise TypeError('ctx must be a RequestContext')

        sys_perms = (ctx.account_info.sysPermissions or []) if ctx.account_info else []
        # Trusted (engine/internal) contexts name the namespace they operate
        # in. Account-LESS contexts also take the explicit-client_id branch:
        # they stay constructible (pre-auth paths, backend tests) because
        # resolve_scope already denies their every operation with
        # 'Not authenticated' — nothing is reachable through them.
        is_session = ctx.account_info is not None and ctx.source != 'engine' and 'internal' not in sys_perms

        if is_session:
            # Sessions anchor to their own namespace, always — derived from
            # the authenticated identity, never from an explicit client_id.
            # A session-shaped ctx with no userId (e.g. a task-scoped
            # AccountInfo built from an empty control.userId) is rejected
            # outright: accepting a client_id for it would unlock an
            # arbitrary user's store.
            session_user = getattr(ctx.account_info, 'userId', '') or ''
            if not session_user:
                raise PermissionError('Session identity carries no userId — cannot anchor a file store')
            if client_id and client_id != session_user:
                raise PermissionError('A session cannot anchor to a foreign user namespace')
            client_id = session_user
        elif not client_id:
            raise ValueError('internal/engine contexts must pass an explicit client_id')

        return FileStore(self, client_id, ctx, root)

    async def close_all_handles(self, connection_id) -> None:
        """
        Force-close every open file handle owned by a connection.

        Disconnect-time cleanup over the SHARED handle registry (handles are
        recorded store-wide, so this covers every FileStore instance the
        connection ever constructed). Write handles commit whatever was
        written; failures are logged and swallowed (best-effort, mirrors
        FileStore._force_close_handle).

        Args:
            connection_id: The ctx.conn_id string (or legacy int, coerced).
        """
        conn_id = str(connection_id)
        doomed = [h for h in self._shared_handles.values() if h.connection_id == conn_id]
        for handle in doomed:
            await self._teardown_handle(handle)

    async def _teardown_handle(self, handle) -> None:
        """
        Force-close ONE handle: commit/close at the backend, then drop its
        registry entry and release any write lock. Best-effort — backend
        failures are logged and swallowed.

        THE single per-handle teardown sequence: both disconnect-time cleanup
        (close_all_handles above) and FileStore._force_close_handle delegate
        here so the close/commit/mark-closed/release-lock steps cannot drift.

        Args:
            handle: A FileHandle from the shared registry (None/closed = no-op).
        """
        from rocketlib import debug

        from .file_store import FileHandleMode

        if handle is None or handle.closed:
            return
        try:
            # Commit/close at the backend according to the handle mode.
            if handle.mode == FileHandleMode.WRITE:
                await self._store.close_write(handle.path, handle.context)
            else:
                await self._store.close_read(handle.path, handle.context)
        except Exception as exc:
            # Best-effort cleanup — log at debug level so commit failures are
            # traceable rather than silently lost.
            debug(
                f'Store._teardown_handle: failed to close {handle.handle_id} mode={handle.mode.value} path={handle.path}: {exc}'
            )
        finally:
            # Drop the registry entry and release any write lock.
            handle.closed = True
            self._shared_handles.pop(handle.handle_id, None)
            if handle.mode == FileHandleMode.WRITE:
                self._shared_write_locks.discard(handle.path)

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
