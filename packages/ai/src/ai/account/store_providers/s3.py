"""AWS S3 storage implementation."""

import asyncio
import json
from typing import Optional
from tenacity import retry, stop_after_attempt, wait_exponential, retry_if_exception_type
from ..store import IStore, StorageError, VersionMismatchError, STORE_MAX_RETRY_ATTEMPTS


class S3Store(IStore):
    """
    AWS S3 storage implementation.

    Uses in-memory buffering since S3 doesn't support true append operations.
    """

    # =========================================================================
    # Nested Classes
    # =========================================================================

    class _RaceConditionError(Exception):
        """Internal exception to trigger retry on race condition (file deleted externally)."""

    # =========================================================================
    # Initialization
    # =========================================================================

    def __init__(self, url: str, secret_key: Optional[str] = None):
        """Initialize S3 storage."""
        super().__init__(url, secret_key)

        if not url.startswith('s3://'):
            raise ValueError(f'Invalid S3 URL: {url}')

        path_part = url[len('s3://') :]
        parts = path_part.split('/', 1)
        self._bucket = parts[0]
        self._prefix = parts[1] if len(parts) > 1 else ''

        # Parse credentials
        self._access_key_id = None
        self._secret_access_key = None
        self._region = 'us-east-1'

        # Only parse secret_key if it's provided and not empty
        # Empty string or None will fall back to AWS credential chain (credentials file, env vars, IAM roles)
        if secret_key and secret_key.strip():
            try:
                creds = json.loads(secret_key)
                self._access_key_id = creds.get('access_key_id')
                self._secret_access_key = creds.get('secret_access_key')
                self._region = creds.get('region', 'us-east-1')
            except json.JSONDecodeError:
                raise ValueError('Invalid S3 credentials format (expected JSON)')

        self._s3_client = None

    # =========================================================================
    # Public Methods (IStore Interface Implementation)
    # =========================================================================

    @retry(
        stop=stop_after_attempt(STORE_MAX_RETRY_ATTEMPTS),
        wait=wait_exponential(multiplier=1, min=1),
        retry=retry_if_exception_type((ConnectionError, TimeoutError)),
        reraise=True,
    )
    async def write_file(self, filename: str, data: str) -> None:
        """
        Write data to S3 with retry logic.

        Retries with exponential backoff on connection or timeout errors.
        """
        try:
            client = self._get_client()
            key = self._get_key(filename)

            await asyncio.to_thread(client.put_object, Bucket=self._bucket, Key=key, Body=data.encode('utf-8'))

        except (ConnectionError, TimeoutError):
            # Let these bubble up for retry
            raise
        except Exception as e:
            raise StorageError(f'Failed to write file {filename} to S3: {e}') from e

    @retry(
        stop=stop_after_attempt(STORE_MAX_RETRY_ATTEMPTS),
        wait=wait_exponential(multiplier=1, min=1),
        retry=retry_if_exception_type((ConnectionError, TimeoutError)),
        reraise=True,
    )
    async def read_file(self, filename: str) -> str:
        """
        Read data from S3 with retry logic.

        Retries with exponential backoff on connection or timeout errors.
        """
        try:
            client = self._get_client()
            key = self._get_key(filename)

            def _read():
                response = client.get_object(Bucket=self._bucket, Key=key)
                return response['Body'].read()

            data = await asyncio.to_thread(_read)
            return data.decode('utf-8')

        except (ConnectionError, TimeoutError):
            # Let these bubble up for retry
            raise
        except Exception as e:
            # Check for NoSuchKey exception (can be ClientError with 'NoSuchKey' in message or class name)
            if self._is_no_such_key_error(e):
                raise StorageError(f'File not found: {filename}')
            raise StorageError(f'Failed to read file {filename} from S3: {e}') from e

    @retry(
        stop=stop_after_attempt(STORE_MAX_RETRY_ATTEMPTS),
        wait=wait_exponential(multiplier=1, min=1),
        retry=retry_if_exception_type((ConnectionError, TimeoutError)),
        reraise=True,
    )
    async def read_file_with_metadata(self, filename: str) -> tuple:
        """
        Read data from S3 with ETag metadata.

        Returns tuple of (content, etag)
        """
        try:
            client = self._get_client()
            key = self._get_key(filename)

            def _read():
                response = client.get_object(Bucket=self._bucket, Key=key)
                data = response['Body'].read()
                return data, response.get('ETag', '').strip('"')

            data, etag = await asyncio.to_thread(_read)
            return (data.decode('utf-8'), etag)

        except (ConnectionError, TimeoutError):
            raise
        except Exception as e:
            # Check for NoSuchKey exception (can be ClientError with 'NoSuchKey' in message or class name)
            if self._is_no_such_key_error(e):
                raise StorageError(f'File not found: {filename}')
            raise StorageError(f'Failed to read file {filename} from S3: {e}') from e

    @retry(
        stop=stop_after_attempt(STORE_MAX_RETRY_ATTEMPTS),
        wait=wait_exponential(multiplier=1, min=1),
        retry=retry_if_exception_type((ConnectionError, TimeoutError, _RaceConditionError)),
        reraise=True,
    )
    async def write_file_atomic(self, filename: str, data: str, expected_version: Optional[str] = None) -> str:
        """
        Write data to S3 atomically with ETag check.

        Uses S3's conditional write with If-Match header for atomicity.

        If expected_version is provided but the file was deleted externally,
        the file will be recreated (graceful handling of stale version references).
        Retries automatically on connection errors, timeouts, and race conditions.
        """
        try:
            client = self._get_client()
            key = self._get_key(filename)

            # Check if file exists - expected_version is REQUIRED for updates
            file_exists = False
            try:
                await asyncio.to_thread(client.head_object, Bucket=self._bucket, Key=key)
                file_exists = True
            except Exception as e:
                # Check if it's a NoSuchKey error (file doesn't exist)
                if not self._is_no_such_key_error(e):
                    # Some other error occurred
                    raise

            if file_exists and expected_version is None:
                raise StorageError(f'Expected version is required when updating existing file: {filename}')

            put_kwargs = {
                'Bucket': self._bucket,
                'Key': key,
                'Body': data.encode('utf-8'),
            }

            # Only use conditional put if file exists AND expected_version is provided
            # If expected_version is provided but file doesn't exist (was deleted externally),
            # we just create the file without the IfMatch condition
            if expected_version is not None and file_exists:
                put_kwargs['IfMatch'] = expected_version

            try:
                response = await asyncio.to_thread(lambda: client.put_object(**put_kwargs))
            except Exception as put_error:
                # Handle race condition: file was deleted between head_object and put_object
                # When IfMatch is used but key doesn't exist, S3 returns NoSuchKey
                if self._is_no_such_key_error(put_error) and expected_version is not None:
                    # File state changed - trigger tenacity retry
                    raise self._RaceConditionError(f'Race condition detected for {filename}: file deleted between check and write') from put_error
                raise

            new_etag = response.get('ETag', '').strip('"')
            return new_etag

        except (ConnectionError, TimeoutError, self._RaceConditionError):
            # Let tenacity handle retries
            raise
        except Exception as e:
            # Check for PreconditionFailed (version mismatch)
            # Can be ClientError with 'PreconditionFailed' in message, or HTTP 412
            if 'PreconditionFailed' in str(e) or '412' in str(e):
                raise VersionMismatchError(
                    filename=filename,
                    expected_version=expected_version,
                ) from e
            raise StorageError(f'Failed to write file {filename} to S3: {e}') from e

    @retry(
        stop=stop_after_attempt(STORE_MAX_RETRY_ATTEMPTS),
        wait=wait_exponential(multiplier=1, min=1),
        retry=retry_if_exception_type((ConnectionError, TimeoutError)),
        reraise=True,
    )
    async def delete_file(self, filename: str, expected_version: Optional[str] = None) -> None:
        """
        Delete file from S3 with optional ETag check.

        Uses S3's conditional delete with If-Match header for atomicity.
        """
        try:
            client = self._get_client()
            key = self._get_key(filename)

            # Verify file exists first
            try:
                head_response = await asyncio.to_thread(client.head_object, Bucket=self._bucket, Key=key)
                current_etag = head_response.get('ETag', '').strip('"')

                # expected_version is REQUIRED for delete operations
                if expected_version is None:
                    raise StorageError(f'Expected version is required when deleting file: {filename}')

                # Verify version matches
                if current_etag != expected_version:
                    raise VersionMismatchError(
                        filename=filename,
                        expected_version=expected_version,
                        actual_version=current_etag,
                    )

            except Exception as e:
                # Check for NotFound/NoSuchKey (can be ClientError with error code in message)
                if self._is_no_such_key_error(e):
                    raise StorageError(f'File not found: {filename}')
                raise

            # Delete the file
            await asyncio.to_thread(client.delete_object, Bucket=self._bucket, Key=key)

        except (ConnectionError, TimeoutError):
            raise
        except StorageError:
            raise
        except Exception as e:
            raise StorageError(f'Failed to delete file {filename} from S3: {e}') from e

    @retry(
        stop=stop_after_attempt(STORE_MAX_RETRY_ATTEMPTS),
        wait=wait_exponential(multiplier=1, min=1),
        retry=retry_if_exception_type((ConnectionError, TimeoutError)),
        reraise=True,
    )
    async def list_files(self, prefix: str = '') -> list:
        """
        List all files in S3 with given prefix.
        """
        try:
            client = self._get_client()
            key_prefix = self._get_key(prefix) if prefix else self._prefix

            def _list():
                result = []
                paginator = client.get_paginator('list_objects_v2')
                page_kwargs = {'Bucket': self._bucket}
                if key_prefix:
                    page_kwargs['Prefix'] = key_prefix
                for page in paginator.paginate(**page_kwargs):
                    if 'Contents' in page:
                        for obj in page['Contents']:
                            k = obj['Key']
                            if self._prefix and k.startswith(self._prefix + '/'):
                                relative_key = k[len(self._prefix) + 1 :]
                            elif self._prefix and k.startswith(self._prefix):
                                relative_key = k[len(self._prefix) :]
                            else:
                                relative_key = k
                            result.append(relative_key)
                return sorted(result)

            return await asyncio.to_thread(_list)

        except (ConnectionError, TimeoutError):
            raise
        except Exception as e:
            raise StorageError(f'Failed to list files with prefix {prefix} from S3: {e}') from e

    # =========================================================================
    # Handle-Based I/O
    # =========================================================================

    # S3 minimum part size (5 MB) — all parts except the last must be >= this
    _S3_MIN_PART_SIZE = 5 * 1024 * 1024

    async def open_write(self, filename: str) -> dict:
        """Prepare a write session. Multipart upload is deferred until needed."""
        try:
            key = self._get_key(filename)
            return {
                'context': {
                    'key': key,
                    'upload_id': None,
                    'parts': [],
                    'part_number': 1,
                    'buffer': bytearray(),
                },
            }
        except Exception as e:
            raise StorageError(f'Failed to prepare upload for {filename}: {e}') from e

    async def write_chunk(self, filename: str, context, data: bytes) -> int:
        """Buffer data and flush as S3 parts when buffer reaches 5 MB."""
        try:
            context['buffer'].extend(data)
            written = len(data)

            # Flush parts while buffer is large enough
            while len(context['buffer']) >= self._S3_MIN_PART_SIZE:
                # Lazily create multipart upload on first flush
                if context['upload_id'] is None:
                    client = self._get_client()
                    response = await asyncio.to_thread(client.create_multipart_upload, Bucket=self._bucket, Key=context['key'])
                    context['upload_id'] = response['UploadId']

                chunk = bytes(context['buffer'][: self._S3_MIN_PART_SIZE])
                await self._upload_part(context, chunk)
                del context['buffer'][: self._S3_MIN_PART_SIZE]

            return written
        except Exception as e:
            raise StorageError(f'Failed to write chunk to {filename}: {e}') from e

    async def close_write(self, filename: str, context) -> None:
        """Finalize the upload — single put_object if small, complete multipart otherwise."""
        try:
            client = self._get_client()
            remaining = bytes(context['buffer'])
            context['buffer'].clear()

            if context['upload_id'] is None:
                # No multipart was started — simple put_object
                await asyncio.to_thread(client.put_object, Bucket=self._bucket, Key=context['key'], Body=remaining)
            else:
                # Flush remaining buffer as the final part (can be < 5 MB)
                if remaining:
                    await self._upload_part(context, remaining)

                await asyncio.to_thread(
                    client.complete_multipart_upload,
                    Bucket=self._bucket,
                    Key=context['key'],
                    UploadId=context['upload_id'],
                    MultipartUpload={'Parts': context['parts']},
                )
        except Exception as e:
            # Best-effort abort on failure (only if multipart was started)
            if context.get('upload_id'):
                try:
                    await asyncio.to_thread(
                        self._get_client().abort_multipart_upload,
                        Bucket=self._bucket,
                        Key=context['key'],
                        UploadId=context['upload_id'],
                    )
                except Exception:
                    pass
            raise StorageError(f'Failed to finalize upload for {filename}: {e}') from e

    async def abort_write(self, filename: str, context) -> None:
        """Close the upload, committing whatever has been written."""
        await self.close_write(filename, context)

    async def open_read(self, filename: str) -> dict:
        """Get file size via head_object for ranged reads."""
        try:
            client = self._get_client()
            key = self._get_key(filename)
            response = await asyncio.to_thread(client.head_object, Bucket=self._bucket, Key=key)
            size = response['ContentLength']
            return {'context': {'key': key}, 'size': size}
        except Exception as e:
            if self._is_no_such_key_error(e):
                raise StorageError(f'File not found: {filename}')
            raise StorageError(f'Failed to open {filename} for reading: {e}') from e

    async def read_chunk(self, filename: str, context, offset: int, length: int = 4_194_304) -> bytes:
        """Read a range of bytes from S3."""
        try:
            client = self._get_client()
            end = offset + length - 1

            def _read_range():
                response = client.get_object(Bucket=self._bucket, Key=context['key'], Range=f'bytes={offset}-{end}')
                return response['Body'].read()

            return await asyncio.to_thread(_read_range)
        except Exception as e:
            # Empty response at EOF
            error_str = str(e)
            if 'InvalidRange' in error_str or '416' in error_str:
                return b''
            raise StorageError(f'Failed to read chunk from {filename}: {e}') from e

    async def close_read(self, filename: str, context) -> None:
        """No-op — S3 reads are stateless."""
        pass

    async def get_file_info(self, filename: str) -> dict:
        """Get file size and modification time via head_object."""
        try:
            client = self._get_client()
            key = self._get_key(filename)
            response = await asyncio.to_thread(client.head_object, Bucket=self._bucket, Key=key)
            return {
                'size': response['ContentLength'],
                'modified': response['LastModified'].timestamp(),
            }
        except Exception as e:
            if self._is_no_such_key_error(e):
                raise StorageError(f'File not found: {filename}')
            raise StorageError(f'Failed to get file info for {filename}: {e}') from e

    async def _upload_part(self, context: dict, data: bytes) -> None:
        """Upload a single part and record its ETag."""
        client = self._get_client()
        response = await asyncio.to_thread(
            client.upload_part,
            Bucket=self._bucket,
            Key=context['key'],
            UploadId=context['upload_id'],
            PartNumber=context['part_number'],
            Body=data,
        )
        context['parts'].append(
            {
                'PartNumber': context['part_number'],
                'ETag': response['ETag'],
            }
        )
        context['part_number'] += 1

    # =========================================================================
    # Private Static Methods
    # =========================================================================

    @staticmethod
    def _is_no_such_key_error(e: Exception) -> bool:
        """Check if exception indicates file/key does not exist in S3."""
        error_str = str(e)
        class_name = type(e).__name__
        return 'NoSuchKey' in error_str or 'NoSuchKey' in class_name or 'NotFound' in error_str or '404' in error_str

    # =========================================================================
    # Private Methods
    # =========================================================================

    def _get_client(self):
        """Get or create S3 client."""
        if self._s3_client is None:
            try:
                import boto3

                if self._access_key_id and self._secret_access_key:
                    self._s3_client = boto3.client(
                        's3',
                        aws_access_key_id=self._access_key_id,
                        aws_secret_access_key=self._secret_access_key,
                        region_name=self._region,
                    )
                else:
                    self._s3_client = boto3.client('s3', region_name=self._region)

            except ImportError:
                raise StorageError('boto3 library not installed. Install with: pip install boto3')
            except Exception as e:
                raise StorageError(f'Failed to create S3 client: {e}') from e

        return self._s3_client

    def _get_key(self, path: str) -> str:
        """Convert relative path to S3 key."""
        import posixpath

        path = path.replace('\\', '/')
        if self._prefix:
            full_key = posixpath.normpath(f'{self._prefix}/{path}')
            # Ensure the resolved key stays within the prefix
            if not full_key.startswith(self._prefix + '/') and full_key != self._prefix:
                raise StorageError(f'Path traversal detected: {path}')
            return full_key
        return posixpath.normpath(path)
