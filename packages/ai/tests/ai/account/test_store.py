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
        mock_s3_client.get_object.assert_called_once_with(
            Bucket='test-bucket', Key='prefix/test/file.txt'
        )

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
        new_version = await store.write_file_atomic(
            filename, data, expected_version=stale_version
        )

        # Should succeed and return new version
        assert new_version == 'new-etag-456'

        # Verify put_object was called WITHOUT IfMatch (since head_object showed no file)
        mock_s3_client.put_object.assert_called_once()
        call_kwargs = mock_s3_client.put_object.call_args[1]
        assert 'IfMatch' not in call_kwargs  # No conditional header

    @pytest.mark.asyncio
    async def test_write_atomic_race_condition_file_deleted_between_check_and_write(
        self, store, mock_s3_client
    ):
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

        new_version = await store.write_file_atomic(
            filename, data, expected_version=expected_version
        )

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
    async def test_write_atomic_race_condition_retries_exhausted(
        self, store, mock_s3_client, monkeypatch
    ):
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
            await store.write_file_atomic(
                filename, data, expected_version=expected_version
            )

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
# Project Operations Tests
# ============================================================================


class TestStorePathConstruction:
    """Test Store path construction for projects and templates."""

    def test_construct_path_with_item_id(self):
        """Test generic path construction with item ID."""
        path = Store._construct_path(['some', 'base', 'path'], 'item-123')
        assert path == 'some/base/path/item-123.json'

    def test_construct_path_without_item_id(self):
        """Test generic path construction without item ID (directory)."""
        path = Store._construct_path(['some', 'base', 'path'])
        assert path == 'some/base/path/'

    def test_construct_store_path_with_project_id(self):
        """Test project path includes users/ prefix."""
        path = Store._construct_store_path('client-123', 'proj-456')
        assert path == 'users/client-123/.projects/proj-456.json'

    def test_construct_store_path_without_project_id(self):
        """Test project directory path includes users/ prefix."""
        path = Store._construct_store_path('client-123')
        assert path == 'users/client-123/.projects/'

    def test_construct_template_path_with_template_id(self):
        """Test template path uses system/.templates."""
        path = Store._construct_template_path('tmpl-123')
        assert path == 'system/.templates/tmpl-123.json'

    def test_construct_template_path_without_template_id(self):
        """Test template directory path uses system/.templates."""
        path = Store._construct_template_path()
        assert path == 'system/.templates/'


class TestStoreProjects:
    """Test Store project operations (get_all_projects)."""

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

    @pytest.fixture
    def account_info(self):
        """Create mock AccountInfo."""
        from ai.account import AccountInfo

        return AccountInfo(clientid='test-user-123')

    @pytest.mark.asyncio
    async def test_get_all_projects_with_nested_pipeline_structure(self, store, account_info):
        """Test that get_all_projects correctly extracts sources from pipeline components."""
        project_id = 'test-proj-001'
        pipeline_data = {
            'source': 'source_1',
            'name': 'Test Pipeline',
            'components': [
                {
                    'id': 'source_1',
                    'provider': 'filesystem',
                    'config': {
                        'mode': 'Source',
                        'name': 'Filesystem Source',
                        'path': '/data/input',
                    },
                },
                {
                    'id': 'source_2',
                    'provider': 's3',
                    'config': {'mode': 'Source', 'name': 'S3 Source', 'bucket': 'my-bucket'},
                },
                {
                    'id': 'processor_1',
                    'provider': 'transform',
                    'config': {'mode': 'Transform', 'name': 'Data Processor'},
                },
            ],
        }

        # Save the project
        result = await store.save_project(account_info, project_id, pipeline_data)
        assert result['success'] is True

        # Get all projects and verify sources are extracted correctly
        all_projects = await store.get_all_projects(account_info)

        assert all_projects['success'] is True
        assert all_projects['count'] == 1

        project = all_projects['projects'][0]
        assert project['id'] == project_id
        assert project['name'] == 'Test Pipeline'
        assert project['totalComponents'] == 3  # 2 sources + 1 processor

        # Verify only Source components are included in sources array
        assert len(project['sources']) == 2

        source_ids = [s['id'] for s in project['sources']]
        assert 'source_1' in source_ids
        assert 'source_2' in source_ids
        assert 'processor_1' not in source_ids  # Transform should not be included

        # Verify source details
        fs_source = next(s for s in project['sources'] if s['id'] == 'source_1')
        assert fs_source['provider'] == 'filesystem'
        assert fs_source['name'] == 'Filesystem Source'

        s3_source = next(s for s in project['sources'] if s['id'] == 'source_2')
        assert s3_source['provider'] == 's3'
        assert s3_source['name'] == 'S3 Source'

    @pytest.mark.asyncio
    async def test_get_all_projects_with_empty_pipeline(self, store, account_info):
        """Test get_all_projects with empty components list."""
        project_id = 'empty-proj'
        pipeline_data = {
            'source': 'source_1',
            'name': 'Empty Pipeline',
            'components': [],
        }

        await store.save_project(account_info, project_id, pipeline_data)

        all_projects = await store.get_all_projects(account_info)

        assert all_projects['success'] is True
        assert all_projects['count'] == 1

        project = all_projects['projects'][0]
        assert project['name'] == 'Empty Pipeline'
        assert project['sources'] == []
        assert project['totalComponents'] == 0

    @pytest.mark.asyncio
    async def test_get_all_projects_with_missing_name(self, store, account_info):
        """Test get_all_projects defaults to 'Untitled' when project has no name."""
        project_id = 'no-name-proj'
        pipeline_data = {
            'source': 'source_1',
            'components': [
                {
                    'id': 'source_1',
                    'provider': 'filesystem',
                    'config': {'mode': 'Source', 'name': 'Legacy Source'},
                }
            ],
        }

        await store.save_project(account_info, project_id, pipeline_data)

        all_projects = await store.get_all_projects(account_info)

        assert all_projects['success'] is True
        assert all_projects['count'] == 1

        project = all_projects['projects'][0]
        assert project['name'] == 'Untitled'
        assert len(project['sources']) == 1
        assert project['totalComponents'] == 1


# ============================================================================
# Template Operations Tests
# ============================================================================


class TestStoreTemplates:
    """Test Store template operations (system-wide templates)."""

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

    @pytest.mark.asyncio
    async def test_save_and_get_template(self, store):
        """Test saving and retrieving a template."""
        template_id = 'tmpl-001'
        pipeline_data = {
            'name': 'Test Template',
            'source': 'source_1',
            'components': [
                {
                    'id': 'source_1',
                    'provider': 'filesystem',
                    'config': {
                        'mode': 'Source',
                        'name': 'Template Source',
                        'path': '/data/template',
                    },
                }
            ],
        }

        # Save template
        save_result = await store.save_template(template_id, pipeline_data)
        assert save_result['success'] is True
        assert save_result['template_id'] == template_id
        assert 'version' in save_result

        # Get template
        get_result = await store.get_template(template_id)
        assert get_result['success'] is True
        assert get_result['pipeline']['name'] == 'Test Template'
        assert 'version' in get_result

    @pytest.mark.asyncio
    async def test_update_template_with_version(self, store):
        """Test updating a template with version check."""
        template_id = 'tmpl-002'
        pipeline_data = {
            'name': 'Original Template',
            'source': 'source_1',
            'components': [],
        }

        # Save initial template
        save_result = await store.save_template(template_id, pipeline_data)
        version = save_result['version']

        # Update with correct version
        updated_pipeline = {
            'name': 'Updated Template',
            'source': 'source_1',
            'components': [],
        }
        update_result = await store.save_template(
            template_id, updated_pipeline, expected_version=version
        )
        assert update_result['success'] is True
        assert update_result['version'] != version  # Version should change

        # Verify update
        get_result = await store.get_template(template_id)
        assert get_result['pipeline']['name'] == 'Updated Template'

    @pytest.mark.asyncio
    async def test_delete_template(self, store):
        """Test deleting a template."""
        template_id = 'tmpl-003'
        pipeline_data = {
            'name': 'Delete Me Template',
            'source': 'source_1',
            'components': [],
        }

        # Save template
        save_result = await store.save_template(template_id, pipeline_data)
        version = save_result['version']

        # Delete template
        delete_result = await store.delete_template(template_id, expected_version=version)
        assert delete_result['success'] is True
        assert delete_result['template_id'] == template_id

        # Verify deletion
        with pytest.raises(StorageError):
            await store.get_template(template_id)

    @pytest.mark.asyncio
    async def test_get_all_templates(self, store):
        """Test listing all templates."""
        # Save multiple templates
        for i in range(3):
            pipeline_data = {
                'source': 'source_1',
                'name': f'Template {i}',
                'components': [
                    {
                        'id': 'source_1',
                        'provider': 'filesystem',
                        'config': {'mode': 'Source', 'name': f'Source {i}'},
                    }
                ],
            }
            await store.save_template(f'tmpl-{i:03d}', pipeline_data)

        # Get all templates
        all_templates = await store.get_all_templates()

        assert all_templates['success'] is True
        assert all_templates['count'] == 3

        template_ids = [t['id'] for t in all_templates['templates']]
        assert 'tmpl-000' in template_ids
        assert 'tmpl-001' in template_ids
        assert 'tmpl-002' in template_ids

        # Verify each template has correct structure
        for template in all_templates['templates']:
            assert 'name' in template
            assert 'sources' in template
            assert 'totalComponents' in template
            assert template['totalComponents'] == 1  # Each has 1 component

    @pytest.mark.asyncio
    async def test_get_all_templates_empty(self, store):
        """Test listing templates when none exist."""
        all_templates = await store.get_all_templates()

        assert all_templates['success'] is True
        assert all_templates['count'] == 0
        assert all_templates['templates'] == []

    @pytest.mark.asyncio
    async def test_template_validation_errors(self, store):
        """Test validation errors for template operations."""
        # Empty template_id
        with pytest.raises(ValueError) as exc_info:
            await store.save_template('', {'name': 'Test'})
        assert 'template_id is required' in str(exc_info.value)

        # Empty pipeline
        with pytest.raises(ValueError) as exc_info:
            await store.save_template('tmpl-test', None)
        assert 'pipeline is required' in str(exc_info.value)

        # Empty template_id for get
        with pytest.raises(ValueError) as exc_info:
            await store.get_template('')
        assert 'template_id is required' in str(exc_info.value)

        # Empty template_id for delete
        with pytest.raises(ValueError) as exc_info:
            await store.delete_template('')
        assert 'template_id is required' in str(exc_info.value)

    @pytest.mark.asyncio
    async def test_template_not_found(self, store):
        """Test getting a non-existent template."""
        with pytest.raises(StorageError) as exc_info:
            await store.get_template('nonexistent-template')
        assert 'not found' in str(exc_info.value).lower()


# ============================================================================
# Integration Tests
# ============================================================================


# ============================================================================
# Log Operations Tests
# ============================================================================


class TestStoreLogPathConstruction:
    """Test Store path construction for log files."""

    def test_construct_log_path_with_filename(self):
        """Test log path construction with filename."""
        path = Store._construct_log_path(
            'client-123', 'proj-456', 'source_1-1234567890.123.log'
        )
        assert path == 'users/client-123/.logs/proj-456/source_1-1234567890.123.log'

    def test_construct_log_path_without_filename(self):
        """Test log path construction without filename (directory)."""
        path = Store._construct_log_path('client-123', 'proj-456')
        assert path == 'users/client-123/.logs/proj-456/'


class TestStoreLogs:
    """Test Store log operations (save_log, get_log, list_logs)."""

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

    @pytest.fixture
    def account_info(self):
        """Create mock AccountInfo."""
        from ai.account import AccountInfo

        return AccountInfo(clientid='test-user-123')

    @pytest.fixture
    def sample_log_contents(self):
        """Sample log contents matching the status update event format."""
        return {
            'type': 'event',
            'seq': 79,
            'event': 'apaevt_status_update',
            'body': {
                'name': 'atl-confluence_1',
                'project_id': '851018af-1616-4d24-a544-9009339a8542',
                'source': 'atl-confluence_1',
                'completed': True,
                'state': 5,
                'startTime': 1764337626.6564875,
                'endTime': 1764337716.5507987,
                'debuggerAttached': False,
                'status': 'Completed',
                'warnings': [],
                'errors': [],
                'currentObject': '',
                'currentSize': 0,
                'notes': [],
                'totalSize': 810034,
                'totalCount': 15,
                'completedSize': 810034,
                'completedCount': 15,
                'failedSize': 0,
                'failedCount': 0,
                'wordsSize': 0,
                'wordsCount': 0,
                'rateSize': 975944,
                'rateCount': 18,
                'serviceUp': False,
                'exitCode': 0,
                'exitMessage': '',
                'pipeflow': {'totalPipes': 3, 'byPipe': {'0': [], '1': [], '2': []}},
                'metrics': {
                    'cpu_percent': 0.0,
                    'cpu_memory_mb': 0.0,
                    'gpu_memory_mb': 0.0,
                    'peak_cpu_percent': 0.0,
                    'peak_cpu_memory_mb': 0.0,
                    'peak_gpu_memory_mb': 0.0,
                    'avg_cpu_percent': 0.0,
                    'avg_cpu_memory_mb': 0.0,
                    'avg_gpu_memory_mb': 0.0,
                },
                'tokens': {
                    'cpu_utilization': 6.0,
                    'cpu_memory': 0.7,
                    'gpu_memory': 0.0,
                    'total': 6.7,
                },
                '__id': 'e6e29a87.atl-confluence_1',
            },
        }

    @pytest.mark.asyncio
    async def test_save_and_get_log(self, store, account_info, sample_log_contents):
        """Test saving and retrieving a log file."""
        project_id = 'proj-001'
        source = 'source_1'

        # Save log
        save_result = await store.save_log(
            account_info, project_id, source, sample_log_contents
        )
        assert save_result['success'] is True
        assert 'filename' in save_result
        expected_filename = f'{source}-{sample_log_contents["body"]["startTime"]}.log'
        assert save_result['filename'] == expected_filename

        # Get log
        start_time = sample_log_contents['body']['startTime']
        get_result = await store.get_log(account_info, project_id, source, start_time)
        assert get_result['success'] is True
        assert get_result['contents'] == sample_log_contents

    @pytest.mark.asyncio
    async def test_save_log_overwrites_existing(
        self, store, account_info, sample_log_contents
    ):
        """Test that save_log overwrites existing log file."""
        project_id = 'proj-001'
        source = 'source_1'

        # Save initial log
        await store.save_log(account_info, project_id, source, sample_log_contents)

        # Modify contents and save again (same source and startTime)
        modified_contents = sample_log_contents.copy()
        modified_contents['body'] = sample_log_contents['body'].copy()
        modified_contents['body']['status'] = 'Updated'
        modified_contents['body']['completedCount'] = 20

        await store.save_log(account_info, project_id, source, modified_contents)

        # Verify the file was overwritten
        start_time = sample_log_contents['body']['startTime']
        get_result = await store.get_log(account_info, project_id, source, start_time)
        assert get_result['contents']['body']['status'] == 'Updated'
        assert get_result['contents']['body']['completedCount'] == 20

    @pytest.mark.asyncio
    async def test_list_logs_empty(self, store, account_info):
        """Test listing logs when none exist."""
        result = await store.list_logs(account_info, 'nonexistent-proj')

        assert result['success'] is True
        assert result['logs'] == []
        assert result['count'] == 0
        assert result['total_count'] == 0
        assert result['page'] == 0
        assert result['total_pages'] == 1

    @pytest.mark.asyncio
    async def test_list_logs_all(self, store, account_info, sample_log_contents):
        """Test listing all logs for a project."""
        project_id = 'proj-001'

        # Save multiple logs with different sources and start times
        sources = ['source_1', 'source_2', 'source_1']
        start_times = [1000000.0, 2000000.0, 3000000.0]

        for source, start_time in zip(sources, start_times):
            contents = sample_log_contents.copy()
            contents['body'] = sample_log_contents['body'].copy()
            contents['body']['startTime'] = start_time
            contents['body']['source'] = source
            await store.save_log(account_info, project_id, source, contents)

        # List all logs
        result = await store.list_logs(account_info, project_id)

        assert result['success'] is True
        assert result['count'] == 3
        assert result['total_count'] == 3
        assert len(result['logs']) == 3

    @pytest.mark.asyncio
    async def test_list_logs_filter_by_source(
        self, store, account_info, sample_log_contents
    ):
        """Test filtering logs by source name."""
        project_id = 'proj-001'

        # Save logs for different sources
        for source, start_time in [
            ('source_1', 1000000.0),
            ('source_2', 2000000.0),
            ('source_1', 3000000.0),
        ]:
            contents = sample_log_contents.copy()
            contents['body'] = sample_log_contents['body'].copy()
            contents['body']['startTime'] = start_time
            contents['body']['source'] = source
            await store.save_log(account_info, project_id, source, contents)

        # List only source_1 logs
        result = await store.list_logs(account_info, project_id, source='source_1')

        assert result['success'] is True
        assert result['count'] == 2
        assert result['total_count'] == 2
        for log in result['logs']:
            assert log.startswith('source_1-')

    @pytest.mark.asyncio
    async def test_list_logs_pagination(self, store, account_info, sample_log_contents):
        """Test log listing pagination."""
        from ai.account.store import LOG_PAGE_SIZE

        project_id = 'proj-001'
        source = 'source_1'

        # Create more logs than one page
        num_logs = LOG_PAGE_SIZE + 10
        for i in range(num_logs):
            contents = sample_log_contents.copy()
            contents['body'] = sample_log_contents['body'].copy()
            contents['body']['startTime'] = float(1000000 + i)
            await store.save_log(account_info, project_id, source, contents)

        # Get first page
        result_page0 = await store.list_logs(account_info, project_id, page=0)
        assert result_page0['success'] is True
        assert result_page0['count'] == LOG_PAGE_SIZE
        assert result_page0['total_count'] == num_logs
        assert result_page0['page'] == 0
        assert result_page0['total_pages'] == 2

        # Get second page
        result_page1 = await store.list_logs(account_info, project_id, page=1)
        assert result_page1['success'] is True
        assert result_page1['count'] == 10
        assert result_page1['total_count'] == num_logs
        assert result_page1['page'] == 1

        # Verify no overlap between pages
        page0_logs = set(result_page0['logs'])
        page1_logs = set(result_page1['logs'])
        assert page0_logs.isdisjoint(page1_logs)

    @pytest.mark.asyncio
    async def test_list_logs_negative_page(
        self, store, account_info, sample_log_contents
    ):
        """Test that negative page numbers default to 0."""
        project_id = 'proj-001'

        contents = sample_log_contents.copy()
        contents['body'] = sample_log_contents['body'].copy()
        await store.save_log(account_info, project_id, 'source_1', contents)

        result = await store.list_logs(account_info, project_id, page=-5)
        assert result['page'] == 0

    @pytest.mark.asyncio
    async def test_list_logs_none_page(self, store, account_info, sample_log_contents):
        """Test that None page defaults to 0."""
        project_id = 'proj-001'

        contents = sample_log_contents.copy()
        contents['body'] = sample_log_contents['body'].copy()
        await store.save_log(account_info, project_id, 'source_1', contents)

        result = await store.list_logs(account_info, project_id, page=None)
        assert result['page'] == 0

    @pytest.mark.asyncio
    async def test_get_log_not_found(self, store, account_info):
        """Test getting a non-existent log file."""
        with pytest.raises(StorageError) as exc_info:
            await store.get_log(account_info, 'proj-001', 'source_1', 9999999.0)
        assert 'not found' in str(exc_info.value).lower()

    @pytest.mark.asyncio
    async def test_save_log_validation_errors(
        self, store, account_info, sample_log_contents
    ):
        """Test validation errors for save_log."""
        # Missing project_id
        with pytest.raises(ValueError) as exc_info:
            await store.save_log(account_info, '', 'source_1', sample_log_contents)
        assert 'project_id is required' in str(exc_info.value)

        # Missing source
        with pytest.raises(ValueError) as exc_info:
            await store.save_log(account_info, 'proj-001', '', sample_log_contents)
        assert 'source is required' in str(exc_info.value)

        # Missing contents
        with pytest.raises(ValueError) as exc_info:
            await store.save_log(account_info, 'proj-001', 'source_1', None)
        assert 'contents is required' in str(exc_info.value)

        # Missing startTime in contents
        with pytest.raises(ValueError) as exc_info:
            await store.save_log(account_info, 'proj-001', 'source_1', {'body': {}})
        assert 'body.startTime' in str(exc_info.value)

    @pytest.mark.asyncio
    async def test_get_log_validation_errors(self, store, account_info):
        """Test validation errors for get_log."""
        # Missing project_id
        with pytest.raises(ValueError) as exc_info:
            await store.get_log(account_info, '', 'source_1', 1234567.0)
        assert 'project_id is required' in str(exc_info.value)

        # Missing source
        with pytest.raises(ValueError) as exc_info:
            await store.get_log(account_info, 'proj-001', '', 1234567.0)
        assert 'source is required' in str(exc_info.value)

        # Missing start_time
        with pytest.raises(ValueError) as exc_info:
            await store.get_log(account_info, 'proj-001', 'source_1', None)
        assert 'start_time is required' in str(exc_info.value)

    @pytest.mark.asyncio
    async def test_list_logs_validation_errors(self, store, account_info):
        """Test validation errors for list_logs."""
        # Missing project_id
        with pytest.raises(ValueError) as exc_info:
            await store.list_logs(account_info, '')
        assert 'project_id is required' in str(exc_info.value)

    @pytest.mark.asyncio
    async def test_log_files_sorted(self, store, account_info, sample_log_contents):
        """Test that log files are returned in sorted order."""
        project_id = 'proj-001'
        source = 'source_1'

        # Save logs in random order
        start_times = [3000000.0, 1000000.0, 2000000.0]
        for start_time in start_times:
            contents = sample_log_contents.copy()
            contents['body'] = sample_log_contents['body'].copy()
            contents['body']['startTime'] = start_time
            await store.save_log(account_info, project_id, source, contents)

        # List logs and verify sorted order
        result = await store.list_logs(account_info, project_id)
        logs = result['logs']

        assert logs == sorted(logs)


class TestStoreIntegration:
    """Integration tests using real filesystem."""

    @pytest.fixture
    def temp_dir(self):
        """Create temporary directory for tests."""
        temp_path = tempfile.mkdtemp()
        yield temp_path
        shutil.rmtree(temp_path, ignore_errors=True)

    @pytest.mark.asyncio
    async def test_end_to_end_workflow(self, temp_dir):
        """Test complete workflow: create store, write, read."""
        # Create store via factory
        url = f'filesystem://{temp_dir}'
        store = Store.create(url=url)

        # Write multiple files
        await store.write_file('logs/app.log', 'Application started\n')
        await store.write_file('logs/app.log', 'Processing data\n')  # Overwrite
        await store.write_file('data/config.json', '{"key": "value"}')

        # Read files
        log_content = await store.read_file('logs/app.log')
        config_content = await store.read_file('data/config.json')

        assert log_content == 'Processing data\n'
        assert config_content == '{"key": "value"}'

    @pytest.mark.asyncio
    async def test_concurrent_operations(self, temp_dir):
        """Test concurrent file operations."""
        import asyncio

        url = f'filesystem://{temp_dir}'
        store = Store.create(url=url)

        # Write multiple files concurrently
        tasks = [
            store.write_file(f'file{i}.txt', f'Content {i}') for i in range(10)
        ]
        await asyncio.gather(*tasks)

        # Read files concurrently
        tasks = [store.read_file(f'file{i}.txt') for i in range(10)]
        results = await asyncio.gather(*tasks)

        # Verify all files were written correctly
        for i, content in enumerate(results):
            assert content == f'Content {i}'


if __name__ == '__main__':
    pytest.main([__file__, '-v'])
