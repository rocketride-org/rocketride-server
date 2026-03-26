"""Tests for path traversal prevention in S3 and Azure store providers.

These tests validate that _get_key (S3) and _get_blob_name (Azure) reject
path traversal attempts (e.g., ../../other-tenant/) while allowing legitimate
nested paths and safe relative references within the prefix boundary.

The tests construct store instances via object.__new__ to avoid __init__
side effects and external dependencies (boto3, azure SDK, etc.).
"""

import pytest

from ai.account.store import StorageError
from ai.account.store_providers.s3 import S3Store
from ai.account.store_providers.azure import AzureBlobStore


# ===========================================================================
# S3 path traversal tests
# ===========================================================================


class TestS3PathTraversal:
    """Test path traversal prevention in S3Store._get_key."""

    def _make_store(self, prefix: str = 'tenant-123/data') -> S3Store:
        """Create an S3Store instance without connecting to AWS."""
        store = object.__new__(S3Store)
        store._bucket = 'test-bucket'
        store._prefix = prefix
        store._s3_client = None
        store._access_key_id = None
        store._secret_access_key = None
        store._region = 'us-east-1'
        return store

    def test_normal_path(self):
        """Normal paths should resolve correctly."""
        store = self._make_store()
        assert store._get_key('file.txt') == 'tenant-123/data/file.txt'

    def test_nested_path(self):
        """Nested subdirectory paths should resolve correctly."""
        store = self._make_store()
        assert store._get_key('subdir/file.txt') == 'tenant-123/data/subdir/file.txt'

    def test_traversal_with_dotdot(self):
        """../../ escaping the prefix must be rejected."""
        store = self._make_store()
        with pytest.raises(StorageError, match='Path traversal detected'):
            store._get_key('../../other-tenant/secrets.txt')

    def test_traversal_single_dotdot(self):
        """Single ../ escaping a shallow prefix must be rejected."""
        store = self._make_store(prefix='tenant-123')
        with pytest.raises(StorageError, match='Path traversal detected'):
            store._get_key('../other-tenant/file.txt')

    def test_traversal_backslash(self):
        """Backslash-based traversal must be rejected."""
        store = self._make_store()
        with pytest.raises(StorageError, match='Path traversal detected'):
            store._get_key('..\\..\\other-tenant\\secrets.txt')

    def test_safe_internal_dotdot(self):
        """A ../ that stays within the prefix boundary should be allowed."""
        store = self._make_store()
        result = store._get_key('subdir/../file.txt')
        assert result == 'tenant-123/data/file.txt'

    def test_no_prefix_normalization(self):
        """Without a prefix, paths should still be normalized."""
        store = self._make_store(prefix='')
        result = store._get_key('subdir/../file.txt')
        assert result == 'file.txt'


# ===========================================================================
# Azure path traversal tests
# ===========================================================================


class TestAzurePathTraversal:
    """Test path traversal prevention in AzureBlobStore._get_blob_name."""

    def _make_store(self, prefix: str = 'tenant-123/data') -> AzureBlobStore:
        """Create an AzureBlobStore instance without connecting to Azure."""
        store = object.__new__(AzureBlobStore)
        store._container = 'test-container'
        store._prefix = prefix
        store._blob_service_client = None
        store._account_name = None
        store._account_key = None
        store._connection_string = None
        return store

    def test_normal_path(self):
        """Normal paths should resolve correctly."""
        store = self._make_store()
        assert store._get_blob_name('file.txt') == 'tenant-123/data/file.txt'

    def test_nested_path(self):
        """Nested subdirectory paths should resolve correctly."""
        store = self._make_store()
        assert store._get_blob_name('subdir/file.txt') == 'tenant-123/data/subdir/file.txt'

    def test_traversal_with_dotdot(self):
        """../../ escaping the prefix must be rejected."""
        store = self._make_store()
        with pytest.raises(StorageError, match='Path traversal detected'):
            store._get_blob_name('../../other-tenant/secrets.txt')

    def test_traversal_single_dotdot(self):
        """Single ../ escaping a shallow prefix must be rejected."""
        store = self._make_store(prefix='tenant-123')
        with pytest.raises(StorageError, match='Path traversal detected'):
            store._get_blob_name('../other-tenant/file.txt')

    def test_traversal_backslash(self):
        """Backslash-based traversal must be rejected."""
        store = self._make_store()
        with pytest.raises(StorageError, match='Path traversal detected'):
            store._get_blob_name('..\\..\\other-tenant\\secrets.txt')

    def test_safe_internal_dotdot(self):
        """A ../ that stays within the prefix boundary should be allowed."""
        store = self._make_store()
        result = store._get_blob_name('subdir/../file.txt')
        assert result == 'tenant-123/data/file.txt'

    def test_no_prefix_normalization(self):
        """Without a prefix, paths should still be normalized."""
        store = self._make_store(prefix='')
        result = store._get_blob_name('subdir/../file.txt')
        assert result == 'file.txt'
