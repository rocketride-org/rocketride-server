"""
Unit tests for FileStore interface.

Tests cover:
- Generic file operations (read, write, delete, list_dir, mkdir, stat)
- Path validation and traversal prevention
- Directory listing with file/dir type detection
- Domain convenience methods (projects, templates, logs)
- User isolation between different client_ids
"""

import pytest
import tempfile
import shutil

from ai.account.store import Store, StorageError
from ai.account.file_store import FileStore, DIR_MARKER
from ai.account.store_providers.filesystem import FilesystemStore


# ============================================================================
# Fixtures
# ============================================================================


@pytest.fixture
def temp_dir():
    """Create temporary directory for tests."""
    temp_path = tempfile.mkdtemp()
    yield temp_path
    shutil.rmtree(temp_path, ignore_errors=True)


@pytest.fixture
def istore(temp_dir):
    """Create filesystem IStore backend."""
    url = f'filesystem://{temp_dir}'
    return FilesystemStore(url)


@pytest.fixture
def fs(istore):
    """Create a FileStore for test-user-1."""
    return FileStore(istore, 'test-user-1')


@pytest.fixture
def fs2(istore):
    """Create a FileStore for test-user-2 (isolation tests)."""
    return FileStore(istore, 'test-user-2')


@pytest.fixture
def store(istore):
    """Create a Store wrapper (for get_file_store tests)."""
    return Store(istore)


# ============================================================================
# FileStore Construction
# ============================================================================


class TestFileStoreInit:
    """Test FileStore initialization."""

    def test_requires_client_id(self, istore):
        """FileStore requires a non-empty client_id."""
        with pytest.raises(ValueError, match='client_id is required'):
            FileStore(istore, '')

    def test_creates_with_valid_client_id(self, istore):
        """FileStore creates successfully with a valid client_id."""
        fs = FileStore(istore, 'user-123')
        assert fs._client_id == 'user-123'


# ============================================================================
# Store.get_file_store Factory
# ============================================================================


class TestGetFileStore:
    """Test Store.get_file_store() factory method."""

    def test_returns_file_store(self, store):
        """get_file_store returns a FileStore instance."""
        fs = store.get_file_store('user-123')
        assert isinstance(fs, FileStore)

    def test_caches_per_client_id(self, store):
        """get_file_store returns the same instance for the same client_id."""
        fs1 = store.get_file_store('user-123')
        fs2 = store.get_file_store('user-123')
        assert fs1 is fs2

    def test_different_client_ids(self, store):
        """get_file_store returns different instances for different client_ids."""
        fs1 = store.get_file_store('user-1')
        fs2 = store.get_file_store('user-2')
        assert fs1 is not fs2


# ============================================================================
# Path Validation
# ============================================================================


class TestPathValidation:
    """Test path validation and normalization."""

    def test_rejects_traversal(self):
        """Paths with .. are rejected."""
        with pytest.raises(ValueError, match='Path traversal'):
            FileStore._validate_path('../escape')

    def test_rejects_embedded_traversal(self):
        """Paths with embedded .. are rejected."""
        with pytest.raises(ValueError, match='Path traversal'):
            FileStore._validate_path('a/../../escape')

    def test_strips_leading_slash(self):
        """Leading slashes are stripped."""
        assert FileStore._validate_path('/foo/bar') == 'foo/bar'

    def test_normalizes_backslash(self):
        """Backslashes are converted to forward slashes."""
        assert FileStore._validate_path('foo\\bar') == 'foo/bar'

    def test_empty_path(self):
        """Empty path normalizes to empty string."""
        assert FileStore._validate_path('') == ''

    def test_normal_path(self):
        """Normal paths pass through unchanged."""
        assert FileStore._validate_path('data/input.csv') == 'data/input.csv'


# ============================================================================
# Generic File Operations
# ============================================================================


class TestReadWrite:
    """Test read and write operations."""

    @pytest.mark.asyncio
    async def test_write_and_read(self, fs):
        """Write then read returns the same content."""
        await fs.write('test.txt', b'Hello, World!')
        data = await fs.read('test.txt')
        assert data == b'Hello, World!'

    @pytest.mark.asyncio
    async def test_write_creates_nested_dirs(self, fs):
        """Writing to a nested path creates intermediate directories."""
        await fs.write('a/b/c/deep.txt', b'deep content')
        data = await fs.read('a/b/c/deep.txt')
        assert data == b'deep content'

    @pytest.mark.asyncio
    async def test_overwrite(self, fs):
        """Overwriting a file replaces its content."""
        await fs.write('file.txt', b'v1')
        await fs.write('file.txt', b'v2')
        data = await fs.read('file.txt')
        assert data == b'v2'

    @pytest.mark.asyncio
    async def test_read_nonexistent(self, fs):
        """Reading a nonexistent file raises StorageError."""
        with pytest.raises(StorageError):
            await fs.read('does-not-exist.txt')


class TestDelete:
    """Test delete operations."""

    @pytest.mark.asyncio
    async def test_delete_file(self, fs):
        """Delete removes the file."""
        await fs.write('to-delete.txt', b'temp')
        await fs.delete('to-delete.txt')

        with pytest.raises(StorageError):
            await fs.read('to-delete.txt')

    @pytest.mark.asyncio
    async def test_delete_nonexistent(self, fs):
        """Deleting a nonexistent file raises StorageError."""
        with pytest.raises(StorageError):
            await fs.delete('ghost.txt')


# ============================================================================
# Directory Operations
# ============================================================================


class TestListDir:
    """Test list_dir operation."""

    @pytest.mark.asyncio
    async def test_list_files_only(self, fs):
        """list_dir shows files in the directory."""
        await fs.write('root1.txt', b'a')
        await fs.write('root2.txt', b'b')

        result = await fs.list_dir('')
        assert result['count'] == 2
        names = {e['name'] for e in result['entries']}
        assert names == {'root1.txt', 'root2.txt'}
        assert all(e['type'] == 'file' for e in result['entries'])

    @pytest.mark.asyncio
    async def test_list_files_have_modified(self, fs):
        """list_dir returns modified timestamps for file entries."""
        await fs.write('timestamped.txt', b'data')

        result = await fs.list_dir('')
        file_entry = next(e for e in result['entries'] if e['name'] == 'timestamped.txt')
        assert 'modified' in file_entry
        assert isinstance(file_entry['modified'], float)

    @pytest.mark.asyncio
    async def test_list_mixed(self, fs):
        """list_dir shows both files and directories."""
        await fs.write('file.txt', b'a')
        await fs.write('subdir/nested.txt', b'b')

        result = await fs.list_dir('')
        entries = {e['name']: e['type'] for e in result['entries']}
        assert entries == {'file.txt': 'file', 'subdir': 'dir'}

    @pytest.mark.asyncio
    async def test_list_dirs_no_modified(self, fs):
        """list_dir does not include modified for directory entries."""
        await fs.write('subdir/nested.txt', b'a')

        result = await fs.list_dir('')
        dir_entry = next(e for e in result['entries'] if e['type'] == 'dir')
        assert 'modified' not in dir_entry

    @pytest.mark.asyncio
    async def test_list_empty(self, fs):
        """list_dir on empty/nonexistent dir returns empty entries."""
        result = await fs.list_dir('empty')
        assert result['count'] == 0
        assert result['entries'] == []

    @pytest.mark.asyncio
    async def test_list_nested(self, fs):
        """list_dir shows only immediate children, not grandchildren."""
        await fs.write('parent/child1.txt', b'a')
        await fs.write('parent/child2.txt', b'b')
        await fs.write('parent/grandchild/deep.txt', b'c')

        result = await fs.list_dir('parent')
        entries = {e['name']: e['type'] for e in result['entries']}
        assert entries == {'child1.txt': 'file', 'child2.txt': 'file', 'grandchild': 'dir'}

    @pytest.mark.asyncio
    async def test_list_filters_dirmarker(self, fs):
        """list_dir filters out .dirmarker sentinel files."""
        await fs.mkdir('mydir')
        result = await fs.list_dir('mydir')

        names = {e['name'] for e in result['entries']}
        assert DIR_MARKER not in names


class TestMkdir:
    """Test mkdir operation."""

    @pytest.mark.asyncio
    async def test_mkdir_creates_directory(self, fs):
        """Mkdir creates a directory that shows up in stat."""
        await fs.mkdir('newdir')
        result = await fs.stat('newdir')

        assert result['exists'] is True
        assert result['type'] == 'dir'

    @pytest.mark.asyncio
    async def test_mkdir_nested(self, fs):
        """Mkdir creates nested directory."""
        await fs.mkdir('a/b/c')
        result = await fs.stat('a/b/c')
        assert result['exists'] is True


class TestStat:
    """Test stat operation."""

    @pytest.mark.asyncio
    async def test_stat_file(self, fs):
        """Stat returns file metadata with modified timestamp."""
        await fs.write('hello.txt', b'world')
        result = await fs.stat('hello.txt')

        assert result['exists'] is True
        assert result['type'] == 'file'
        assert 'modified' in result
        assert isinstance(result['modified'], float)

    @pytest.mark.asyncio
    async def test_stat_dir(self, fs):
        """Stat returns directory metadata."""
        await fs.write('mydir/file.txt', b'content')
        result = await fs.stat('mydir')

        assert result['exists'] is True
        assert result['type'] == 'dir'

    @pytest.mark.asyncio
    async def test_stat_nonexistent(self, fs):
        """Stat returns exists=False for missing paths."""
        result = await fs.stat('nope')

        assert result['exists'] is False


# ============================================================================
# User Isolation
# ============================================================================


class TestUserIsolation:
    """Test that different client_ids are isolated."""

    @pytest.mark.asyncio
    async def test_files_isolated(self, fs, fs2):
        """Files written by one user are not visible to another."""
        await fs.write('secret.txt', b'user1 data')

        with pytest.raises(StorageError):
            await fs2.read('secret.txt')

    @pytest.mark.asyncio
    async def test_list_isolated(self, fs, fs2):
        """list_dir only shows files for the scoped user."""
        await fs.write('file1.txt', b'a')
        await fs2.write('file2.txt', b'b')

        result1 = await fs.list_dir('')
        result2 = await fs2.list_dir('')

        names1 = {e['name'] for e in result1['entries']}
        names2 = {e['name'] for e in result2['entries']}

        assert 'file1.txt' in names1
        assert 'file2.txt' not in names1
        assert 'file2.txt' in names2
        assert 'file1.txt' not in names2


# ============================================================================
# Handle-Based I/O
# ============================================================================


class TestHandleIO:
    """Test handle-based read and write operations."""

    @pytest.mark.asyncio
    async def test_write_chunks_and_read(self, fs):
        """Write multiple chunks via handle, then read back."""
        handle_id = await fs.open_write('chunked.bin', connection_id=1)
        await fs.write_chunk(handle_id, b'part-1-')
        await fs.write_chunk(handle_id, b'part-2-')
        await fs.write_chunk(handle_id, b'part-3')
        await fs.close_write(handle_id)

        data = await fs.read('chunked.bin')
        assert data == b'part-1-part-2-part-3'

    @pytest.mark.asyncio
    async def test_read_chunks(self, fs):
        """Read a file in chunks via handle."""
        await fs.write('big.bin', b'A' * 100)

        info = await fs.open_read('big.bin', connection_id=1)
        assert info['size'] == 100

        chunk = await fs.read_chunk(info['handle'], length=40)
        assert len(chunk) == 40

        chunk2 = await fs.read_chunk(info['handle'], length=40)
        assert len(chunk2) == 40

        chunk3 = await fs.read_chunk(info['handle'], length=40)
        assert len(chunk3) == 20  # Only 20 bytes left

        chunk4 = await fs.read_chunk(info['handle'])
        assert chunk4 == b''  # EOF

        await fs.close_read(info['handle'])

    @pytest.mark.asyncio
    async def test_write_lock(self, fs):
        """Cannot open the same file for writing twice."""
        handle_id = await fs.open_write('locked.bin', connection_id=1)

        with pytest.raises(StorageError, match='already open for writing'):
            await fs.open_write('locked.bin', connection_id=2)

        await fs.close_write(handle_id)

        # After close, can open again
        handle_id2 = await fs.open_write('locked.bin', connection_id=2)
        await fs.close_write(handle_id2)

    @pytest.mark.asyncio
    async def test_close_all_handles(self, fs):
        """close_all_handles commits data and releases locks."""
        handle_id = await fs.open_write('orphan.bin', connection_id=99)
        await fs.write_chunk(handle_id, b'orphan-data')

        await fs.close_all_handles(connection_id=99)

        # Data should be committed
        data = await fs.read('orphan.bin')
        assert data == b'orphan-data'

        # Lock should be released
        handle_id2 = await fs.open_write('orphan.bin', connection_id=1)
        await fs.close_write(handle_id2)

    @pytest.mark.asyncio
    async def test_invalid_handle(self, fs):
        """Operations on invalid handles raise StorageError."""
        with pytest.raises(StorageError, match='Invalid handle'):
            await fs.write_chunk('nonexistent-handle', b'data')

        with pytest.raises(StorageError, match='Invalid handle'):
            await fs.read_chunk('nonexistent-handle')

    @pytest.mark.asyncio
    async def test_wrong_mode(self, fs):
        """Using a read handle for writing (or vice versa) raises StorageError."""
        await fs.write('mode-test.bin', b'data')
        info = await fs.open_read('mode-test.bin', connection_id=1)

        with pytest.raises(StorageError, match='Wrong handle mode'):
            await fs.write_chunk(info['handle'], b'nope')

        await fs.close_read(info['handle'])
