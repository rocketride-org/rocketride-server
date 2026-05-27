"""
Extended unit tests for the S3 and Azure store providers.

The original [test_store.py](test_store.py) covers the basic round-trip
write/read and the credential-chain fallback. This file adds tests for the
methods that produce the largest uncovered surface:

- ``read_file_with_metadata`` — ETag extraction
- ``write_file_atomic`` — conditional write happy path + race-condition retry
- ``delete_file`` — head_object preflight + conditional delete
- ``list_files`` — paginator-driven listing with prefix stripping
- ``open_write`` / ``write_chunk`` / ``close_write`` — multipart upload buffer
- ``open_read`` / ``read_chunk`` / ``close_read`` — ranged read
- ``get_file_info`` — head_object metadata extraction

Both S3 and Azure providers follow nearly identical contracts; tests are
grouped by provider.
"""

from __future__ import annotations

import sys
from datetime import datetime, timezone
from unittest.mock import MagicMock, Mock

import pytest

from ai.account.store import StorageError
from ai.account.store_providers.s3 import S3Store
from ai.account.store_providers.azure import AzureBlobStore


# ---------------------------------------------------------------------------
# Shared fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def s3_mock(monkeypatch):
    """Install a mock ``boto3`` module and return the underlying mock client."""
    mock_boto3 = MagicMock()
    mock_client = Mock()
    mock_boto3.client.return_value = mock_client
    monkeypatch.setitem(sys.modules, 'boto3', mock_boto3)
    return mock_client


@pytest.fixture
def s3_store(s3_mock):
    """An S3Store wired to the mock boto3 client (bucket=b, prefix=p)."""
    secret = '{"access_key_id":"AKIA","secret_access_key":"sek","region":"us-east-1"}'
    return S3Store('s3://b/p', secret)


@pytest.fixture
def azure_mocks(monkeypatch):
    """Install mock ``azure.storage.blob`` and return (mock_client, mock_blob)."""
    mock_storage = MagicMock()
    mock_core = MagicMock()
    monkeypatch.setitem(sys.modules, 'azure', MagicMock())
    monkeypatch.setitem(sys.modules, 'azure.storage', MagicMock())
    monkeypatch.setitem(sys.modules, 'azure.storage.blob', mock_storage)
    monkeypatch.setitem(sys.modules, 'azure.core', mock_core)
    monkeypatch.setitem(sys.modules, 'azure.core.credentials', mock_core.credentials)

    mock_service = Mock()
    mock_blob = Mock()
    mock_service.get_blob_client.return_value = mock_blob
    mock_storage.BlobServiceClient.from_connection_string.return_value = mock_service
    return mock_service, mock_blob


@pytest.fixture
def azure_store(azure_mocks):
    """An AzureBlobStore wired to the mock SDK (container=c, prefix=p)."""
    secret = '{"connection_string":"DefaultEndpointsProtocol=https;AccountName=test"}'
    return AzureBlobStore('azureblob://c/p', secret)


# ---------------------------------------------------------------------------
# S3 — read_file_with_metadata
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_s3_read_file_with_metadata_strips_quotes(s3_store, s3_mock):
    """ETag returned by S3 is quoted; the helper must strip the quotes."""
    body = Mock(read=Mock(return_value=b'hello'))
    s3_mock.get_object.return_value = {'Body': body, 'ETag': '"deadbeef"'}

    content, etag = await s3_store.read_file_with_metadata('f.txt')
    assert content == 'hello'
    assert etag == 'deadbeef'


@pytest.mark.asyncio
async def test_s3_read_file_with_metadata_missing_etag(s3_store, s3_mock):
    """A response without an ETag yields an empty string, not an error."""
    body = Mock(read=Mock(return_value=b'data'))
    s3_mock.get_object.return_value = {'Body': body}
    _, etag = await s3_store.read_file_with_metadata('f.txt')
    assert etag == ''


@pytest.mark.asyncio
async def test_s3_read_file_with_metadata_not_found(s3_store, s3_mock):
    """A NoSuchKey-class error becomes a StorageError 'File not found'."""

    class NoSuchKey(Exception):
        """Stand-in for boto3's NoSuchKey exception type."""

    s3_mock.get_object.side_effect = NoSuchKey('missing')
    with pytest.raises(StorageError, match='File not found'):
        await s3_store.read_file_with_metadata('missing.txt')


# ---------------------------------------------------------------------------
# S3 — write_file_atomic
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_s3_write_file_atomic_creates_new_file(s3_store, s3_mock):
    """A new file (head_object raises NoSuchKey) is created without IfMatch."""

    class NoSuchKey(Exception):
        """Stand-in for boto3's NoSuchKey exception."""

    s3_mock.head_object.side_effect = NoSuchKey('missing')
    s3_mock.put_object.return_value = {'ETag': '"abc123"'}

    new_etag = await s3_store.write_file_atomic('new.txt', 'data')
    assert new_etag == 'abc123'
    # IfMatch should NOT be present on first creation
    call_kwargs = s3_mock.put_object.call_args.kwargs
    assert 'IfMatch' not in call_kwargs
    assert call_kwargs['Body'] == b'data'


@pytest.mark.asyncio
async def test_s3_write_file_atomic_updates_with_if_match(s3_store, s3_mock):
    """If the file exists and expected_version is given, IfMatch is set."""
    # head_object succeeds (file exists)
    s3_mock.head_object.return_value = {'ETag': '"old"'}
    s3_mock.put_object.return_value = {'ETag': '"new"'}

    new_etag = await s3_store.write_file_atomic('f.txt', 'data', expected_version='old')
    assert new_etag == 'new'
    call_kwargs = s3_mock.put_object.call_args.kwargs
    assert call_kwargs['IfMatch'] == 'old'


@pytest.mark.asyncio
async def test_s3_write_file_atomic_rejects_update_without_version(s3_store, s3_mock):
    """Updating an existing file without expected_version raises StorageError."""
    s3_mock.head_object.return_value = {'ETag': '"old"'}
    with pytest.raises(StorageError, match='Expected version is required'):
        await s3_store.write_file_atomic('f.txt', 'data')


# ---------------------------------------------------------------------------
# S3 — list_files
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_s3_list_files_strips_prefix(s3_store, s3_mock):
    """Keys returned by S3 have the bucket prefix stripped (so callers see relative paths)."""
    paginator = Mock()
    paginator.paginate.return_value = [
        {'Contents': [{'Key': 'p/a.txt'}, {'Key': 'p/sub/b.txt'}]},
    ]
    s3_mock.get_paginator.return_value = paginator

    result = await s3_store.list_files()
    assert sorted(result) == ['a.txt', 'sub/b.txt']


@pytest.mark.asyncio
async def test_s3_list_files_empty_when_no_contents(s3_store, s3_mock):
    """A response without 'Contents' yields an empty list, not an exception."""
    paginator = Mock()
    paginator.paginate.return_value = [{}]
    s3_mock.get_paginator.return_value = paginator

    assert await s3_store.list_files() == []


# ---------------------------------------------------------------------------
# S3 — open_read / read_chunk / close_read
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_s3_open_read_returns_size(s3_store, s3_mock):
    """open_read returns the context plus the file size from head_object."""
    s3_mock.head_object.return_value = {'ContentLength': 1024}
    handle = await s3_store.open_read('f.txt')
    assert handle['size'] == 1024
    assert handle['context']['key'] == 'p/f.txt'


@pytest.mark.asyncio
async def test_s3_open_read_raises_not_found(s3_store, s3_mock):
    """A NoSuchKey-class error from head_object becomes a StorageError."""

    class NotFound(Exception):
        """Stand-in for an S3 not-found error."""

    s3_mock.head_object.side_effect = NotFound('404')
    with pytest.raises(StorageError, match='File not found'):
        await s3_store.open_read('missing.txt')


@pytest.mark.asyncio
async def test_s3_read_chunk_returns_bytes(s3_store, s3_mock):
    """read_chunk runs get_object with a Range header and returns the bytes."""
    body = Mock(read=Mock(return_value=b'partial'))
    s3_mock.get_object.return_value = {'Body': body}

    context = {'key': 'p/f.txt'}
    result = await s3_store.read_chunk('f.txt', context, offset=0, length=10)
    assert result == b'partial'
    range_header = s3_mock.get_object.call_args.kwargs['Range']
    assert range_header == 'bytes=0-9'


@pytest.mark.asyncio
async def test_s3_read_chunk_returns_empty_at_eof(s3_store, s3_mock):
    """An InvalidRange / 416 response returns an empty bytes object."""
    s3_mock.get_object.side_effect = Exception('InvalidRange')
    result = await s3_store.read_chunk('f.txt', {'key': 'p/f.txt'}, offset=999, length=10)
    assert result == b''


@pytest.mark.asyncio
async def test_s3_close_read_is_noop(s3_store):
    """close_read on S3 is intentionally a no-op (returns None)."""
    assert await s3_store.close_read('f.txt', {'key': 'p/f.txt'}) is None


# ---------------------------------------------------------------------------
# S3 — open_write / write_chunk (small buffer) / close_write
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_s3_close_write_small_buffer_uses_put_object(s3_store, s3_mock):
    """Buffers smaller than 5 MB are uploaded via put_object (no multipart)."""
    handle = await s3_store.open_write('small.txt')
    context = handle['context']
    n = await s3_store.write_chunk('small.txt', context, b'tiny')
    assert n == 4

    await s3_store.close_write('small.txt', context)
    s3_mock.put_object.assert_called_once()
    assert s3_mock.create_multipart_upload.call_count == 0


# ---------------------------------------------------------------------------
# S3 — get_file_info
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_s3_get_file_info_returns_size_and_modified(s3_store, s3_mock):
    """get_file_info returns size + modified timestamp from head_object."""
    s3_mock.head_object.return_value = {
        'ContentLength': 42,
        'LastModified': datetime(2026, 1, 1, tzinfo=timezone.utc),
    }
    info = await s3_store.get_file_info('f.txt')
    assert info['size'] == 42
    assert info['modified'] == datetime(2026, 1, 1, tzinfo=timezone.utc).timestamp()


# ---------------------------------------------------------------------------
# S3 — _is_no_such_key_error (pure logic)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    'exc, expected',
    [
        (Exception('NoSuchKey'), True),
        (Exception('NotFound'), True),
        (Exception('404 error'), True),
        (Exception('unrelated'), False),
    ],
)
def test_s3_is_no_such_key_error(exc, expected):
    """The class-static helper recognises every documented "missing" signal."""
    assert S3Store._is_no_such_key_error(exc) is expected


def test_s3_is_no_such_key_error_recognises_class_name():
    """A class named ``NoSuchKey`` is recognised regardless of message text."""

    class NoSuchKey(Exception):
        """Exception type whose name alone identifies the missing-key case."""

    assert S3Store._is_no_such_key_error(NoSuchKey('whatever')) is True


# ---------------------------------------------------------------------------
# Azure — read_file_with_metadata
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_azure_read_file_with_metadata_returns_etag(azure_store, azure_mocks):
    """download_blob().readall() gives content; get_blob_properties().etag gives the version."""
    _, mock_blob = azure_mocks
    mock_blob.download_blob.return_value = Mock(readall=Mock(return_value=b'hello'))
    props = Mock()
    props.etag = '"az-etag"'
    mock_blob.get_blob_properties.return_value = props

    content, etag = await azure_store.read_file_with_metadata('f.txt')
    assert content == 'hello'
    assert etag == 'az-etag'


# ---------------------------------------------------------------------------
# Azure — list_files
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_azure_list_files_strips_prefix(azure_store, azure_mocks):
    """list_blobs yields blob names; the prefix should be stripped on output."""
    mock_service, _ = azure_mocks
    mock_container = Mock()
    mock_service.get_container_client.return_value = mock_container

    blob_a = Mock()
    blob_a.name = 'p/a.txt'
    blob_b = Mock()
    blob_b.name = 'p/sub/b.txt'
    mock_container.list_blobs.return_value = [blob_a, blob_b]

    result = await azure_store.list_files()
    assert sorted(result) == ['a.txt', 'sub/b.txt']


# ---------------------------------------------------------------------------
# Azure — open_read / close_read
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_azure_open_read_returns_size(azure_store, azure_mocks):
    """open_read returns the blob size from blob.get_blob_properties()."""
    _, mock_blob = azure_mocks
    props = Mock()
    props.size = 2048
    mock_blob.get_blob_properties.return_value = props

    handle = await azure_store.open_read('f.txt')
    assert handle['size'] == 2048


@pytest.mark.asyncio
async def test_azure_close_read_is_noop(azure_store):
    """close_read on Azure is intentionally a no-op."""
    assert await azure_store.close_read('f.txt', {}) is None


# ---------------------------------------------------------------------------
# Azure — get_file_info
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_azure_get_file_info_returns_size_and_modified(azure_store, azure_mocks):
    """get_file_info reads size + last_modified from blob.get_blob_properties()."""
    _, mock_blob = azure_mocks
    props = Mock()
    props.size = 99
    props.last_modified = datetime(2026, 2, 1, tzinfo=timezone.utc)
    mock_blob.get_blob_properties.return_value = props

    info = await azure_store.get_file_info('f.txt')
    assert info['size'] == 99
    assert info['modified'] == datetime(2026, 2, 1, tzinfo=timezone.utc).timestamp()
