"""Azure Blob Storage implementation."""

import json
from typing import Optional
from tenacity import retry, stop_after_attempt, wait_exponential, retry_if_exception_type
from ..store import IStore, StorageError, VersionMismatchError, STORE_MAX_RETRY_ATTEMPTS


class AzureBlobStore(IStore):
    """
    Azure Blob Storage implementation.

    Uses in-memory buffering for simplicity.
    """

    # =========================================================================
    # Initialization
    # =========================================================================

    def __init__(self, url: str, secret_key: Optional[str] = None):
        """Initialize Azure Blob storage."""
        super().__init__(url, secret_key)

        if url.startswith('azureblob://'):
            path_part = url[len('azureblob://') :]
        elif url.startswith('azure://'):
            path_part = url[len('azure://') :]
        else:
            raise ValueError(f'Invalid Azure Blob URL: {url}')

        parts = path_part.split('/', 1)
        self._container = parts[0]
        self._prefix = parts[1] if len(parts) > 1 else ''

        # Parse credentials
        self._account_name = None
        self._account_key = None
        self._connection_string = None

        if secret_key:
            try:
                creds = json.loads(secret_key)
                self._connection_string = creds.get('connection_string')
                if not self._connection_string:
                    self._account_name = creds.get('account_name')
                    self._account_key = creds.get('account_key')
            except json.JSONDecodeError:
                raise ValueError('Invalid Azure credentials format (expected JSON)')

        self._blob_service_client = None

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
        Write data to Azure Blob with retry logic.

        Retries with exponential backoff on connection or timeout errors.
        """
        try:
            client = self._get_client()
            blob_name = self._get_blob_name(filename)

            blob_client = client.get_blob_client(
                container=self._container,
                blob=blob_name,
            )
            blob_client.upload_blob(data.encode('utf-8'), overwrite=True)

        except (ConnectionError, TimeoutError):
            # Let these bubble up for retry
            raise
        except Exception as e:
            raise StorageError(f'Failed to write file {filename} to Azure: {e}') from e

    @retry(
        stop=stop_after_attempt(STORE_MAX_RETRY_ATTEMPTS),
        wait=wait_exponential(multiplier=1, min=1),
        retry=retry_if_exception_type((ConnectionError, TimeoutError)),
        reraise=True,
    )
    async def read_file(self, filename: str) -> str:
        """
        Read data from Azure Blob with retry logic.

        Retries with exponential backoff on connection or timeout errors.
        """
        try:
            client = self._get_client()
            blob_name = self._get_blob_name(filename)

            blob_client = client.get_blob_client(
                container=self._container,
                blob=blob_name,
            )
            download_stream = blob_client.download_blob()
            data = download_stream.readall()
            return data.decode('utf-8')

        except (ConnectionError, TimeoutError):
            # Let these bubble up for retry
            raise
        except Exception as e:
            if 'BlobNotFound' in str(e) or 'ResourceNotFound' in str(e):
                raise StorageError(f'File not found: {filename}')
            raise StorageError(f'Failed to read file {filename} from Azure: {e}') from e

    @retry(
        stop=stop_after_attempt(STORE_MAX_RETRY_ATTEMPTS),
        wait=wait_exponential(multiplier=1, min=1),
        retry=retry_if_exception_type((ConnectionError, TimeoutError)),
        reraise=True,
    )
    async def read_file_with_metadata(self, filename: str) -> tuple:
        """
        Read data from Azure Blob with ETag metadata.

        Returns tuple of (content, etag)
        """
        try:
            client = self._get_client()
            blob_name = self._get_blob_name(filename)

            blob_client = client.get_blob_client(
                container=self._container,
                blob=blob_name,
            )
            download_stream = blob_client.download_blob()
            data = download_stream.readall()
            content = data.decode('utf-8')

            # Get properties to retrieve ETag
            properties = blob_client.get_blob_properties()
            etag = properties.etag.strip('"')

            return (content, etag)

        except (ConnectionError, TimeoutError):
            raise
        except Exception as e:
            if 'BlobNotFound' in str(e) or 'ResourceNotFound' in str(e):
                raise StorageError(f'File not found: {filename}')
            raise StorageError(f'Failed to read file {filename} from Azure: {e}') from e

    @retry(
        stop=stop_after_attempt(STORE_MAX_RETRY_ATTEMPTS),
        wait=wait_exponential(multiplier=1, min=1),
        retry=retry_if_exception_type((ConnectionError, TimeoutError)),
        reraise=True,
    )
    async def write_file_atomic(self, filename: str, data: str, expected_version: Optional[str] = None) -> str:
        """
        Write data to Azure Blob atomically with ETag check.

        Uses Azure's conditional write with if-match for atomicity.
        """
        try:
            client = self._get_client()
            blob_name = self._get_blob_name(filename)

            blob_client = client.get_blob_client(
                container=self._container,
                blob=blob_name,
            )

            # Check if blob exists - expected_version is REQUIRED for updates
            file_exists = False
            try:
                file_exists = blob_client.exists()
            except Exception:
                # If we can't check existence, continue (will fail later if needed)
                pass

            if file_exists and expected_version is None:
                raise StorageError(f'Expected version is required when updating existing file: {filename}')

            # Prepare upload kwargs
            upload_kwargs = {'data': data.encode('utf-8'), 'overwrite': True}

            # If expected version provided, use conditional upload
            if expected_version is not None:
                upload_kwargs['etag'] = expected_version
                upload_kwargs['match_condition'] = 'IfMatch'

            blob_client.upload_blob(**upload_kwargs)

            # Get new ETag
            properties = blob_client.get_blob_properties()
            new_etag = properties.etag.strip('"')
            return new_etag

        except (ConnectionError, TimeoutError):
            raise
        except Exception as e:
            if 'ConditionNotMet' in str(e) or 'PreconditionFailed' in str(e):
                raise VersionMismatchError(
                    filename=filename,
                    expected_version=expected_version,
                ) from e
            raise StorageError(f'Failed to write file {filename} to Azure: {e}') from e

    @retry(
        stop=stop_after_attempt(STORE_MAX_RETRY_ATTEMPTS),
        wait=wait_exponential(multiplier=1, min=1),
        retry=retry_if_exception_type((ConnectionError, TimeoutError)),
        reraise=True,
    )
    async def delete_file(self, filename: str, expected_version: Optional[str] = None) -> None:
        """
        Delete file from Azure Blob with optional ETag check.

        Uses Azure's conditional delete with if-match for atomicity.
        """
        try:
            client = self._get_client()
            blob_name = self._get_blob_name(filename)

            blob_client = client.get_blob_client(
                container=self._container,
                blob=blob_name,
            )

            # Check if blob exists and get current ETag if needed
            try:
                properties = blob_client.get_blob_properties()
                current_etag = properties.etag.strip('"')

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
                if 'BlobNotFound' in str(e) or 'ResourceNotFound' in str(e):
                    raise StorageError(f'File not found: {filename}')
                raise

            # Delete the blob
            delete_kwargs = {}
            if expected_version is not None:
                delete_kwargs['etag'] = expected_version
                delete_kwargs['match_condition'] = 'IfMatch'

            blob_client.delete_blob(**delete_kwargs)

        except (ConnectionError, TimeoutError):
            raise
        except StorageError:
            raise
        except Exception as e:
            if 'ConditionNotMet' in str(e) or 'PreconditionFailed' in str(e):
                raise VersionMismatchError(
                    filename=filename,
                    expected_version=expected_version,
                ) from e
            raise StorageError(f'Failed to delete file {filename} from Azure: {e}') from e

    @retry(
        stop=stop_after_attempt(STORE_MAX_RETRY_ATTEMPTS),
        wait=wait_exponential(multiplier=1, min=1),
        retry=retry_if_exception_type((ConnectionError, TimeoutError)),
        reraise=True,
    )
    async def list_files(self, prefix: str = '') -> list:
        """
        List all blobs in Azure container with given prefix.
        """
        try:
            client = self._get_client()
            container_client = client.get_container_client(self._container)

            blob_prefix = self._get_blob_name(prefix) if prefix else self._prefix

            files = []
            blob_list = container_client.list_blobs(name_starts_with=blob_prefix)

            for blob in blob_list:
                blob_name = blob.name
                # Remove prefix to get relative path
                if self._prefix and blob_name.startswith(self._prefix + '/'):
                    relative_name = blob_name[len(self._prefix) + 1 :]
                elif self._prefix and blob_name.startswith(self._prefix):
                    relative_name = blob_name[len(self._prefix) :]
                else:
                    relative_name = blob_name
                files.append(relative_name)

            return sorted(files)

        except (ConnectionError, TimeoutError):
            raise
        except Exception as e:
            raise StorageError(f'Failed to list files with prefix {prefix} from Azure: {e}') from e

    # =========================================================================
    # Private Methods
    # =========================================================================

    def _get_client(self):
        """Get or create Azure Blob Service client."""
        if self._blob_service_client is None:
            try:
                from azure.storage.blob import BlobServiceClient

                if self._connection_string:
                    self._blob_service_client = BlobServiceClient.from_connection_string(self._connection_string)
                elif self._account_name and self._account_key:
                    from azure.core.credentials import AzureNamedKeyCredential

                    account_url = f'https://{self._account_name}.blob.core.windows.net'
                    credential = AzureNamedKeyCredential(self._account_name, self._account_key)
                    self._blob_service_client = BlobServiceClient(
                        account_url=account_url,
                        credential=credential,
                    )
                else:
                    raise StorageError('Azure credentials not provided')

            except ImportError:
                raise StorageError('Azure SDK not installed. Install with: pip install azure-storage-blob')
            except Exception as e:
                raise StorageError(f'Failed to create Azure client: {e}') from e

        return self._blob_service_client

    def _get_blob_name(self, path: str) -> str:
        """Convert relative path to blob name."""
        path = path.replace('\\', '/')
        if self._prefix:
            return f'{self._prefix}/{path}'
        return path
