"""
DataConnection: DAP-based data pipeline connection handler.

This module implements a DAP connection handler for data pipeline operations.
It extends DAPConn to provide data-specific command handling and pipeline
integration while maintaining the standard DAP protocol interface.

Primary Responsibilities:
--------------------------
1. Handle DAP commands for data pipeline operations
2. Route commands to appropriate data server operations
3. Manage connection lifecycle for data clients
4. Provide authentication and token-based operation correlation
5. Handle data-specific extended commands
6. Monitor and forward data operation events

The connection serves as a bridge between DAP clients and backend data
processing operations, enabling remote data pipeline control and monitoring.
"""

import asyncio
import json
import time
from dataclasses import dataclass, field
from typing import Dict, Any, TYPE_CHECKING
from ai.constants import CONST_DATA_PIPE_TIMEOUT, CONST_DATA_SHUTDOWN_TIMEOUT
from ai.common.dap import DAPConn
from ai.common.schema import Question, Doc, Answer
from rocketlib import IServiceEndpoint, IServiceFilterPipe, getObject, Entry, AVI_ACTION, monitorCompleted, monitorFailed

# Only import for type checking to avoid circular import errors
if TYPE_CHECKING:
    from .data_server import DataServer


@dataclass
class DataConnPipe:
    """
    DataConnPipe represents a data processing pipe within a DataConnection.

    This dataclass holds the pipe instance and its associated MIME type,
    allowing for efficient management of active data streams in the connection.
    It is used to track open pipes and their configurations for data operations.
    """

    pipe_id: int = None
    pipe: IServiceFilterPipe = None
    mime_type: str = None
    lane: str = None
    is_open: bool = False
    has_failed: bool = False
    size: int = None
    written: int = 0
    entry: Entry = None
    semaphore_acquired: bool = False  # Track if semaphore was acquired for this pipe
    created_time: float = field(default_factory=time.time)  # Track when pipe was created
    last_activity_time: float = field(default_factory=time.time)  # Track last write/close activity


class DataConn(DAPConn):
    """
    DataConnection handles DAP commands for data pipeline operations.

    This connection extends the standard DAP protocol to support data pipeline
    specific operations including operation management, authentication, and extended
    commands for data processing workflows.

    Key Features:
    - Token-based authentication and operation correlation
    - Command routing to backend data processing operations
    - Extended DAP command support for data operations
    - Integration with data server operation management
    - Event monitoring and forwarding capabilities
    - Standard DAP protocol compliance
    - Async semaphore-controlled pipe allocation to limit concurrent operations
    - Zombie pipe detection (60-second inactivity timeout with activity reset)

    The connection acts as a proxy between DAP clients and data processing
    backends, enabling remote control and monitoring of data pipelines
    through the familiar DAP interface.
    """

    def __init__(self, server: 'DataServer', target: IServiceEndpoint, **kwargs) -> None:
        """
        Initialize a new DataConnection instance.

        Sets up the connection with the data server and target endpoint, initializes
        pipe mapping for tracking active data streams, and prepares the connection
        for handling DAP commands related to data pipeline operations.

        Args:
            server (DataServer): The data server managing operations and monitors.
                                Used for operation lifecycle management and coordination.
            target (IServiceEndpoint): The target endpoint for this connection.
                                      Provides access to data processing pipes.
            **kwargs: Additional arguments passed to parent DAPConn constructor.
                     May include transport, logging, and other DAP-specific settings.
        """
        # Create connection name for logging and identification
        # This helps distinguish data connections in logs from other DAP connections
        module_name = 'DATA'

        # Get the specified thread count
        self._thread_count = target.taskConfig.get('threadCount', 4)

        # Initialize parent DAPConn with transport and module identification
        # Note: transport should be passed via kwargs or created here
        super().__init__(module=module_name, **kwargs)

        # Store server reference for operation management
        # The server provides access to operation lifecycle, monitoring, and coordination
        self._server = server

        # Store target endpoint for pipe management
        # The endpoint provides access to data processing pipes and their lifecycle
        self._target = target

        # Mapping a pipe id to its DataConnPipe instance for tracking active data streams
        # This allows us to correlate DAP commands with specific pipe instances and their metadata
        # Key: pipe_id (int), Value: DataConnPipe instance
        self._pipe_map: Dict[int, DataConnPipe] = {}

        # Use asyncio.Semaphore for non-blocking semaphore operations
        # This prevents thread pool starvation while still limiting concurrent pipes
        self._pipe_sem = asyncio.Semaphore(self._thread_count)

        # Pipe timeout for zombie detection
        self._pipe_timeout = CONST_DATA_PIPE_TIMEOUT

        # Connection shutdown event
        self._shutdown_event = asyncio.Event()

        # Start cleanup task for zombie pipes
        self._monitor_task = asyncio.create_task(self._monitor_pipes())

        # Log initialization for debugging and monitoring
        self.debug_message(f'Initializing data connection with max {self._thread_count} concurrent pipes and {self._pipe_timeout}s zombie timeout...')

    async def disconnect(self):
        """
        Disconnect and clean up all resources.

        This method stops all background tasks and cleans up pipes.
        """
        # Signal shutdown to monitoring task
        self._shutdown_event.set()

        # Wait for monitoring task to complete
        if self._monitor_task and not self._monitor_task.done():
            await self._monitor_task

        # Clean up any remaining pipes
        for pipe_id in list(self._pipe_map.keys()):
            self.debug_message(f'Cleaning up remaining pipe {pipe_id} during disconnect')
            conn_pipe = self._pipe_map.pop(pipe_id, None)
            if conn_pipe:
                conn_pipe.has_failed = True  # Mark as failed for monitoring
                await asyncio.to_thread(self._cleanup_pipe, conn_pipe)

                # Release semaphore for remaining pipe if it was acquired
                if conn_pipe.semaphore_acquired:
                    self._pipe_sem.release()
                    self.debug_message(f'Released semaphore for remaining pipe {pipe_id}')

    def _determine_lane(self, mime_type: str, pipe_instance: IServiceFilterPipe) -> str:
        """
        Determine the appropriate data lane based on MIME type and available listeners.

        Args:
            mime_type: MIME type of the content. Can be a standard MIME type or
                      a special 'lane/*' format to directly target a specific lane
                      (e.g., 'lane/text', 'lane/questions', 'lane/documents').
            pipe_instance: The pipe instance to check for available listeners
        """
        # Direct lane specification: 'lane/{lane_name}' bypasses MIME type detection
        # This allows callers to directly target a specific lane (useful for testing)
        if mime_type.startswith('lane/'):
            return mime_type[5:]  # Extract lane name after 'lane/'

        # Get the listeners on this pipe
        listeners = pipe_instance.getListeners()

        # If this is rocketlib tag data, we can send it out directly on the tag lane
        if mime_type == 'application/rocketlib-tag':
            return 'tag'

        # If this is question and we have a question listener
        elif mime_type.startswith('application/rocketride-question') and 'questions' in listeners:
            return 'questions'

        # If this is text content and we have a text listener
        elif mime_type.startswith('text/') and 'text' in listeners:
            return 'text'

        # If this is image content and we have an image listener
        elif mime_type.startswith('image/') and 'image' in listeners:
            return 'image'

        # If this is video content and we have a video listener
        elif mime_type.startswith('video/') and 'video' in listeners:
            return 'video'

        # If this is audio content and we have an audio listener
        elif mime_type.startswith('audio/') and 'audio' in listeners:
            return 'audio'

        # It is either an unrecognized type or no listener is available, so we
        # send it to the data lane - which requires us to encode it in tagged format
        # and output it to the data lane
        else:
            return 'raw'

    def _begin(self, pipe_conn: DataConnPipe):
        """
        Begin the pipe data transfer.
        """
        pipe = pipe_conn.pipe
        lane = pipe_conn.lane
        mime_type = pipe_conn.mime_type

        # Handle different lane types with appropriate initialization
        # Each lane type requires specific setup for data streaming
        if lane == 'audio':
            # Initialize audio stream with BEGIN action and MIME type
            # MIME type determines audio format handling
            pipe.writeAudio(AVI_ACTION.BEGIN, mime_type)
        elif lane == 'video':
            # Initialize video stream with BEGIN action and MIME type
            # MIME type determines video format handling
            pipe.writeVideo(AVI_ACTION.BEGIN, mime_type)
        elif lane == 'image':
            # Initialize image stream with BEGIN action and MIME type
            # MIME type determines image format handling
            pipe.writeImage(AVI_ACTION.BEGIN, mime_type)
        elif lane == 'raw':
            # Initialize data stream with structured tags
            # Begin object and stream tags for structured data processing
            pipe.writeTagBeginObject()
            pipe.writeTagBeginStream()
        else:
            # Other lanes don't need framing
            pass

    def _end(self, pipe_conn: DataConnPipe):
        """
        End the pipe data transfer.
        """
        pipe = pipe_conn.pipe
        lane = pipe_conn.lane
        mime_type = pipe_conn.mime_type

        # Handle different lane types with appropriate finalization
        # Each lane type requires specific cleanup and finalization
        if lane == 'audio':
            # Finalize audio stream with END action and MIME type
            # This completes audio processing for this pipe
            pipe.writeAudio(AVI_ACTION.END, mime_type)

        elif lane == 'video':
            # Finalize video stream with END action and MIME type
            # This completes video processing for this pipe
            pipe.writeVideo(AVI_ACTION.END, mime_type)

        elif lane == 'image':
            # Finalize image stream with END action and MIME type
            # This completes image processing for this pipe
            pipe.writeImage(AVI_ACTION.END, mime_type)

        elif lane == 'raw':
            # Finalize data stream with structured end tags
            # Close stream and object tags for structured data
            pipe.writeTagEndStream()
            pipe.writeTagEndObject()

        else:
            # Other lanes don't need framing
            pass

    def _cleanup_pipe(self, conn_pipe: DataConnPipe) -> None:
        """
        Execute synchronous pipe cleanup (runs in thread, no async semaphore operations).

        This method handles the complete cleanup of a pipe including:
        1. Monitoring metrics reporting
        2. Returning the pipe to the endpoint

        Note: Semaphore release is handled by the caller in async context.

        Args:
            conn_pipe: The DataConnPipe instance to clean up
        """
        try:
            # Figure out if the size was specified, or we use the written size
            if conn_pipe.size is not None:
                size = conn_pipe.size
            else:
                size = conn_pipe.written

            # Signal monitoring
            if conn_pipe.has_failed:
                monitorFailed(size)
            else:
                monitorCompleted(size)

            # Return pipe to the endpoint for reuse
            if conn_pipe.pipe:
                self._target.putPipe(conn_pipe.pipe)
                self.debug_message(f'Returned pipe {conn_pipe.pipe_id} to endpoint')

            # Release the entry
            if conn_pipe.entry:
                conn_pipe.entry = None

        except Exception as e:
            # Log cleanup errors but don't re-raise to avoid masking original errors
            self.debug_message(f'Error during pipe cleanup for pipe {conn_pipe.pipe_id}: {e}')

    def _reset_pipe_activity(self, conn_pipe: DataConnPipe) -> None:
        """
        Reset the activity timer for a pipe when it's being used.

        This is called during write and close operations to prevent
        the pipe from being considered a zombie.

        Args:
            conn_pipe: The DataConnPipe instance to reset activity for
        """
        conn_pipe.last_activity_time = time.time()
        self.debug_message(f'Reset activity timer for pipe {conn_pipe.pipe_id}')

    async def _monitor_pipes(self):
        """
        Background task to clean up zombie pipes that haven't been used in 60 seconds.

        This prevents semaphore leaks when clients don't call close() and
        also handles zombie pipes that are opened but never used.
        A pipe is considered a zombie if it hasn't had any write or close activity
        for 60 seconds since its last activity.
        """
        while not self._shutdown_event.is_set():
            try:
                # Wait for shutdown event or timeout
                await asyncio.wait_for(self._shutdown_event.wait(), timeout=CONST_DATA_SHUTDOWN_TIMEOUT)
                if self._shutdown_event.is_set():
                    break
            except asyncio.TimeoutError:
                # Normal timeout, continue monitoring
                pass

            try:
                current_time = time.time()
                zombie_pipes = []

                # Find pipes that haven't been used in the timeout period
                for pipe_id, conn_pipe in list(self._pipe_map.items()):
                    time_since_last_activity = current_time - conn_pipe.last_activity_time

                    if time_since_last_activity > self._pipe_timeout:
                        zombie_pipes.append((pipe_id, time_since_last_activity))

                # Clean up zombie pipes
                for pipe_id, inactive_time in zombie_pipes:
                    self.debug_message(f'Cleaning up zombie pipe {pipe_id} after {inactive_time:.1f}s of inactivity (timeout: {self._pipe_timeout}s)')
                    conn_pipe = self._pipe_map.pop(pipe_id, None)
                    if conn_pipe:
                        conn_pipe.has_failed = True  # Mark as failed for monitoring
                        await asyncio.to_thread(self._cleanup_pipe, conn_pipe)

                        # Release semaphore for zombie pipe if it was acquired
                        if conn_pipe.semaphore_acquired:
                            self._pipe_sem.release()
                            self.debug_message(f'Released semaphore for zombie pipe {pipe_id}')

                # Log monitoring status if we have active pipes
                if self._pipe_map:
                    active_count = len(self._pipe_map)
                    self.debug_message(f'Pipe monitor: {active_count} active pipes, cleaned {len(zombie_pipes)} zombies')

            except Exception as e:
                self.debug_message(f'Error in zombie pipe cleanup: {e}')

    async def on_apaext_process(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """
        Handle extended data process commands for data operations.

        This method processes non-standard DAP commands that are specific to data
        pipeline operations. These commands extend the DAP protocol with data-specific
        functionality for managing data streams through processing pipelines.

        The method supports the following subcommands:
        - open: Initialize a new data pipe for processing
        - write: Write data to a specific lane of an active pipe (resets activity timer)
        - close: Close and finalize a pipe, returning processing results (resets activity timer)

        Args:
            request (Dict[str, Any]): The extended command request containing:
                - arguments: Dict with subcommand and operation-specific parameters
                - subcommand: The specific data operation to perform

        Returns:
            Dict[str, Any]: Response containing operation results or error information

        Raises:
            ValueError: When required parameters are missing or invalid
            Exception: When pipe operations fail or system errors occur
        """
        # Extract arguments from the request for processing
        # All subcommands use the arguments structure for parameters
        args = request.get('arguments', {})

        # Get the subcommand to determine which operation to perform
        # This drives the routing to the appropriate handler function
        subcmd = args.get('subcommand', None)

        # Route to the appropriate handler based on subcommand
        if subcmd == 'open':
            return await self._open(request, args)
        elif subcmd == 'write':
            return await self._write(request, args)
        elif subcmd == 'close':
            return await self._close(request, args)
        else:
            raise ValueError(f'Invalid subcommand {subcmd}')

    async def _open(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """
        Define open command with async semaphore acquisition.

        This operation:
        1. Acquires a semaphore slot to limit concurrent pipes (async, non-blocking)
        2. Validates required parameters and does sync pipe operations in thread
        3. Returns pipe ID on success

        The semaphore is acquired here and will be released in _close().
        The activity timer is set to current time when the pipe is created.
        """
        # Validate arguments first
        obj = args.get('object', None)
        if obj is None:
            raise ValueError('No object info specified')

        mime_type = args.get('mimeType', None)
        if mime_type is None:
            raise ValueError('No mimeType specified')

        # Acquire semaphore in async context (non-blocking for event loop)
        self.debug_message(f'Waiting for semaphore slot (max: {self._thread_count})...')
        await self._pipe_sem.acquire()

        try:
            self.debug_message('Acquired semaphore slot for new pipe')

            # Do the actual pipe operations in thread
            def open_sync():
                pipe_instance = None

                try:
                    # Create an entry object from the provided object metadata
                    entry = getObject(obj=obj)

                    # Get a pipe from the target endpoint
                    pipe_instance = self._target.getPipe()
                    self.debug_message(f'Allocated pipe {pipe_instance.pipeId} from endpoint')

                    # Get the id and determine the lane
                    pipe_id = pipe_instance.pipeId
                    lane = self._determine_lane(mime_type, pipe_instance)

                    # Open the object for processing
                    pipe_instance.open(entry)

                    # Create and store the DataConnPipe instance
                    current_time = time.time()
                    conn_pipe = DataConnPipe(
                        pipe_id=pipe_id,
                        pipe=pipe_instance,
                        mime_type=mime_type,
                        lane=lane,
                        is_open=True,
                        has_failed=False,
                        size=entry.size if entry.hasSize else None,
                        written=0,
                        entry=entry,
                        semaphore_acquired=True,  # Mark as having semaphore
                        created_time=current_time,
                        last_activity_time=current_time,  # Initialize activity timer
                    )

                    # Begin the pipe
                    self._begin(conn_pipe)

                    # Store in pipe map
                    self._pipe_map[pipe_id] = conn_pipe

                    self.debug_message(f'Successfully opened pipe {pipe_id} with lane {lane}, zombie timeout: {self._pipe_timeout}s')

                    return pipe_id

                except Exception:
                    # Clean up pipe if allocated
                    if pipe_instance:
                        try:
                            self._target.putPipe(pipe_instance)
                            self.debug_message(f'Returned pipe {pipe_instance.pipeId} due to error')
                        except Exception as cleanup_error:
                            self.debug_message(f'Error returning pipe during cleanup: {cleanup_error}')
                    raise

            # Execute sync operations in thread
            pipe_id = await asyncio.to_thread(open_sync)

            # Return success response
            return self.build_response(request, body={'pipe_id': pipe_id})

        except Exception as e:
            # Release semaphore on any error during open
            self._pipe_sem.release()
            self.debug_message(f'Released semaphore due to open error: {e}')
            raise

    async def _write(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """
        Handle write command (no semaphore operations needed).

        This resets the activity timer to prevent the pipe from being
        considered a zombie for another 60 seconds.
        """

        def write_sync():
            pipe_id = args.get('pipe_id', None)
            if pipe_id is None:
                raise ValueError('No pipe_id specified')

            # Retrieve the DataConnPipe instance from our mapping
            conn_pipe = self._pipe_map.get(pipe_id, None)
            if not conn_pipe:
                raise ValueError(f'Write pipe with id {pipe_id} not found')

            if not conn_pipe.is_open:
                raise ValueError(f'Write pipe with id {pipe_id} is not open')

            if conn_pipe.has_failed:
                raise ValueError(f'Write pipe with id {pipe_id} has failed')

            # Get the data to write
            data: bytes = args.get('data', None)
            if data is None:
                raise ValueError('No data specified')

            try:
                # Reset activity timer since pipe is being used
                self._reset_pipe_activity(conn_pipe)

                # Get pipe properties
                pipe = conn_pipe.pipe
                lane = conn_pipe.lane
                mime_type = conn_pipe.mime_type

                # Add to the written bytes count
                conn_pipe.written += len(data)

                # Handle different lane types with appropriate data writing
                if lane == 'text':
                    string_data = data.decode('utf-8')
                    pipe.writeText(string_data)

                elif lane == 'audio':
                    pipe.writeAudio(AVI_ACTION.WRITE, mime_type, data)

                elif lane == 'video':
                    pipe.writeVideo(AVI_ACTION.WRITE, mime_type, data)

                elif lane == 'image':
                    pipe.writeImage(AVI_ACTION.WRITE, mime_type, data)

                elif lane == 'raw':
                    pipe.writeTagData(data)

                elif lane == 'tag':
                    pipe.writeTag(data)

                elif lane == 'questions':
                    try:
                        question_str = data.decode('utf-8')
                        question = Question.model_validate_json(question_str)
                        pipe.writeQuestions(question)
                    except Exception as e:
                        raise ValueError(str(e))

                elif lane == 'documents':
                    try:
                        doc_str = data.decode('utf-8')
                        doc_data = json.loads(doc_str)
                        # writeDocuments expects List[Doc], handle single or list
                        if isinstance(doc_data, list):
                            docs = [Doc.model_validate(d) for d in doc_data]
                        else:
                            docs = [Doc.model_validate(doc_data)]
                        pipe.writeDocuments(docs)
                    except Exception as e:
                        raise ValueError(str(e))

                elif lane == 'answers':
                    try:
                        answer_str = data.decode('utf-8')
                        answer = Answer.model_validate_json(answer_str)
                        pipe.writeAnswers(answer)
                    except Exception as e:
                        raise ValueError(str(e))

                elif lane == 'classifications':
                    try:
                        class_str = data.decode('utf-8')
                        class_data = json.loads(class_str)
                        # Expect: {classifications: {}, classificationPolicy: {}, classificationRules: {}}
                        classifications = class_data.get('classifications', {})
                        policy = class_data.get('classificationPolicy', {})
                        rules = class_data.get('classificationRules', {})
                        pipe.writeClassifications(classifications, policy, rules)
                    except Exception as e:
                        raise ValueError(str(e))

                else:
                    raise ValueError(f'Invalid lane {lane}')

            except Exception as e:
                # Mark pipe as failed
                conn_pipe.has_failed = True
                self.debug_message(f'Error handling write request: {e}')
                raise

        # Execute in thread
        await asyncio.to_thread(write_sync)
        return self.build_response(request)

    async def _close(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """
        Handle close command with semaphore release.

        This operation:
        1. Validates pipe_id and removes pipe from map
        2. Resets activity timer (close is considered activity)
        3. Closes the pipe and extracts results in thread
        4. Cleans up resources and releases semaphore

        The semaphore acquired in _open() is released here.
        """
        pipe_id = args.get('pipe_id', None)
        if pipe_id is None:
            raise ValueError('No pipe_id specified')

        # Retrieve and remove the DataConnPipe instance from our mapping immediately
        conn_pipe = self._pipe_map.pop(pipe_id, None)
        if not conn_pipe:
            raise ValueError(f'Close pipe with id {pipe_id} not found')

        try:
            # Reset activity timer since close is considered activity
            self._reset_pipe_activity(conn_pipe)

            def close_sync():
                try:
                    # End the pipe
                    self._end(conn_pipe)

                    # Close the pipe to finalize all processing
                    pipe = conn_pipe.pipe
                    pipe.close()

                    # Extract the result objects from the completed processing
                    results = conn_pipe.entry.response.toDict()
                    results['objectId'] = conn_pipe.entry.objectId

                    # Mark pipe as closed
                    conn_pipe.is_open = False

                    # Return the results
                    self.debug_message(f'Successfully closed pipe {conn_pipe.pipe_id}')
                    return results

                except Exception as e:
                    # Mark pipe as failed
                    conn_pipe.has_failed = True
                    self.debug_message(f'Error in close_sync: {e}')
                    raise

            # Execute close operations in thread
            results = await asyncio.to_thread(close_sync)

            # Return the complete processing results to the client
            return self.build_response(request, body=results)

        except Exception as e:
            conn_pipe.has_failed = True
            self.debug_message(f'Error handling close request: {e}')
            raise

        finally:
            # Always clean up and release semaphore
            await asyncio.to_thread(self._cleanup_pipe, conn_pipe)

            # Release semaphore if it was acquired in open()
            if conn_pipe.semaphore_acquired:
                self._pipe_sem.release()
                self.debug_message(f'Released semaphore for pipe {pipe_id}')
