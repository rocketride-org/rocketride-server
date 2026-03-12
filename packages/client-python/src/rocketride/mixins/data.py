# MIT License
#
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

"""
Data Operations and File Upload for RocketRide Client.

This module provides data handling capabilities including sending text data,
uploading files, and streaming data to RocketRide pipelines. Use these functions
to feed data into your pipelines for processing, analysis, and AI operations.

Key Features:
- Send text or binary data to running pipelines
- Upload files with progress tracking and parallel transfers
- Stream data using pipes for large datasets
- Support for various file formats and MIME types
- Automatic retry and error handling

Usage:
    # Send simple text data
    token = await client.use(filepath="text_processor.json")
    result = await client.send(token, "Process this text")

    # Upload multiple files
    files = ["document1.pdf", "data.csv", "image.png"]
    results = await client.send_files(files, token)

    # Stream large dataset
    pipe = await client.pipe(token, mimetype="text/csv")
    await pipe.open()
    await pipe.write(csv_chunk1)
    await pipe.write(csv_chunk2)
    final_result = await pipe.close()
"""

import os
import time
import asyncio
import mimetypes
from pathlib import Path
from typing import Dict, Any, List, Union, Tuple, Optional
from ..core import DAPClient
from ..types import PIPELINE_RESULT, UPLOAD_RESULT


class DataMixin(DAPClient):
    """
    Provides data operations for the RocketRide client.

    This mixin adds the ability to send data to running pipelines, upload files,
    and stream large datasets. It handles both simple data sending and complex
    multi-file uploads with progress tracking.

    Data operations work with pipeline tokens - you first start a pipeline with
    client.use(), then send data to it using the methods in this class.

    Key Capabilities:
    - Send text or binary data to pipelines
    - Upload single or multiple files with progress tracking
    - Stream data using pipes for large datasets
    - Automatic file type detection and MIME type handling
    - Parallel file transfers for better performance
    - Progress events for monitoring uploads

    This is automatically included when you use RocketRideClient, so you can
    call methods like client.send() and client.send_files() directly.
    """

    class DataPipe:
        """
        Streaming data pipe for sending large datasets to RocketRide pipelines.

        Use DataPipe when you need to send data in multiple chunks, stream
        large files, or have real-time data feeding requirements. Pipes provide
        more control than the simple send() method.

        The pipe works by:
        1. Opening a connection to the pipeline
        2. Writing data in chunks as needed
        3. Closing the pipe to get final results

        Example:
            # Stream CSV data in chunks
            pipe = await client.pipe(token, mimetype="text/csv")
            async with pipe:  # Automatically opens and closes
                for chunk in csv_chunks:
                    await pipe.write(chunk.encode())
            # Results available after pipe closes
        """

        def __init__(self, client, token: str, objinfo: Dict[str, Any] = None, mime_type: str = None, provider: str = None, on_sse=None):
            """
            Initialize a DataPipe bound to a pipeline token with optional metadata, MIME type, provider, and per-pipe SSE callback.
            
            Parameters:
            	client: The RocketRide client instance the pipe will use to send requests and manage subscriptions.
            	token (str): Pipeline token identifying the data destination.
            	objinfo (Dict[str, Any], optional): Object metadata to associate with the streamed data (e.g., name, size); defaults to an empty dict.
            	mime_type (str, optional): MIME type for the data stream (defaults to 'application/octet-stream' when not provided).
            	provider (str, optional): Optional provider identifier to route the upload.
            	on_sse (callable, optional): Optional asynchronous callback invoked for each SSE event from the pipeline; called as await on_sse(event_body: dict).
            """
            self._client = client
            self._token = token
            self._objinfo = objinfo or {}
            self._mime_type = mime_type or 'application/octet-stream'
            self._provider = provider
            self._pipe_id = None
            self._opened = False
            self._closed = False
            self._on_sse = on_sse

        @property
        def is_opened(self) -> bool:
            """Check if the pipe is currently open for writing."""
            return self._opened

        @property
        def pipe_id(self) -> Optional[int]:
            """Get the unique ID assigned to this pipe by the server."""
            return self._pipe_id

        async def open(self) -> 'DataMixin.DataPipe':
            """
            Open the pipe for data transmission.
            
            Requests the server to allocate a pipe, stores the assigned pipe ID, and marks this pipe as opened. If an `on_sse` callback was provided when the pipe was created, subscribes to server-sent events for this pipe and registers the callback.
            
            Returns:
                self: The opened pipe instance for method chaining.
            
            Raises:
                RuntimeError: If the pipe is already opened or if the server indicates opening failed.
            """
            if self._opened:
                raise RuntimeError('Pipe already opened')

            request = self._client.build_request(
                'rrext_process',
                arguments={
                    'subcommand': 'open',
                    'object': self._objinfo,
                    'mimeType': self._mime_type,
                    'provider': self._provider,
                },
                token=self._token,
            )

            response = await self._client.request(request)

            if self._client.did_fail(response):
                raise RuntimeError(response.get('message', 'Your pipeline is not currently running.'))

            self._pipe_id = response.get('body', {}).get('pipe_id')
            self._opened = True

            # If an SSE callback was provided, subscribe and register for this pipe
            if self._on_sse is not None and self._pipe_id is not None:
                await self._client.set_events(self._token, ['SSE'], pipe_id=self._pipe_id)
                self._client._register_sse_pipe(self._pipe_id, self._on_sse)

            return self

        async def write(self, buffer: bytes) -> None:
            """
            Write a bytes buffer to the open data pipe as a chunk.
            
            Can be called repeatedly to send multiple sequential chunks. The buffer must be raw bytes; encode text (for example using UTF-8) before calling.
            
            Parameters:
                buffer (bytes): Data to send; must be a bytes object (e.g., "text".encode("utf-8")).
            
            Raises:
                RuntimeError: If the pipe is not opened or the write operation fails.
                ValueError: If `buffer` is not a bytes object.
            """
            if not self._opened:
                raise RuntimeError('Pipe not opened')

            if not isinstance(buffer, bytes):
                raise ValueError('Buffer must be bytes')

            request = self._client.build_request(
                'rrext_process',
                arguments={
                    'subcommand': 'write',
                    'pipe_id': self._pipe_id,
                    'data': buffer,
                },
                token=self._token,
            )

            response = await self._client.request(request)

            if self._client.did_fail(response):
                raise RuntimeError(response.get('message', 'Failed to write to pipe'))

        async def close(self) -> PIPELINE_RESULT:
            """
            Close the pipe and get the processing results.

            Must be called after finishing data transmission to signal
            completion and retrieve the pipeline's output.

            Returns:
                Dict: Results from processing the data you sent

            Example:
                pipe = await client.pipe(token, mimetype="text/csv")
                await pipe.open()
                await pipe.write(csv_data.encode())
                results = await pipe.close()
                print(f"Processed {results['records_count']} records")
            """
            if not self._opened or self._closed:
                return {}

            try:
                request = self._client.build_request(
                    'rrext_process',
                    arguments={
                        'subcommand': 'close',
                        'pipe_id': self._pipe_id,
                    },
                    token=self._token,
                )

                response = await self._client.request(request)

                if self._client.did_fail(response):
                    raise RuntimeError(response.get('message', 'Failed to close pipe'))

                return response.get('body', {})

            finally:
                self._closed = True

                # Unregister SSE callback and scoped monitor subscription
                if self._on_sse is not None and self._pipe_id is not None:
                    self._client._unregister_sse_pipe(self._pipe_id)
                    try:
                        await self._client.set_events(self._token, [], pipe_id=self._pipe_id)
                    except Exception:
                        pass  # Best-effort cleanup

        async def __aenter__(self):
            """
            Enter the async context by opening the data pipe.
            
            Returns:
                DataPipe: the opened DataPipe instance (`self`).
            """
            return await self.open()

        async def __aexit__(self, exc_type, exc_val, exc_tb):
            """Exit async context manager - automatically closes pipe."""
            await self.close()

    def __init__(self, **kwargs):
        """Initialize data operations."""
        super().__init__(**kwargs)

    @staticmethod
    def _objinfo_with_size(objinfo: Dict[str, Any] = None, size: int = 0) -> Dict[str, Any]:
        """
        Ensure an objinfo dictionary contains a positive 'size' field.
        
        Parameters:
            objinfo (Dict[str, Any]): Original object metadata to copy into the result. If None, an empty dict is used.
            size (int): Desired size value; if less than or equal to 0, this function sets `'size'` to 1 to avoid an empty filter.
        
        Returns:
            Dict[str, Any]: A new dict with the contents of `objinfo` and a `'size'` key set to `size` when > 0, otherwise 1.
        """
        out = dict(objinfo) if objinfo else {}
        out['size'] = size if size else 1
        return out

    async def pipe(self, token: str, objinfo: Dict[str, Any] = None, mime_type: str = None, provider: str = None, on_sse=None) -> DataPipe:
        r"""
        Create a data pipe for streaming operations.

        Use pipes when you need to send data in multiple chunks, stream large
        files, or have real-time data feeding requirements. Pipes give you more
        control than the simple send() method.

        Args:
            token: Pipeline token to send data to
            objinfo: Optional metadata about your data (e.g., {"name": "my_data.csv"})
            mime_type: MIME type of your data (auto-detected if not provided)
            provider: Optional provider specification

        Returns:
            DataPipe: A pipe object for streaming data

        Example:
            # Basic pipe usage
            pipe = await client.pipe(token, mime_type="text/csv")
            await pipe.open()
            await pipe.write(csv_header.encode())
            for row in csv_rows:
                await pipe.write(f"{row}\n".encode())
            results = await pipe.close()

            # Using context manager (recommended)
            async with await client.pipe(token, mime_type="application/json") as pipe:
                await pipe.write(json.dumps(data1).encode())
                await pipe.write(json.dumps(data2).encode())
                results = await pipe.close()
            # Results available after context exits
        """
        return self.DataPipe(self, token=token, objinfo=objinfo, mime_type=mime_type, provider=provider, on_sse=on_sse)

    async def send(
        self,
        token: str,
        data: Union[str, bytes],
        objinfo: Dict[str, Any] = None,
        mimetype: str = None,
    ) -> PIPELINE_RESULT:
        """
        Send data to a running pipeline.

        This is the simple way to send data when you have all the data ready
        at once. For streaming or multiple chunks, use pipe() instead.

        The data is sent to the pipeline specified by the token, processed
        according to the pipeline's configuration, and results are returned.

        Args:
            token: Pipeline token (from client.use()) to send data to
            data: Your data as string or bytes to process
            objinfo: Optional metadata about the data (e.g., {"name": "data.txt"})
            mimetype: MIME type of the data (auto-detected if not specified)

        Returns:
            Dict: Results from processing your data

        Raises:
            ValueError: If data is not string or bytes
            RuntimeError: If sending fails

        Example:
            # Send text data
            token = await client.use(filepath="text_analyzer.json")
            result = await client.send(token, "Analyze this text for sentiment")
            print(f"Sentiment: {result['sentiment']}")

            # Send JSON data
            import json
            data = {"name": "John", "age": 30}
            result = await client.send(
                token,
                json.dumps(data),
                mimetype="application/json"
            )

            # Send binary data
            with open("data.bin", "rb") as f:
                binary_data = f.read()
            result = await client.send(token, binary_data, mimetype="application/octet-stream")
        """
        # Convert string to bytes if needed
        if isinstance(data, str):
            buffer = data.encode('utf-8')
        elif isinstance(data, bytes):
            buffer = data
        else:
            raise ValueError('data must be either a string or bytes')

        # Create and use a temporary pipe for the data
        pipe = await self.pipe(token, self._objinfo_with_size(objinfo, len(buffer)), mimetype)

        try:
            await pipe.open()
            await pipe.write(buffer)
            return await pipe.close()

        except Exception:
            # Clean up pipe on any error
            if pipe.is_opened:
                try:
                    await pipe.close()
                except Exception:
                    pass  # Ignore cleanup errors
            raise

    async def send_files(
        self,
        files: List[
            Union[
                str,
                Tuple[str, Optional[Dict[str, Any]]],
                Tuple[str, Optional[Dict[str, Any]], Optional[str]],
            ]
        ],
        token: str,
    ) -> UPLOAD_RESULT:
        """
        Upload multiple files to a pipeline with progress tracking.

        Efficiently uploads files using parallel transfers with automatic
        progress events. Files are processed concurrently for better performance.

        Each file can be specified as:
        - Just a file path: "/path/to/file.pdf"
        - File path with metadata: ("/path/to/file.pdf", {"category": "document"})
        - File path with metadata and MIME type: ("/path/to/file.pdf", {"name": "doc"}, "application/pdf")

        Args:
            files: List of files to upload (see formats above)
            token: Pipeline token to upload files to

        Returns:
            List[Dict]: Upload results for each file with status, timing, and processing results

        Raises:
            ValueError: If files list is empty, file paths invalid, or token missing
            FileNotFoundError: If any specified file doesn't exist
            RuntimeError: If API key is not configured

        Example:
            # Simple file upload
            files = [
                "document1.pdf",
                "data.csv",
                "report.docx"
            ]
            results = await client.send_files(files, token)

            for result in results:
                if result['action'] == 'complete':
                    print(f"✓ Uploaded {result['filepath']} in {result['upload_time']:.2f}s")
                else:
                    print(f"✗ Failed {result['filepath']}: {result['error']}")

            # Upload with metadata
            files = [
                ("financial_report.pdf", {"department": "finance", "year": 2024}),
                ("sales_data.csv", {"type": "quarterly_data"}, "text/csv")
            ]
            results = await client.send_files(files, token)

        Progress Events:
            If you've configured event handling, you'll receive progress events:
            - 'open': File upload starting
            - 'write': Data being transferred (with bytes sent/total)
            - 'close': File upload completing
            - 'complete': File successfully processed
            - 'error': Upload or processing failed

        Tips for Large Uploads:
            - Use specific MIME types for better processing
            - Add descriptive metadata to help with organization
            - Monitor progress events for user feedback
            - Server handles queuing automatically - all files uploaded in parallel
        """
        # Fixed chunk size for optimal performance
        chunk_size = 1024 * 1024  # 1MB

        # Validate inputs
        if not files:
            raise ValueError('Files list cannot be empty')

        if not token or not isinstance(token, str):
            raise ValueError('Token must be a non-empty string')

        if not self._apikey:
            raise RuntimeError('API key is required for file uploads')

        # Normalize file entries to (filepath, objinfo, mimetype) tuples
        normalized_files = []
        for entry in files:
            if isinstance(entry, str):
                # Just filepath - auto-detect MIME type and use filename
                filepath = entry
                filename = Path(filepath).name
                objinfo = {'name': filename}
                mimetype = mimetypes.guess_type(filepath)[0] or 'application/octet-stream'
            elif isinstance(entry, tuple):
                if len(entry) == 2:
                    # (filepath, objinfo)
                    filepath, objinfo = entry
                    if objinfo is None:
                        filename = Path(filepath).name
                        objinfo = {'name': filename}
                    mimetype = mimetypes.guess_type(filepath)[0] or 'application/octet-stream'
                elif len(entry) == 3:
                    # (filepath, objinfo, mimetype)
                    filepath, objinfo, mimetype = entry
                    if objinfo is None:
                        filename = Path(filepath).name
                        objinfo = {'name': filename}
                    if mimetype is None:
                        mimetype = mimetypes.guess_type(filepath)[0] or 'application/octet-stream'
                else:
                    raise ValueError(f'Invalid tuple length for entry: {entry}')
            else:
                raise ValueError(f'Invalid file entry type: {type(entry)}')

            # Validate file exists
            if not os.path.isfile(filepath):
                raise ValueError(f'File not found: {filepath}')

            normalized_files.append((filepath, objinfo, mimetype))

        results = [None] * len(normalized_files)

        async def send_upload_event(body: Dict[str, Any]) -> None:
            """Send upload progress event through the event system."""
            try:
                event_message = {
                    'event': 'apaevt_status_upload',
                    'body': body,
                    'seq': 0,
                    'type': 'event',
                }

                if self._caller_on_event:
                    await self._caller_on_event(event_message)

            except Exception as e:
                self.debug_message(f'Error sending upload event: {e}')

        async def upload_file(index: int, filepath: str, objinfo: Dict[str, Any], mimetype: str) -> None:
            """
            Upload a single file - straightforward linear process:
            1. Wait for pipe to become available (server handles queuing)
            2. Transfer data
            3. Close pipe
            4. Send status update
            """
            start_time = time.time()
            bytes_sent = 0
            pipe = None
            file_exception = None
            close_result = None

            try:
                # Get file size for progress tracking
                file_size = os.path.getsize(filepath)

                # Step 1: Create and open pipe (waits for server to allocate)
                pipe = await self.pipe(token, self._objinfo_with_size(objinfo, file_size), mimetype)
                self.debug_message(f'Opening pipe for {filepath}')
                await pipe.open()
                self.debug_message(f'Pipe {pipe.pipe_id} opened for {filepath}')

                # Step 2: Send status update AFTER we have the pipe
                await send_upload_event(
                    {
                        'action': 'open',
                        'filepath': filepath,
                        'file_size': file_size,
                    }
                )

                # Step 3: Transfer data in chunks
                with open(filepath, 'rb') as f:
                    while True:
                        chunk = f.read(chunk_size)
                        if not chunk:
                            break

                        await pipe.write(chunk)
                        bytes_sent += len(chunk)

                        # Send progress event
                        await send_upload_event(
                            {
                                'action': 'write',
                                'filepath': filepath,
                                'bytes_sent': bytes_sent,
                                'file_size': file_size,
                            }
                        )

                # Step 4: Close pipe and get result
                await send_upload_event(
                    {
                        'action': 'close',
                        'filepath': filepath,
                        'bytes_sent': bytes_sent,
                        'file_size': file_size,
                    }
                )

                close_result = await pipe.close()
                self.debug_message(f'Pipe {pipe.pipe_id} closed for {filepath}')

            except Exception as e:
                file_exception = e
                self.debug_message(f'Error uploading {filepath}: {e}')

            # Calculate upload time
            upload_time = time.time() - start_time

            # Send final status
            event_body = {
                'action': 'complete' if file_exception is None else 'error',
                'filepath': filepath,
                'bytes_sent': bytes_sent,
                'file_size': os.path.getsize(filepath) if os.path.exists(filepath) else 0,
                'upload_time': upload_time,
                'result': close_result,
            }

            if file_exception is not None:
                event_body['error'] = str(file_exception)

            try:
                await send_upload_event(event_body)
            except Exception:
                pass

            results[index] = event_body

            # Log completion
            if file_exception:
                self.debug_message(f'Upload failed: {filepath} ({bytes_sent} bytes): {file_exception}')
            else:
                self.debug_message(f'Upload completed: {filepath} ({bytes_sent} bytes, {upload_time:.2f}s)')

        # Create a coroutine for every file - let server handle queuing
        self.debug_message(f'Starting upload of {len(normalized_files)} files (token={token})')

        upload_tasks = [upload_file(index, filepath, objinfo, mimetype) for index, (filepath, objinfo, mimetype) in enumerate(normalized_files)]

        # Wait for all uploads to complete
        await asyncio.gather(*upload_tasks, return_exceptions=True)

        # Log summary
        successful_uploads = sum(1 for r in results if r and r.get('action') == 'complete')
        failed_uploads = len(results) - successful_uploads
        total_bytes = sum(r.get('bytes_sent', 0) for r in results if r and r.get('action') == 'complete')

        self.debug_message(f'Upload completed: {successful_uploads} successful, {failed_uploads} failed, {total_bytes} total bytes transferred (token={token})')

        return results
