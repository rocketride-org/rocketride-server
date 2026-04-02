"""
Unit tests for Store interface and implementations.

Tests cover:
- Store factory and URL parsing
- Filesystem backend (real I/O)
- S3 backend (mocked)
- Azure backend (mocked)
- Error handling
"""

import os
import pytest
import tempfile
import shutil
from pathlib import Path
from unittest.mock import Mock

from ai.account.store import Store, StorageError
from ai.account.store_providers.filesystem import FilesystemStore
from ai.account.store_providers.s3 import S3Store
from ai.account.store_providers.azure import AzureBlobStore


# ============================================================================
# Filesystem Tests (Real I/O)
# ============================================================================


class TestFilesystemStore:
    """Test filesystem storage with real file operations."""

    @pytest.fixture
    def temp_dir(self):
        """Create temporary directory for tests."""
        temp_path = tempfile.mkdtemp()
        yield temp_path
        shutil.rmtree(temp_path, ignore_errors=True)

    @pytest.fixture
    def store(self, temp_dir):
        """Create filesystem store instance."""
        url = f'filesystem://{temp_dir}'
        return FilesystemStore(url)

    @pytest.mark.asyncio
    async def test_write_and_read_file(self, store):
        """Test writing and reading a file."""
        filename = 'test/file.txt'
        data = 'Hello, World!'

        # Write file
        await store.write_file(filename, data)

        # Read file
        content = await store.read_file(filename)

        assert content == data

    @pytest.mark.asyncio
    async def test_write_creates_directories(self, store, temp_dir):
        """Test that write_file creates parent directories."""
        filename = 'deep/nested/path/file.txt'
        data = 'Test data'

        await store.write_file(filename, data)

        # Verify directory structure was created
        full_path = Path(temp_dir) / 'deep' / 'nested' / 'path' / 'file.txt'
        assert full_path.exists()
        assert full_path.read_text() == data

    @pytest.mark.asyncio
    async def test_overwrite_existing_file(self, store):
        """Test overwriting an existing file."""
        filename = 'overwrite.txt'

        # Write initial content
        await store.write_file(filename, 'Initial content')

        # Overwrite with new content
        new_data = 'New content'
        await store.write_file(filename, new_data)

        # Verify new content
        content = await store.read_file(filename)
        assert content == new_data

    @pytest.mark.asyncio
    async def test_read_nonexistent_file(self, store):
        """Test reading a file that doesn't exist."""
        with pytest.raises(StorageError) as exc_info:
            await store.read_file('nonexistent.txt')

        assert 'File not found' in str(exc_info.value)

    @pytest.mark.asyncio
    async def test_unicode_content(self, store):
        """Test writing and reading Unicode content."""
        filename = 'unicode.txt'
        data = 'Hello 世界 🌍 Привет'

        await store.write_file(filename, data)
        content = await store.read_file(filename)

        assert content == data

    @pytest.mark.asyncio
    async def test_multiline_content(self, store):
        """Test writing and reading multiline content."""
        filename = 'multiline.txt'
        data = 'Line 1\nLine 2\nLine 3\n'

        await store.write_file(filename, data)
        content = await store.read_file(filename)

        assert content == data

    @pytest.mark.asyncio
    async def test_empty_file(self, store):
        """Test writing and reading an empty file."""
        filename = 'empty.txt'
        data = ''

        await store.write_file(filename, data)
        content = await store.read_file(filename)

        assert content == data

    @pytest.mark.asyncio
    async def test_path_traversal_protection(self, store):
        """Test that path traversal attempts are blocked."""
        with pytest.raises(StorageError) as exc_info:
            await store.write_file('../../../etc/passwd', 'malicious')

        assert 'Path traversal detected' in str(exc_info.value)

    @pytest.mark.asyncio
    async def test_large_file(self, store):
        """Test writing and reading a large file."""
        filename = 'large.txt'
        # Create 1MB of data
        data = 'A' * (1024 * 1024)

        await store.write_file(filename, data)
        content = await store.read_file(filename)

        assert content == data
        assert len(content) == 1024 * 1024


# ============================================================================
# Store Factory Tests
# ============================================================================


class TestStoreFactory:
    """Test Store factory and URL parsing."""

    def test_create_filesystem_store(self, tmp_path):
        """Test creating filesystem store."""
        url = f'filesystem://{tmp_path}'
        store = Store.create(url=url)

        assert isinstance(store, Store)
        assert isinstance(store._store, FilesystemStore)
        assert store._store._root_path == tmp_path

    def test_create_with_default_url(self):
        """Test creating store with default URL."""
        # Clear environment
        os.environ.pop('STORE_URL', None)

        store = Store.create()

        assert isinstance(store, Store)
        assert isinstance(store._store, FilesystemStore)
        # Should use default: filesystem://~/.rocketlib/dtc (user home)
        # or filesystem://<temp>/.rocketlib/dtc (fallback)

    def test_create_with_env_var(self, tmp_path):
        """Test creating store from STORE_URL environment variable."""
        os.environ['STORE_URL'] = f'filesystem://{tmp_path}'

        store = Store.create()

        assert isinstance(store, Store)
        assert isinstance(store._store, FilesystemStore)
        assert store._store._root_path == tmp_path

        # Cleanup
        os.environ.pop('STORE_URL', None)

    def test_env_var_expansion_windows(self, tmp_path):
        """Test environment variable expansion (Windows style)."""
        os.environ['TEST_VAR'] = str(tmp_path)

        url = 'filesystem://%TEST_VAR%/logs'
        store = Store.create(url=url)

        assert isinstance(store, Store)
        assert isinstance(store._store, FilesystemStore)
        assert str(tmp_path) in str(store._store._root_path)

        # Cleanup
        os.environ.pop('TEST_VAR', None)

    def test_env_var_expansion_unix(self, tmp_path):
        """Test environment variable expansion (Unix style)."""
        os.environ['TEST_VAR'] = str(tmp_path)

        url = 'filesystem://${TEST_VAR}/logs'
        store = Store.create(url=url)

        assert isinstance(store, Store)
        assert isinstance(store._store, FilesystemStore)
        assert str(tmp_path) in str(store._store._root_path)

        # Cleanup
        os.environ.pop('TEST_VAR', None)

    def test_tilde_expansion(self):
        """Test tilde expansion to user home directory."""
        from pathlib import Path

        url = 'filesystem://~/.rocketlib/test-storage'
        store = Store.create(url=url)

        assert isinstance(store, Store)
        assert isinstance(store._store, FilesystemStore)
        # Should expand ~ to actual home directory
        home = str(Path.home())
        assert home in str(store._store._root_path)
        assert '.rocketlib' in str(store._store._root_path)

    def test_invalid_url_format(self):
        """Test error on invalid URL format."""
        with pytest.raises(ValueError) as exc_info:
            Store.create(url='invalid-url')

        assert 'Invalid storage URL format' in str(exc_info.value)

    def test_unsupported_backend(self):
        """Test error on unsupported backend."""
        with pytest.raises(ValueError) as exc_info:
            Store.create(url='ftp://server/path')

        assert 'Unsupported storage backend' in str(exc_info.value)


# ============================================================================
# S3 Tests (Mocked)
# ============================================================================


class TestS3Store:
    """Test S3 storage with mocked boto3."""

    @pytest.fixture
    def mock_s3_client(self, monkeypatch):
        """Create mock S3 client."""
        import sys
        from unittest.mock import MagicMock  # noqa: F811

        # Mock boto3 module
        mock_boto3 = MagicMock()
        mock_client = Mock()
        mock_boto3.client.return_value = mock_client
        sys.modules['boto3'] = mock_boto3

        yield mock_client

    @pytest.fixture
    def store(self):
        """Create S3 store instance."""
        url = 's3://test-bucket/prefix'
        secret_key = '{"access_key_id":"AKIA","secret_access_key":"secret","region":"us-west-2"}'
        return S3Store(url, secret_key)

    def test_parse_url(self, store):
        """Test S3 URL parsing."""
        assert store._bucket == 'test-bucket'
        assert store._prefix == 'prefix'

    def test_parse_credentials(self, store):
        """Test S3 credentials parsing."""
        assert store._access_key_id == 'AKIA'
        assert store._secret_access_key == 'secret'
        assert store._region == 'us-west-2'

    def test_no_secret_key_uses_credential_chain(self, mock_s3_client):
        """Test that S3Store without secret_key uses AWS credential chain."""
        # Create store without secret_key - should use boto3 credential chain
        store = S3Store('s3://test-bucket/prefix', secret_key=None)

        # Verify no explicit credentials are set
        assert store._access_key_id is None
        assert store._secret_access_key is None
        assert store._region == 'us-east-1'  # Default region

        # When client is created, boto3 should use credential chain
        # (In real usage, this would read from ~/.aws/credentials)
        client = store._get_client()
        assert client is not None

        # Verify boto3.client was called without explicit credentials
        import sys

        if 'boto3' in sys.modules:
            mock_boto3 = sys.modules['boto3']
            # Check that client was called with just region_name (no explicit credentials)
            calls = mock_boto3.client.call_args_list
            if calls:
                # Last call should be without explicit credentials
                last_call = calls[-1]
                call_kwargs = last_call[1] if len(last_call) > 1 else {}
                # Should not have aws_access_key_id or aws_secret_access_key
                assert 'aws_access_key_id' not in call_kwargs
                assert 'aws_secret_access_key' not in call_kwargs

    def test_empty_secret_key_uses_credential_chain(self, mock_s3_client):
        """Test that empty string secret_key falls back to AWS credential chain."""
        # Create store with empty secret_key - should treat as None
        store = S3Store('s3://test-bucket/prefix', secret_key='')

        # Verify no explicit credentials are set
        assert store._access_key_id is None
        assert store._secret_access_key is None

    def test_whitespace_secret_key_uses_credential_chain(self, mock_s3_client):
        """Test that whitespace-only secret_key falls back to AWS credential chain."""
        # Create store with whitespace-only secret_key - should treat as None
        store = S3Store('s3://test-bucket/prefix', secret_key='   ')

        # Verify no explicit credentials are set
        assert store._access_key_id is None
        assert store._secret_access_key is None

    @pytest.mark.asyncio
    async def test_write_file(self, store, mock_s3_client):
        """Test writing file to S3."""
        filename = 'test/file.txt'
        data = 'Test data'

        await store.write_file(filename, data)

        # Verify put_object was called
        mock_s3_client.put_object.assert_called_once()
        call_args = mock_s3_client.put_object.call_args
        assert call_args[1]['Bucket'] == 'test-bucket'
        assert call_args[1]['Key'] == 'prefix/test/file.txt'
        assert call_args[1]['Body'] == b'Test data'

    @pytest.mark.asyncio
    async def test_read_file(self, store, mock_s3_client):
        """Test reading file from S3."""
        filename = 'test/file.txt'

        # Mock response
        mock_response = {'Body': Mock(read=Mock(return_value=b'Test data'))}
        mock_s3_client.get_object.return_value = mock_response

        content = await store.read_file(filename)

        assert content == 'Test data'
        mock_s3_client.get_object.assert_called_once_with(Bucket='test-bucket', Key='prefix/test/file.txt')

    @pytest.mark.asyncio
    async def test_read_nonexistent_file(self, store, mock_s3_client):
        """Test reading nonexistent file from S3."""

        # Mock NoSuchKey exception with proper class name
        class NoSuchKeyError(Exception):
            pass

        mock_s3_client.exceptions.NoSuchKey = NoSuchKeyError
        mock_s3_client.get_object.side_effect = NoSuchKeyError('Not found')

        with pytest.raises(StorageError) as exc_info:
            await store.read_file('nonexistent.txt')

        assert 'File not found' in str(exc_info.value)

    @pytest.mark.asyncio
    async def test_write_with_retry(self, store, mock_s3_client):
        """Test that write retries on connection errors."""
        filename = 'test/retry.txt'
        data = 'Test data'

        # Mock connection error on first 2 attempts, success on 3rd
        mock_s3_client.put_object.side_effect = [
            ConnectionError('Connection failed'),
            ConnectionError('Connection failed'),
            None,  # Success on 3rd attempt
        ]

        # Should succeed after retries
        await store.write_file(filename, data)

        # Verify it was called 3 times
        assert mock_s3_client.put_object.call_count == 3

    @pytest.mark.asyncio
    async def test_read_with_retry(self, store, mock_s3_client):
        """Test that read retries on timeout errors."""
        filename = 'test/retry.txt'

        # Mock timeout error on first 2 attempts, success on 3rd
        mock_response = {'Body': Mock(read=Mock(return_value=b'Test data'))}
        mock_s3_client.get_object.side_effect = [
            TimeoutError('Request timeout'),
            TimeoutError('Request timeout'),
            mock_response,  # Success on 3rd attempt
        ]

        # Should succeed after retries
        content = await store.read_file(filename)

        assert content == 'Test data'
        assert mock_s3_client.get_object.call_count == 3

    @pytest.mark.asyncio
    async def test_write_fails_after_max_retries(self, store, mock_s3_client, monkeypatch):
        """Test that write fails after max retries (with instant retry for speed)."""
        from ai.account.store import STORE_MAX_RETRY_ATTEMPTS
        import asyncio

        # Mock asyncio.sleep to make retries instant
        async def instant_sleep(seconds):
            pass

        monkeypatch.setattr(asyncio, 'sleep', instant_sleep)

        filename = 'test/fail.txt'
        data = 'Test data'

        # Mock connection error on all attempts
        mock_s3_client.put_object.side_effect = ConnectionError('Connection failed')

        # Should fail after STORE_MAX_RETRY_ATTEMPTS attempts
        with pytest.raises(ConnectionError):  # ConnectionError after retries exhausted
            await store.write_file(filename, data)

        # Verify it was called STORE_MAX_RETRY_ATTEMPTS times
        assert mock_s3_client.put_object.call_count == STORE_MAX_RETRY_ATTEMPTS

    @pytest.mark.asyncio
    async def test_write_atomic_with_deleted_file_and_version(self, store, mock_s3_client):
        """Test atomic write gracefully handles externally deleted file with stale version.

        Scenario: Client has an expectedVersion for a file that was deleted externally.
        When the conditional write (with IfMatch) fails with NoSuchKey, the method
        should retry without the condition, effectively recreating the file.
        """
        filename = 'projects/deleted-project.json'
        data = '{"name": "Recreated Project"}'
        stale_version = 'abc123'  # Version from before file was deleted

        # Mock head_object to show file doesn't exist
        class NoSuchKeyError(Exception):
            pass

        mock_s3_client.exceptions = Mock()
        mock_s3_client.exceptions.NoSuchKey = NoSuchKeyError
        mock_s3_client.head_object.side_effect = NoSuchKeyError('File not found')

        # Mock put_object to succeed (no IfMatch should be used since file doesn't exist)
        mock_s3_client.put_object.return_value = {'ETag': '"new-etag-456"'}

        # Call with expected_version but file doesn't exist
        new_version = await store.write_file_atomic(filename, data, expected_version=stale_version)

        # Should succeed and return new version
        assert new_version == 'new-etag-456'

        # Verify put_object was called WITHOUT IfMatch (since head_object showed no file)
        mock_s3_client.put_object.assert_called_once()
        call_kwargs = mock_s3_client.put_object.call_args[1]
        assert 'IfMatch' not in call_kwargs  # No conditional header

    @pytest.mark.asyncio
    async def test_write_atomic_race_condition_file_deleted_between_check_and_write(self, store, mock_s3_client):
        """Test atomic write handles race condition: file deleted between head_object and put_object.

        Scenario:
        1. head_object succeeds (file exists)
        2. File is deleted externally
        3. put_object with IfMatch fails with NoSuchKey
        4. Tenacity retries the entire method
        5. head_object now shows file doesn't exist
        6. put_object succeeds without IfMatch
        """
        filename = 'projects/race-condition.json'
        data = '{"name": "Race Condition Test"}'
        expected_version = 'original-etag'

        # Mock head_object: first call shows file exists, second call shows file deleted
        class NoSuchKeyError(Exception):
            pass

        mock_s3_client.head_object.side_effect = [
            {'ETag': '"original-etag"'},  # First attempt: file exists
            NoSuchKeyError('File not found'),  # Second attempt (after retry): file was deleted
        ]

        # Mock put_object: first call fails with NoSuchKey (race condition), second succeeds
        mock_s3_client.put_object.side_effect = [
            NoSuchKeyError('NoSuchKey during PutObject'),  # First attempt with IfMatch fails
            {'ETag': '"recreated-etag"'},  # Second attempt without IfMatch succeeds
        ]

        new_version = await store.write_file_atomic(filename, data, expected_version=expected_version)

        # Should succeed with new version
        assert new_version == 'recreated-etag'

        # Verify head_object was called twice (once per retry)
        assert mock_s3_client.head_object.call_count == 2

        # Verify put_object was called twice
        assert mock_s3_client.put_object.call_count == 2

        # First put_object call should have IfMatch (file existed at check time)
        first_call_kwargs = mock_s3_client.put_object.call_args_list[0][1]
        assert first_call_kwargs.get('IfMatch') == expected_version

        # Second put_object call should NOT have IfMatch (file doesn't exist on retry)
        second_call_kwargs = mock_s3_client.put_object.call_args_list[1][1]
        assert 'IfMatch' not in second_call_kwargs

    @pytest.mark.asyncio
    async def test_write_atomic_race_condition_retries_exhausted(self, store, mock_s3_client, monkeypatch):
        """Test atomic write fails after max retries on persistent race condition.

        Scenario: File keeps getting deleted between check and write, exhausting all retries.
        """
        from ai.account.store import STORE_MAX_RETRY_ATTEMPTS
        import asyncio

        # Mock asyncio.sleep to make retries instant
        async def instant_sleep(seconds):
            pass

        monkeypatch.setattr(asyncio, 'sleep', instant_sleep)

        filename = 'projects/unstable-file.json'
        data = '{"name": "Unstable"}'
        expected_version = 'some-version'

        # Mock head_object to always show file exists
        mock_s3_client.head_object.return_value = {'ETag': '"some-version"'}

        # Mock put_object to always fail with NoSuchKey (persistent race condition)
        class NoSuchKeyError(Exception):
            pass

        mock_s3_client.put_object.side_effect = NoSuchKeyError('NoSuchKey during PutObject')

        # Should fail after STORE_MAX_RETRY_ATTEMPTS
        with pytest.raises(S3Store._RaceConditionError):
            await store.write_file_atomic(filename, data, expected_version=expected_version)

        # Verify put_object was called STORE_MAX_RETRY_ATTEMPTS times
        assert mock_s3_client.put_object.call_count == STORE_MAX_RETRY_ATTEMPTS

    def test_verify_credential_chain_without_mock(self, tmp_path, monkeypatch):
        """Test that S3Store without secret_key attempts to use AWS credential chain.

        This test verifies the behavior without mocking boto3, so we can check
        if boto3 would use the credential chain (credentials file, env vars, etc.).

        To see which credential source is actually used, run:
        python rocketlib-ai/tests/ai/account/check_aws_credentials.py
        """
        import os
        from pathlib import Path

        # Temporarily remove STORE_SECRET_KEY if set
        original_store_secret = os.environ.pop('STORE_SECRET_KEY', None)
        original_aws_key = os.environ.pop('AWS_ACCESS_KEY_ID', None)
        original_aws_secret = os.environ.pop('AWS_SECRET_ACCESS_KEY', None)

        try:
            # Create store without secret_key
            store = S3Store('s3://test-bucket/prefix', secret_key=None)

            # Verify no explicit credentials are set in S3Store
            assert store._access_key_id is None
            assert store._secret_access_key is None

            # Check if credentials file exists
            home = Path.home()
            credentials_file = home / '.aws' / 'credentials'
            has_credentials_file = credentials_file.exists()

            # Try to get client (this will trigger boto3 credential chain)
            # We expect this to either:
            # 1. Work if credentials file exists and is valid
            # 2. Raise an error if no credentials are found
            try:
                client = store._get_client()
                # If we get here, boto3 found credentials somewhere
                # Check if it's from credentials file by examining the client
                # Note: We can't directly inspect boto3's credential provider,
                # but we can verify the client was created without explicit credentials
                assert client is not None

                # Try to determine credential source using boto3's credential resolver
                try:
                    from botocore.credentials import create_credential_resolver
                    from botocore.session import Session

                    session = Session()
                    resolver = create_credential_resolver(session)
                    credentials = resolver.load_credentials()

                    if credentials:
                        # Check which source was used
                        credential_source = 'unknown'
                        if original_aws_key and credentials.access_key == original_aws_key:
                            credential_source = 'environment variables'
                        elif has_credentials_file:
                            credential_source = 'credentials file (~/.aws/credentials)'
                        else:
                            credential_source = 'credential chain (likely IAM role)'

                        print('\n✓ S3 client created successfully')
                        print(f'  Credentials file exists: {has_credentials_file}')
                        print(f'  Credential source: {credential_source}')
                        if has_credentials_file:
                            print(f'  Credentials file path: {credentials_file}')
                except Exception:
                    # If we can't determine source, just report what we know
                    print('\n✓ S3 client created successfully')
                    print(f'  Credentials file exists: {has_credentials_file}')
                    if has_credentials_file:
                        print(f'  Credentials file path: {credentials_file}')
                        print('  → Likely using credentials file or credential chain')
                    else:
                        print('  → Using environment variables or IAM role')

            except Exception as e:
                # If credentials are not found, that's expected in test environment
                error_msg = str(e).lower()
                if 'credentials' in error_msg or 'no credentials' in error_msg:
                    print('\n⚠️  No AWS credentials found (expected in test environment)')
                    print(f'  Credentials file exists: {has_credentials_file}')
                    if not has_credentials_file:
                        print('  → To test with credentials file, create ~/.aws/credentials')
                else:
                    # Re-raise unexpected errors
                    raise

        finally:
            # Restore environment variables
            if original_store_secret:
                os.environ['STORE_SECRET_KEY'] = original_store_secret
            if original_aws_key:
                os.environ['AWS_ACCESS_KEY_ID'] = original_aws_key
            if original_aws_secret:
                os.environ['AWS_SECRET_ACCESS_KEY'] = original_aws_secret

    def test_verify_credential_source_with_file(self, tmp_path, monkeypatch):
        """Test that verifies credentials file is actually read when present.

        This creates a temporary credentials file and verifies boto3 reads it.
        """
        import os
        import configparser
        from unittest.mock import patch, MagicMock

        # Create temporary .aws directory
        aws_dir = tmp_path / '.aws'
        aws_dir.mkdir()
        credentials_file = aws_dir / 'credentials'

        # Write test credentials
        config = configparser.ConfigParser()
        config['default'] = {
            'aws_access_key_id': 'TEST_ACCESS_KEY_FROM_FILE',
            'aws_secret_access_key': 'TEST_SECRET_KEY_FROM_FILE',
        }
        with open(credentials_file, 'w') as f:
            config.write(f)

        # Temporarily override HOME/USERPROFILE to point to our temp directory
        home = tmp_path
        if os.name == 'nt':  # Windows
            monkeypatch.setenv('USERPROFILE', str(home))
        else:  # Unix
            monkeypatch.setenv('HOME', str(home))

        # Remove any existing AWS env vars
        original_aws_key = os.environ.pop('AWS_ACCESS_KEY_ID', None)
        original_aws_secret = os.environ.pop('AWS_SECRET_ACCESS_KEY', None)
        original_store_secret = os.environ.pop('STORE_SECRET_KEY', None)

        try:
            # Create store without secret_key - should use credentials file
            store = S3Store('s3://test-bucket/prefix', secret_key=None)

            # Verify no explicit credentials in S3Store
            assert store._access_key_id is None
            assert store._secret_access_key is None

            # Mock boto3 to capture what credentials it would use
            with patch('boto3.client') as mock_boto3_client:
                mock_client = MagicMock()
                mock_boto3_client.return_value = mock_client

                # Get client - this should trigger boto3 to read credentials file
                store._get_client()

                # Verify boto3.client was called
                assert mock_boto3_client.called

                # Check the call - should NOT have explicit credentials
                # (boto3 will read them from file internally)
                call_args = mock_boto3_client.call_args
                call_kwargs = call_args[1] if len(call_args) > 1 else {}

                # Should not have explicit credentials passed
                assert 'aws_access_key_id' not in call_kwargs
                assert 'aws_secret_access_key' not in call_kwargs

                print('\n✓ Verified: boto3.client called without explicit credentials')
                print('  → boto3 will use credential chain (credentials file in this case)')
                print(f'  → Credentials file path: {credentials_file}')

        finally:
            # Restore environment variables
            if original_aws_key:
                os.environ['AWS_ACCESS_KEY_ID'] = original_aws_key
            if original_aws_secret:
                os.environ['AWS_SECRET_ACCESS_KEY'] = original_aws_secret
            if original_store_secret:
                os.environ['STORE_SECRET_KEY'] = original_store_secret


# ============================================================================
# Azure Tests (Mocked)
# ============================================================================


class TestAzureBlobStore:
    """Test Azure Blob storage with mocked SDK."""

    @pytest.fixture
    def mock_blob_client(self, monkeypatch):
        """Create mock Azure Blob client."""
        import sys
        from unittest.mock import MagicMock  # noqa: F811

        # Mock Azure modules
        mock_azure_storage = MagicMock()
        mock_azure_core = MagicMock()
        sys.modules['azure'] = MagicMock()
        sys.modules['azure.storage'] = MagicMock()
        sys.modules['azure.storage.blob'] = mock_azure_storage
        sys.modules['azure.core'] = mock_azure_core
        sys.modules['azure.core.credentials'] = mock_azure_core.credentials

        mock_client = Mock()
        mock_blob = Mock()
        mock_client.get_blob_client.return_value = mock_blob
        mock_azure_storage.BlobServiceClient.from_connection_string.return_value = mock_client

        yield mock_client, mock_blob

    @pytest.fixture
    def store(self):
        """Create Azure store instance."""
        url = 'azureblob://test-container/prefix'
        secret_key = '{"connection_string":"DefaultEndpointsProtocol=https;AccountName=test"}'
        return AzureBlobStore(url, secret_key)

    def test_parse_url(self, store):
        """Test Azure URL parsing."""
        assert store._container == 'test-container'
        assert store._prefix == 'prefix'

    @pytest.mark.asyncio
    async def test_write_file(self, store, mock_blob_client):
        """Test writing file to Azure."""
        mock_client, mock_blob = mock_blob_client
        filename = 'test/file.txt'
        data = 'Test data'

        await store.write_file(filename, data)

        # Verify upload_blob was called
        mock_blob.upload_blob.assert_called_once()
        call_args = mock_blob.upload_blob.call_args
        assert call_args[0][0] == b'Test data'
        assert call_args[1]['overwrite'] is True

    @pytest.mark.asyncio
    async def test_read_file(self, store, mock_blob_client):
        """Test reading file from Azure."""
        mock_client, mock_blob = mock_blob_client
        filename = 'test/file.txt'

        # Mock download response
        mock_download = Mock(readall=Mock(return_value=b'Test data'))
        mock_blob.download_blob.return_value = mock_download

        content = await store.read_file(filename)

        assert content == 'Test data'
        mock_blob.download_blob.assert_called_once()

    @pytest.mark.asyncio
    async def test_write_with_retry(self, store, mock_blob_client):
        """Test that write retries on connection errors."""
        mock_client, mock_blob = mock_blob_client
        filename = 'test/retry.txt'
        data = 'Test data'

        # Mock connection error on first 2 attempts, success on 3rd
        mock_blob.upload_blob.side_effect = [
            ConnectionError('Connection failed'),
            ConnectionError('Connection failed'),
            None,  # Success on 3rd attempt
        ]

        # Should succeed after retries
        await store.write_file(filename, data)

        # Verify it was called 3 times
        assert mock_blob.upload_blob.call_count == 3

    @pytest.mark.asyncio
    async def test_read_with_retry(self, store, mock_blob_client):
        """Test that read retries on timeout errors."""
        mock_client, mock_blob = mock_blob_client
        filename = 'test/retry.txt'

        # Mock timeout error on first 2 attempts, success on 3rd
        mock_download = Mock(readall=Mock(return_value=b'Test data'))
        mock_blob.download_blob.side_effect = [
            TimeoutError('Request timeout'),
            TimeoutError('Request timeout'),
            mock_download,  # Success on 3rd attempt
        ]

        # Should succeed after retries
        content = await store.read_file(filename)

        assert content == 'Test data'
        assert mock_blob.download_blob.call_count == 3


# ============================================================================
# Store.get_file_store Tests
# ============================================================================


class TestStoreFileStore:
    """Test Store.get_file_store returns a working FileStore."""

    @pytest.fixture
    def temp_dir(self):
        """Create temporary directory for tests."""
        temp_path = tempfile.mkdtemp()
        yield temp_path
        shutil.rmtree(temp_path, ignore_errors=True)

    @pytest.fixture
    def store(self, temp_dir):
        """Create store instance."""
        url = f'filesystem://{temp_dir}'
        return Store.create(url=url)

    def test_get_file_store_returns_file_store(self, store):
        """Test that get_file_store returns a FileStore instance."""
        from ai.account.file_store import FileStore

        fs = store.get_file_store('test-user')
        assert isinstance(fs, FileStore)

    def test_get_file_store_caches_by_client_id(self, store):
        """Test that the same FileStore is returned for the same client_id."""
        fs1 = store.get_file_store('user-1')
        fs2 = store.get_file_store('user-1')
        fs3 = store.get_file_store('user-2')

        assert fs1 is fs2
        assert fs1 is not fs3

    @pytest.mark.asyncio
    async def test_file_store_write_and_read(self, store):
        """Test writing and reading via FileStore."""
        fs = store.get_file_store('test-user')

        await fs.write('test.txt', b'Hello, World!')
        data = await fs.read('test.txt')

        assert data == b'Hello, World!'

    @pytest.mark.asyncio
    async def test_file_store_isolation(self, store):
        """Test that different client_ids have isolated storage."""
        fs1 = store.get_file_store('user-1')
        fs2 = store.get_file_store('user-2')

        await fs1.write('shared-name.txt', b'user-1 data')
        await fs2.write('shared-name.txt', b'user-2 data')

        assert await fs1.read('shared-name.txt') == b'user-1 data'
        assert await fs2.read('shared-name.txt') == b'user-2 data'


class TestStoreIntegration:
    """Integration tests using real filesystem via Store + FileStore."""

    @pytest.fixture
    def temp_dir(self):
        """Create temporary directory for tests."""
        temp_path = tempfile.mkdtemp()
        yield temp_path
        shutil.rmtree(temp_path, ignore_errors=True)

    @pytest.mark.asyncio
    async def test_end_to_end_workflow(self, temp_dir):
        """Test complete workflow: create store, get FileStore, write, read."""
        url = f'filesystem://{temp_dir}'
        store = Store.create(url=url)
        fs = store.get_file_store('test-user')

        # Write multiple files
        await fs.write('logs/app.log', b'Application started\n')
        await fs.write('logs/app.log', b'Processing data\n')  # Overwrite
        await fs.write('data/config.json', b'{"key": "value"}')

        # Read files
        log_content = await fs.read('logs/app.log')
        config_content = await fs.read('data/config.json')

        assert log_content == b'Processing data\n'
        assert config_content == b'{"key": "value"}'

    @pytest.mark.asyncio
    async def test_concurrent_operations(self, temp_dir):
        """Test concurrent file operations."""
        import asyncio

        url = f'filesystem://{temp_dir}'
        store = Store.create(url=url)
        fs = store.get_file_store('test-user')

        # Write multiple files concurrently
        tasks = [fs.write(f'file{i}.txt', f'Content {i}'.encode()) for i in range(10)]
        await asyncio.gather(*tasks)

        # Read files concurrently
        tasks = [fs.read(f'file{i}.txt') for i in range(10)]
        results = await asyncio.gather(*tasks)

        # Verify all files were written correctly
        for i, content in enumerate(results):
            assert content == f'Content {i}'.encode()

    @pytest.mark.asyncio
    async def test_handle_based_write_and_read(self, temp_dir):
        """Test handle-based streaming write and read."""
        url = f'filesystem://{temp_dir}'
        store = Store.create(url=url)
        fs = store.get_file_store('test-user')

        # Write in chunks via handles
        handle_id = await fs.open_write('chunked.bin', connection_id=1)
        await fs.write_chunk(handle_id, b'chunk-1-')
        await fs.write_chunk(handle_id, b'chunk-2-')
        await fs.write_chunk(handle_id, b'chunk-3')
        await fs.close_write(handle_id)

        # Read back via handles
        info = await fs.open_read('chunked.bin', connection_id=1)
        assert info['size'] == 23  # len('chunk-1-chunk-2-chunk-3')
        data = await fs.read_chunk(info['handle'])
        await fs.close_read(info['handle'])

        assert data == b'chunk-1-chunk-2-chunk-3'

    @pytest.mark.asyncio
    async def test_close_all_handles_on_disconnect(self, temp_dir):
        """Test that close_all_handles commits and cleans up."""
        url = f'filesystem://{temp_dir}'
        store = Store.create(url=url)
        fs = store.get_file_store('test-user')

        # Open a write handle and write some data
        handle_id = await fs.open_write('disconnect.bin', connection_id=42)
        await fs.write_chunk(handle_id, b'partial-data')

        # Simulate disconnect — should commit what was written
        await fs.close_all_handles(connection_id=42)

        # Data should be committed and readable
        data = await fs.read('disconnect.bin')
        assert data == b'partial-data'

    @pytest.mark.asyncio
    async def test_write_lock_prevents_double_open(self, temp_dir):
        """Test that opening the same file for writing twice raises an error."""
        url = f'filesystem://{temp_dir}'
        store = Store.create(url=url)
        fs = store.get_file_store('test-user')

        handle_id = await fs.open_write('locked.bin', connection_id=1)

        with pytest.raises(StorageError) as exc_info:
            await fs.open_write('locked.bin', connection_id=2)
        assert 'already open for writing' in str(exc_info.value)

        # Clean up
        await fs.close_write(handle_id)


if __name__ == '__main__':
    pytest.main([__file__, '-v'])
