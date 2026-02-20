import asyncio
import re
import uuid
from typing import Dict, List, Union, Optional, Coroutine
from pydantic import BaseModel
from rocketlib import Entry, getObject
from ai.constants import CONST_HTTP_CHUNK_SIZE
from ai.web import WebServer, exception, response, Request, Query, Header, formatException
from fastapi.responses import Response
from starlette.datastructures import UploadFile
from rocketride import RocketRideClient


class DataResult(BaseModel):
    """
    Holds the data for tracking the number of objects requested, completed, and the status of each object.
    """

    objectsRequested: int = 0  # Tracks how many objects have been requested
    objectsCompleted: int = 0  # Tracks how many objects have been successfully processed
    resultTypes: Dict = {}
    objects: Dict[str, Optional[Dict]] = {}  # Dictionary mapping unique field names to pipe results


class RequestProcessing:
    """
    Processes incoming FastAPI requests and routes them through RocketRideClient.

    This class handles multipart form uploads and raw body streams by sending data directly
    through standalone pipes without temporary files or memory buffering.
    """

    def __init__(self, client: RocketRideClient, token: str):
        """
        Initialize the RequestProcessing instance.

        Args:
            client: Connected RocketRideClient instance for processing data
            token: Token for data pipe operations
        """
        self._client = client
        self._token = token

    async def _send_stream(self, request: Request, unique_key: str = 'body') -> tuple[str, Union[Dict, Exception], Entry]:
        """
        Send request stream directly through RocketRideClient.

        Args:
            request: The HTTP request containing the stream
            unique_key: Unique key for tracking this item

        Returns:
            tuple: (unique_key, result, obj) where unique_key is for mapping, result is processing result, obj is Entry
        """
        # Get metadata from headers
        mime_type = request.headers.get('Content-Type', 'application/octet-stream').split(';')[0].strip().lower()

        # Try to get filename from Content-Disposition header
        filename = None
        content_disposition = request.headers.get('Content-Disposition', '')
        if content_disposition:
            filename_match = re.search(r'filename[*]?=([^;]+)', content_disposition)
            if filename_match:
                filename = filename_match.group(1).strip('"\'')

        # Fallback filename
        if not filename:
            filename = f'stream-{str(uuid.uuid4())}'

        # Generate an object for tracking
        obj = getObject(filename)

        try:
            # Get content length if available
            content_length = request.headers.get('Content-Length')
            if content_length:
                try:
                    obj.size = int(content_length)
                    obj.storeSize = obj.size
                except ValueError:
                    pass

            # Create object metadata
            obj_metadata = {
                'name': filename,
                'objectId': obj.objectId,
                'size': getattr(obj, 'size', None),
            }

            self._client.debug_message(f'Starting stream for {filename} with MIME type: {mime_type}')

            # Allocate a pipe with context manager
            async with await self._client.pipe(self._token, obj_metadata, mime_type) as pipe:
                self._client.debug_message(f'Opened pipe {pipe.pipe_id} for stream {filename}')

                # Stream the request body directly through the pipe
                total_bytes = 0
                async for chunk in request.stream():
                    if chunk:
                        total_bytes += len(chunk)
                        await pipe.write(chunk)

                # Update object size if we didn't have it before
                if not hasattr(obj, 'size') or obj.size is None:
                    obj.size = total_bytes
                    obj.storeSize = total_bytes

                # Get result before context manager closes
                results = await pipe.close()

                self._client.debug_message(f'Successfully streamed {total_bytes} bytes for {filename} through pipe {pipe.pipe_id}')

                return (unique_key, results, obj)

        except Exception as e:
            self._client.debug_message(f'Error streaming {filename}: {str(e)}')
            return (unique_key, e, obj)

    async def _send_file(self, file: UploadFile, unique_key: str = '') -> tuple[str, Union[Dict, Exception], Entry]:
        """
        Send file content through RocketRideClient.

        Args:
            file: UploadFile to send
            unique_key: Unique key for tracking this item

        Returns:
            tuple: (unique_key, result, obj) where unique_key is for mapping, result is processing result, obj is Entry
        """
        # Generate an object for tracking
        filename = file.filename or f'upload_{str(uuid.uuid4())}'
        obj = getObject(filename)

        try:
            # Get MIME type and setup metadata
            mime_type = file.content_type or 'application/octet-stream'
            mime_type = mime_type.split(';')[0].strip().lower()  # Normalize MIME type

            # Create object metadata
            obj_metadata = {
                'name': filename,
                'objectId': obj.objectId,
                'size': getattr(file, 'size', None),  # Size if available
            }

            self._client.debug_message(f'Starting streaming upload for {filename} with MIME type: {mime_type}')

            # Allocate a pipe
            async with await self._client.pipe(self._token, obj_metadata, mime_type) as pipe:
                self._client.debug_message(f'Opened pipe {pipe.pipe_id} for file {filename}')

                # Stream the file content directly through the pipe
                chunk_size = CONST_HTTP_CHUNK_SIZE
                total_bytes = 0

                while True:
                    chunk = await file.read(chunk_size)
                    if not chunk:
                        break

                    total_bytes += len(chunk)

                    # Write chunk directly to pipe (no intermediate storage)
                    await pipe.write(chunk)

                # Get result before context manager closes
                results = await pipe.close()

                # Output a message
                self._client.debug_message(f'Successfully streamed {total_bytes} bytes for file {filename} through pipe {pipe.pipe_id}')

                return (unique_key, results, obj)

        except Exception as e:
            self._client.debug_message(f'Error streaming file {filename}: {str(e)}')
            return (unique_key, e, obj)

    async def _send_bytes(self, content: bytes, mime_type: str = 'text/plain', filename: Optional[str] = None, unique_key: str = '') -> tuple[str, Union[Dict, Exception], Entry]:
        """
        Send bytes content through RocketRideClient.

        Args:
            content: Bytes content to send
            mime_type: MIME type for the content
            filename: Optional filename, generates UUID-based name if not provided
            unique_key: Unique key for tracking this item

        Returns:
            tuple: (unique_key, result, obj) where unique_key is for mapping, result is processing result, obj is Entry
        """
        # Generate filename if not provided
        if filename is None:
            filename = f'content-{str(uuid.uuid4())}'

        # Generate an object for tracking
        obj = getObject(filename=filename)

        try:
            # Update object metadata
            obj.size = len(content)
            obj.storeSize = obj.size

            # Allocate a pipe
            async with await self._client.pipe(self._token, obj.toDict(), mime_type) as pipe:
                self._client.debug_message(f'Opened pipe {pipe.pipe_id} for content "{filename}" with MIME type: {mime_type}')

                # Write the content to pipe
                await pipe.write(content)

                # Get result before context manager closes
                results = await pipe.close()

                self._client.debug_message(f'Successfully processed content "{filename}" through pipe {pipe.pipe_id}')

                return (unique_key, results, obj)

        except Exception as e:
            self._client.debug_message(f'Error processing content "{filename}": {str(e)}')
            return (unique_key, e, obj)

    def _getMimeType(self, mimeType: str) -> str:
        """
        Extract and normalize the MIME type from a given raw MIME type string.

        Args:
            mimeType (str): The raw MIME type, which may include additional parameters.

        Returns:
            str: The normalized MIME type without any additional parameters.
        """
        return mimeType.split(';')[0].strip().lower()

    def _getMimeRequestType(self, request: Request) -> str:
        """
        Extract and normalize the MIME type from the request headers.

        Args:
            request: The FastAPI request object

        Returns:
            str: The normalized MIME type
        """
        mimeType = request.headers.get('Content-Type', 'application/octet-stream')
        return self._getMimeType(mimeType)

    def _processSingleResult(self, result: Union[Dict, Exception], obj: Entry, dataResults: DataResult, unique_key: str):
        """
        Process the result of a single upload.

        Args:
            result: The processing result
            obj: The RocketRide object
            dataResults: The data results to update
            unique_key: The unique key for this item
        """
        if isinstance(result, Exception):
            # For failed uploads, add formatted exception to results dict
            dataResults.objects[unique_key] = formatException(result).model_dump()
        else:
            # Get the data returned (it was in binary)
            # Handle types if present
            result_types = result.pop('result_types', None)
            if result_types:
                for type_key in result_types:
                    dataResults.resultTypes[type_key] = result_types[type_key]

            # Say it was ok
            result['status'] = 'OK'

            # Put the pipe result directly in results dict with unique key
            dataResults.objects[unique_key] = result
            dataResults.objectsCompleted += 1

    async def _processMultipart(self, request: Request) -> DataResult:
        """
        Process all form data fields using concurrent streaming, handling both files and strings.

        Args:
            request: The incoming HTTP request containing form data

        Returns:
            DataResult: Results of the processing operations with unique key mapping
        """
        self._client.debug_message('Processing multipart form data')
        dataResults = DataResult()

        try:
            # Extract form data from the request
            formData = await request.form()

            # Get all form items in exact submission order using multi_items()
            # This preserves the original order including duplicate keys
            all_items = list(formData.multi_items())

            if not all_items:
                self._client.debug_message('No form data found')
                return dataResults

            # Extract just the keys to count duplicates
            all_keys = [key for key, value in all_items]

            # First pass: count occurrences of each key
            key_counts = {}
            for key in all_keys:
                key_counts[key] = key_counts.get(key, 0) + 1

            # Second pass: create unique keys and form items in submission order
            key_counters = {}  # Track current counter for each key
            form_items = []

            for key, value in all_items:
                # Determine unique key based on whether this key appears multiple times
                if key_counts[key] > 1:
                    # Key appears multiple times, use counter
                    if key not in key_counters:
                        key_counters[key] = 0
                    else:
                        key_counters[key] += 1
                    unique_key = f'{key}_{key_counters[key]}'
                else:
                    # Key is unique, use as-is
                    unique_key = key

                if isinstance(value, UploadFile):  # It's a file upload
                    form_items.append(('file', unique_key, value))
                else:  # It's a string value
                    form_items.append(('string', unique_key, str(value)))

            # Track the requests
            dataResults.objectsRequested = len(form_items)

            self._client.debug_message(f'Starting concurrent streaming for {len(form_items)} form fields')

            # Create coroutines for concurrent processing
            send_coroutines: List[Coroutine] = []
            for item_type, unique_key, value in form_items:
                if item_type == 'file':
                    coro = self._send_file(value, unique_key)
                else:  # item_type == 'string'
                    # Use the unique key as part of the filename for better identification
                    filename = f'{unique_key}-{str(uuid.uuid4())}'
                    content_bytes = str(value).encode('utf-8')
                    coro = self._send_bytes(content_bytes, 'text/plain', filename, unique_key)

                send_coroutines.append(coro)

            # Execute all coroutines concurrently
            keyed_results = await asyncio.gather(*send_coroutines, return_exceptions=False)

            # Process results
            for unique_key, result, obj in keyed_results:
                self._processSingleResult(result, obj, dataResults, unique_key)

            self._client.debug_message(f'Completed concurrent streaming for {len(form_items)} form fields')

        except Exception as e:
            self._client.debug_message(f'Error in concurrent streaming form processing: {e}')
            raise e

        return dataResults

    async def _processSingle(self, request: Request) -> DataResult:
        """
        Process a single request by streaming the body directly to pipe.

        Args:
            request: The HTTP request containing the data to process

        Returns:
            DataResult: Results of the processing operation
        """
        self._client.debug_message('Processing single request - streaming body to pipe')
        dataResults = DataResult()
        dataResults.objectsRequested = 1

        try:
            unique_key, result, obj = await self._send_stream(request, 'body')
            self._processSingleResult(result, obj, dataResults, unique_key)
        except Exception as e:
            obj = getObject(filename=f'error-{str(uuid.uuid4())}')
            self._processSingleResult(e, obj, dataResults, 'error')

        return dataResults

    async def process(self, request: Request) -> Union[response, Dict]:
        """
        Process an incoming request by routing it through RocketRideClient using streaming.

        Two simple paths:
        1. Multipart form data -> process form fields
        2. Everything else -> stream request body directly to pipe

        Args:
            request: The FastAPI request containing the data to process

        Returns:
            Union[response, Dict]: The response containing processing results with unique key mapping
        """
        try:
            # Get the MIME type from the request to determine processing method
            mimeType = self._getMimeRequestType(request)

            self._client.debug_message(f'Processing request with MIME type: {mimeType} using token: "{self._token}"')

            # Simple routing logic: multipart form or raw stream
            if mimeType == 'multipart/form-data':
                self._client.debug_message('Routing to multipart form data processing')
                results = await self._processMultipart(request)
            else:
                self._client.debug_message('Routing to single request processing')
                results = await self._processSingle(request)

            return response(results.model_dump())

        except Exception as e:
            self._client.debug_message(f'Error in request processing: {e}')
            return exception(e)


async def task_Data(
    request: Request,
    token: Optional[str] = Query(None, description='Token returned from task execute'),
    authorization: str = Header(..., description='Bearer API key in the Authorization header'),
) -> Response:
    r"""
    Process data uploads through RocketRide pipelines.

    This endpoint handles two types of uploads:
    1. Multipart form data with files and text fields
    2. Raw request body streams (PUT/POST with direct content)

    Args:
        request (Request): The FastAPI request object
        token (str): Task token from pipeline execution
        authorization (str): Bearer token in Authorization header

    Example Usage:
        # Multipart form upload
        curl -X POST "http://localhost:8000/task/data?token=task-123" \
             -H "Authorization: Bearer your-api-key" \
             -F "file=@document.pdf" \
             -F "question=What is this about?"

        # Raw stream upload (PUT or POST)
        curl -X PUT "http://localhost:8000/task/data?token=task-123" \
             -H "Authorization: Bearer your-api-key" \
             -H "Content-Type: application/pdf" \
             -H "Content-Disposition: attachment; filename=document.pdf" \
             --data-binary @document.pdf

        # Text stream upload
        curl -X POST "http://localhost:8000/task/data?token=task-123" \
             -H "Authorization: Bearer your-api-key" \
             -H "Content-Type: text/plain" \
             -d "Some text content"
    """
    client = None

    try:
        # Get the WebServer instance from application state
        server: WebServer = request.app.state.server
        port = server.get_port()

        # Create RocketRideClient instance for data streaming operations
        client = RocketRideClient(
            uri=f'http://localhost:{port}',
            auth=request.state.account.auth,
        )

        # Establish connection to the RocketRide service
        await client.connect()

        # Create request processor
        process = RequestProcessing(client, token)

        # Process it
        result = await process.process(request)
        return result

    except Exception as e:
        # Handle any unexpected errors during processing
        return exception(e)

    finally:
        # Always disconnect the client to clean up resources
        if client:
            await client.disconnect()


async def task_Process(
    request: Request,
    token: Optional[str] = Query(None, description='Token returned from task execute'),
    authorization: str = Header(..., description='Bearer API key in the Authorization header'),
) -> DataResult:
    r"""
    Process data uploads through RocketRide pipelines.

    DEPRECATED - Use /task/data.
    """
    return await task_Data(request=request, token=token, authorization=authorization)
