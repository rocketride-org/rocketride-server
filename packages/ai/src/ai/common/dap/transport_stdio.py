"""
Stdio Transport Implementation for DAP Protocol.

This module provides a concrete stdio transport implementation for Debug Adapter Protocol
(DAP) communication. It extends the abstract TransportBase class with stdio-specific
functionality for communicating with subprocesses using a custom protocol.

The stdio transport handles subprocess communication patterns including:
- Custom protocol message parsing from stdout/stderr streams
- JSON command sending via stdin
- Automatic background stream monitoring
- Protocol message translation to DAP events
- Error handling and recovery
- Process lifecycle management
- Connection lifecycle event callbacks

Key Features:
- Production-ready subprocess stdio communication
- Custom protocol parsing ('>TYPE*field1*field2*...' format)
- JSON command interface via stdin
- Comprehensive error handling with customizable callbacks
- Protocol debugging support for development and troubleshooting
- Connection lifecycle callbacks (on_connected, on_disconnected)
- Background stream monitoring with asyncio
- Graceful process termination handling

Custom Protocol Support:
The transport recognizes and parses various message types:
- OBJ: Object processing status ('>OBJ*size_hex*object_name')
- CNT: Statistical counters ('>CNT*total*completed*failed*...')
- ERR: Error messages ('>ERR*error_text')
- WRN: Warning messages ('>WRN*warning_text')
- MET: Metrics data in JSON ('>MET*json_data')
- SVC: Service status ('>SVC*1_or_0')
- JOB: Job status ('>JOB*status_message')
- DBG: Debug commands ('>DBG*operation*id*total_pipes*pipe_id')
- EXIT: Process exit ('>EXIT*exit_code_hex*exit_message')

Usage Patterns:
    For background subprocess monitoring:
    ```python
    # Create subprocess
    process = await asyncio.create_subprocess_exec('python', 'task_engine.py', stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)

    # Setup transport
    transport = TransportStdio(process)
    transport.bind(on_debug_message=logger.debug, on_debug_protocol=protocol_logger.debug, on_receive=handle_protocol_message, on_connected=handle_process_connected, on_disconnected=handle_process_disconnected)

    # Start monitoring (returns immediately, runs in background)
    await transport.connect()

    # Send commands
    await transport.send({'command': 'pause'})

    # Cleanup when done
    await transport.disconnect()
    ```

    For blocking subprocess monitoring:
    ```python
    # Create subprocess
    process = await asyncio.create_subprocess_exec(...)

    # Setup transport
    transport = TransportStdio()
    transport.bind(...)

    # Start monitoring (blocks until process exits)
    await transport.accept(process)
    ```

    For sending commands to subprocess:
    ```python
    await transport.send({'command': 'pause'})
    await transport.send({'command': 'resume', 'args': {'mode': 'fast'}})
    ```
"""

import json
import asyncio
from typing import Dict, Any, Optional
from ai.constants import CONST_TRANSPORT_PROCESS_WAIT_TIMEOUT
from . import TransportBase


class TransportStdio(TransportBase):
    """
    Stdio transport implementation for DAP protocol communication with subprocesses.

    This class provides a concrete stdio transport that extends TransportBase
    with subprocess-specific functionality. It handles the custom protocol used
    by task engines, automatic stream monitoring, JSON command sending, and
    connection lifecycle event callbacks.

    Features:
    - Custom protocol message parsing from subprocess streams
    - JSON command interface via subprocess stdin
    - Background stream monitoring with asyncio tasks
    - Connection lifecycle callbacks (on_connected, on_disconnected)
    - Protocol-level debugging and message tracing
    - Graceful process termination handling
    - Safe callback handling through base class wrapper methods

    The class handles subprocess communication:
    - connect(): Starts background monitoring and returns immediately
    - accept(): Monitors subprocess streams until process exits (blocking)
    - send(): Sends JSON commands to subprocess via stdin
    - Automatic protocol message parsing and DAP event generation

    Connection Lifecycle Events:
    - Successful process attachment triggers on_connected with process info
    - Process termination triggers on_disconnected with exit status
    - Stream errors trigger on_disconnected with error details
    - Enables higher-level code to respond to process state changes

    Custom Protocol Processing:
    The transport automatically parses the custom protocol messages and converts
    them to structured DAP events through the on_receive callback. This provides
    a standardized interface for handling subprocess communication.

    Example Usage:
        ```python
        # Background monitoring (non-blocking)
        process = await asyncio.create_subprocess_exec(...)
        transport = TransportStdio(process)
        transport.bind(...)
        await transport.connect()  # Returns immediately
        # Process monitored in background

        # Blocking monitoring
        transport = TransportStdio()
        transport.bind(...)
        await transport.accept(process)  # Blocks until process exits
        ```
    """

    def __init__(self, subprocess: Optional[asyncio.subprocess.Process] = None) -> None:
        """
        Initialize the stdio transport.

        The transport must be bound with callback functions using bind()
        before it can be used for communication.

        Args:
            subprocess (Optional[asyncio.subprocess.Process]): Optional subprocess
                for use with connect(). If provided, connect() will monitor this
                process. If not provided, use accept() with a subprocess instance.
        """
        super().__init__()
        self._process = subprocess
        self._stdout_task: Optional[asyncio.Task] = None
        self._stderr_task: Optional[asyncio.Task] = None

    async def connect(self, timeout: Optional[float] = None) -> None:
        """
        Start monitoring the subprocess and return immediately.

        This method starts background monitoring of the subprocess streams
        and returns immediately, following the same pattern as other transports.
        The subprocess monitoring runs in background tasks until the process
        terminates or disconnect() is called.

        Args:
            timeout: Optional timeout in ms (ignored; for API compatibility with DAPClient.connect).

        Raises:
            ValueError: If subprocess is not a valid process instance
            ConnectionError: If subprocess monitoring setup fails

        Example:
            ```python
            transport = TransportStdio(subprocess)
            transport.bind(...)
            await transport.connect()  # Returns immediately
            # Subprocess is now being monitored in background
            ```
        """
        if not isinstance(self._process, asyncio.subprocess.Process):
            raise ValueError('Stdio transport requires asyncio.subprocess.Process instance')

        try:
            self._debug_message('Starting subprocess stdio monitoring')
            self._connected = True

            # Get process info for connection callback
            process_info = f'subprocess_pid_{self._process.pid}' if self._process.pid else 'subprocess_unknown'

            # Start stream monitoring tasks in background
            if self._process.stdout:
                self._stdout_task = asyncio.create_task(self._read_stream(self._process.stdout, 'stdout'))
                self._debug_message('Started stdout monitoring task')

            if self._process.stderr:
                self._stderr_task = asyncio.create_task(self._read_stream(self._process.stderr, 'stderr'))
                self._debug_message('Started stderr monitoring task')

            if not self._stdout_task and not self._stderr_task:
                raise ConnectionError('No stdout or stderr streams available for monitoring')

            # Trigger on_connected callback
            await self._transport_connected(process_info)

        except Exception as e:
            self._debug_message(f'Failed to start subprocess monitoring: {e}')

            # Trigger disconnected callback with error
            await self._transport_disconnected(f'Connect failed: {e}', has_error=True)
            raise ConnectionError(f'Stdio connect failed: {e}')

    async def accept(self, process: asyncio.subprocess.Process) -> None:
        """
        Accept a subprocess instance and start monitoring until process exits.

        This method accepts the subprocess, starts monitoring its streams,
        and blocks until the subprocess terminates. This is designed for
        server-style usage where the transport manages the subprocess lifecycle
        by blocking until completion.

        Connection lifecycle callbacks will be triggered:
        - on_connected: When subprocess monitoring begins successfully
        - on_disconnected: When subprocess terminates or monitoring fails

        Args:
            process (asyncio.subprocess.Process): The subprocess to monitor.
                                                 Must have stdin, stdout, and stderr available.

        Raises:
            ValueError: If process is not a valid subprocess instance
            ConnectionError: If subprocess monitoring setup fails

        Example:
            ```python
            # Create subprocess
            process = await asyncio.create_subprocess_exec(...)

            transport = TransportStdio()
            transport.bind(...)

            # Start monitoring (blocks until process exits)
            await transport.accept(process)
            print('Process has terminated')
            ```

        Note:
            This method blocks until the subprocess terminates.
            It handles all stream monitoring during the process lifetime.
            Use connect() if you want non-blocking background monitoring.
        """
        # Store the process for this accept session
        self._process = process

        if not isinstance(self._process, asyncio.subprocess.Process):
            raise ValueError('Stdio transport requires asyncio.subprocess.Process instance')

        try:
            self._debug_message('Accepting subprocess for stdio monitoring')
            self._connected = True

            # Get process info for connection callback
            process_info = f'subprocess_pid_{self._process.pid}' if self._process.pid else 'subprocess_unknown'

            # TRIGGER ON_CONNECTED CALLBACK
            await self._transport_connected(process_info)

            # Start stream monitoring tasks
            tasks = []

            if self._process.stdout:
                self._stdout_task = asyncio.create_task(self._read_stream(self._process.stdout, 'stdout'))
                tasks.append(self._stdout_task)
                self._debug_message('Started stdout monitoring task')

            if self._process.stderr:
                self._stderr_task = asyncio.create_task(self._read_stream(self._process.stderr, 'stderr'))
                tasks.append(self._stderr_task)
                self._debug_message('Started stderr monitoring task')

            if not tasks:
                raise ConnectionError('No stdout or stderr streams available for monitoring')

            # Wait for subprocess to complete and all monitoring tasks to finish
            await self._process.wait()
            self._debug_message(f'Subprocess terminated with exit code: {self._process.returncode}')

            # Wait for monitoring tasks to complete
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)
                self._debug_message('All stream monitoring tasks completed')

        except Exception as e:
            self._debug_message(f'Failed to accept subprocess: {e}')
            # Trigger disconnected callback with error
            await self._transport_disconnected(f'Accept failed: {e}', has_error=True)
            raise ConnectionError(f'Stdio accept failed: {e}')

        finally:
            # Mark as disconnected and cleanup
            self._connected = False
            self._process = None
            self._stdout_task = None
            self._stderr_task = None

    async def disconnect(self) -> None:
        """
        Disconnect and terminate subprocess monitoring.

        This method gracefully stops subprocess monitoring, cancels any
        background stream tasks, and cleans up resources. It can be called
        to terminate subprocess monitoring early.

        The method is safe to call multiple times - subsequent calls will
        be ignored if already disconnected.

        Connection lifecycle callbacks will be triggered:
        - on_disconnected: Called with graceful disconnection reason

        Example:
            ```python
            # Graceful shutdown
            try:
                await transport.disconnect()
            except Exception as e:
                logger.error(f'Error during disconnect: {e}')
            ```

        Note:
            After disconnection, the transport cannot be used for communication
            until a new subprocess is accepted via accept() or connect().
            The on_disconnected callback will be triggered.
        """
        if not self._connected:
            return

        try:
            self._debug_message('Disconnecting stdio transport')

            # Cancel monitoring tasks
            if self._stderr_task and not self._stderr_task.done():
                self._stderr_task.cancel()
                try:
                    await self._stderr_task
                except asyncio.CancelledError:
                    pass
                self._debug_message('Cancelled stderr monitoring task')

            if self._stdout_task and not self._stdout_task.done():
                self._stdout_task.cancel()
                try:
                    await self._stdout_task
                except asyncio.CancelledError:
                    pass
                self._debug_message('Cancelled stdout monitoring task')

            # Terminate subprocess if still running
            if self._process and self._process.returncode is None:
                self._debug_message('Terminating subprocess')
                self._process.terminate()
                try:
                    await asyncio.wait_for(self._process.wait(), timeout=CONST_TRANSPORT_PROCESS_WAIT_TIMEOUT)
                except asyncio.TimeoutError:
                    self._debug_message('Subprocess termination timeout, killing')
                    self._process.kill()
                    await self._process.wait()

            self._connected = False
            self._process = None
            self._stdout_task = None
            self._stderr_task = None
            self._debug_message('Successfully disconnected stdio transport')

            # Trigger on_disconnected callback (gracefully)
            await self._transport_disconnected('Disconnected by request', has_error=False)

        except Exception as e:
            # Log error but don't re-raise to ensure cleanup completes
            self._debug_message(f'Error during stdio disconnect: {e}')

            # Still mark as disconnected even if cleanup failed
            self._connected = False
            self._process = None
            self._stdout_task = None
            self._stderr_task = None

            # Trigger on_disconnected callback (error)
            await self._transport_disconnected(f'Disconnect error: {e}', has_error=True)

    async def send(self, message: Dict[str, Any]) -> None:
        """
        Send a JSON command to the subprocess via stdin.

        This method sends JSON-serialized commands to the subprocess through
        its stdin stream. The subprocess must be designed to read and parse
        JSON commands from stdin for this communication to work.

        Args:
            message (Dict[str, Any]): The command to send. Must be JSON-serializable.
                                     Will be sent as JSON followed by newline.

        Raises:
            ConnectionError: If not connected or stdin not available
            Exception: If sending fails due to broken pipe or other errors

        JSON Command Format:
        Commands are sent as JSON objects followed by a newline delimiter:
        ```
        {'command': 'pause'}
        {'command': 'resume', 'args': {'mode': 'fast'}}
        ```

        Example Usage:
            ```python
            # Send simple command
            await transport.send({'command': 'pause'})

            # Send command with arguments
            await transport.send({'command': 'resume', 'args': {'mode': 'fast'}})

            # Send shutdown command
            await transport.send({'command': 'shutdown', 'graceful': True})
            ```

        Error Handling:
        All sending errors are logged via the debug message callback with detailed error
        information before being re-raised to the caller.
        """
        # Check if we're connected before sending
        if not self.is_connected():
            raise ConnectionError('Stdio transport is not connected. Call connect() or accept() first.')

        if not self._process or not self._process.stdin:
            raise ConnectionError('Subprocess stdin not available for sending commands')

        try:
            # Log outgoing message for protocol debugging
            self._debug_protocol(f'SEND: {message}')

            # Serialize message to JSON with newline delimiter
            json_content = json.dumps(message, separators=(',', ':'))
            message_bytes = (json_content + '\n').encode('utf-8')

            # Send to subprocess stdin
            self._process.stdin.write(message_bytes)
            await self._process.stdin.drain()

        except Exception as e:
            # Log send failures with detailed error information for debugging
            self._debug_message(f'Failed to send message to subprocess: {e}')
            raise

    async def _read_stream(self, stream: asyncio.StreamReader, stream_name: str) -> None:
        """
        Asynchronously read and process lines from a subprocess stream.

        This method runs as a background task, continuously reading from the
        specified stream until EOF. Each line is processed through the message
        handler to convert custom protocol messages into structured events.

        Args:
            stream (asyncio.StreamReader): The stream to read from (stdout or stderr)
            stream_name (str): Human-readable name for logging ("stdout" or "stderr")

        Error Handling:
            - Individual decode errors are logged and skipped
            - Stream reading continues even if message processing fails
            - EOF conditions trigger appropriate shutdown sequences
            - Connection lifecycle callbacks are triggered for disconnection
        """
        # Setup for termination handling
        exc = None

        try:
            self._debug_message(f'Starting to read {stream_name} stream')

            while not stream.at_eof():
                line = await stream.readline()

                if not line:
                    self._debug_message(f'EOF reached on {stream_name} stream')
                    break

                try:
                    # Decode and process the message
                    data_str = line.decode('utf-8').strip()
                    await self._process_message(stream_name, data_str)

                except UnicodeDecodeError:
                    self._debug_message(f'Unicode decode error on {stream_name}, skipping line')
                    continue
                except Exception as e:
                    self._debug_message(f'Error processing {stream_name} message: {e}')
                    continue

            # Output a trace message
            self._debug_message(f'{stream_name} reading completed')

        except asyncio.CancelledError:
            # Output a trace message
            self._debug_message(f'{stream_name} reading cancelled')

        except Exception as e:
            # Save the exception for later handling
            exc = e

            # Output a trace message
            self._debug_message(f'Unexpected error reading {stream_name}: {e}')

        finally:
            # Only stdout generates shutdown sequence to avoid duplicates
            if stream_name == 'stdout':
                self._debug_message('Generating shutdown sequence for stdout')

                try:
                    # Send synthetic shutdown messages
                    await self._process_message(stream_name, '>SVC*0')

                except Exception as e:
                    self._debug_message(f'Error during shutdown sequence: {e}')

                # Signal disconnection
                if exc is not None:
                    await self._transport_disconnected(f'{stream_name} read error: {exc}', has_error=True)
                else:
                    await self._transport_disconnected(f'{stream_name} terminated', has_error=False)
            else:
                # Output a trace message
                self._debug_message(f'Finished reading {stream_name} stream')

    async def _process_message(self, channel: str, message: Optional[str]) -> None:
        """
        Process and translate a single message from the subprocess custom protocol.

        This method implements the core protocol translation that converts the
        subprocess's custom stdio protocol into structured DAP-compatible events.
        It handles various message types with robust error handling.

        Args:
            channel (str): Source stream identifier ("stdout" or "stderr")
            message (Optional[str]): The raw message content, or None for end-of-stream

        Protocol Message Types:
        - '>OBJ*size_hex*object_name' - Object processing status
        - '>CNT*total*completed*failed*...' - Statistical counters
        - '>ERR*error_text' - Error messages
        - '>WRN*warning_text' - Warning messages
        - '>MET*json_data' - Metrics data in JSON
        - '>SVC*1_or_0' - Service status
        - '>JOB*status_message' - Job status
        - '>DBG*operation*id*total_pipes*pipe_id' - Debug commands
        - '>DL*json_data' - pip install info
        - '>USR**json' - User data for prompting
        - '>SSE*json' - Real-time node-to-UI message (pipe_id + message + optional data)
        - '>EXIT*exit_code_hex*exit_message' - Process exit
        """
        # Parse object status messages: '>OBJ*size_hex*object_name'
        if message.startswith('>OBJ*'):
            try:
                parts = message.split('*', 2)
                if len(parts) >= 3:
                    _, s_size, name = parts
                    size = int(s_size, 16)
                    await self._transport_receive({'type': 'event', 'event': 'apaevt_status_status_object', 'body': {'object': name, 'size': size}})
                else:
                    await self._transport_receive({'type': 'event', 'event': 'output', 'body': {'category': 'console', 'output': f'Incomplete OBJ message: {message}\n'}})
            except (ValueError, IndexError) as e:
                self._debug_message(f'Malformed OBJ message: {message}, error: {e}')
                await self._transport_receive({'type': 'event', 'event': 'output', 'body': {'category': 'console', 'output': f'Malformed OBJ message: {message}\n'}})

        # Parse comprehensive statistics: '>CNT*total_size*total_count*completed_size*...'
        elif message.startswith('>CNT*'):
            try:
                parts = message.split('*')
                if len(parts) >= 11:
                    (_, s_totalSize, s_totalCount, s_completedSize, s_completedCount, s_failedSize, s_failedCount, s_wordsSize, s_wordsCount, s_rateSize, s_rateCount) = parts[:11]

                    await self._transport_receive(
                        {
                            'type': 'event',
                            'event': 'apaevt_status_counts',
                            'body': {
                                'totalSize': int(s_totalSize, 16),
                                'totalCount': int(s_totalCount, 16),
                                'completedSize': int(s_completedSize, 16),
                                'completedCount': int(s_completedCount, 16),
                                'failedSize': int(s_failedSize, 16),
                                'failedCount': int(s_failedCount, 16),
                                'wordsSize': int(s_wordsSize, 16),
                                'wordsCount': int(s_wordsCount, 16),
                                'rateSize': int(s_rateSize, 16),
                                'rateCount': int(s_rateCount, 16),
                            },
                        }
                    )
                else:
                    await self._transport_receive({'type': 'event', 'event': 'output', 'body': {'category': 'console', 'output': f'Incomplete CNT message: {message}\n'}})
            except (ValueError, IndexError) as e:
                self._debug_message(f'Malformed CNT message: {message}, error: {e}')
                await self._transport_receive({'type': 'event', 'event': 'output', 'body': {'category': 'console', 'output': f'Malformed CNT message: {message}\n'}})

        # Parse error messages: '>ERR*error_message'
        elif message.startswith('>ERR*'):
            try:
                parts = message.split('*', 1)
                msg = parts[1] if len(parts) >= 2 else 'Empty error message'
                await self._transport_receive({'type': 'event', 'event': 'apaevt_status_error', 'body': {'message': msg}})
            except IndexError:
                await self._transport_receive({'type': 'event', 'event': 'apaevt_status_error', 'body': {'message': 'Malformed error message'}})

        # Parse warning messages: '>WRN*warning_message'
        elif message.startswith('>WRN*'):
            try:
                parts = message.split('*', 1)
                msg = parts[1] if len(parts) >= 2 else 'Empty warning message'
                await self._transport_receive({'type': 'event', 'event': 'apaevt_status_warning', 'body': {'message': msg}})
            except IndexError:
                await self._transport_receive({'type': 'event', 'event': 'apaevt_status_warning', 'body': {'message': 'Malformed warning message'}})

        # Parse metrics messages: '>MET*json_data'
        elif message.startswith('>DL*'):
            try:
                parts = message.split('*', 1)
                if len(parts) >= 2:
                    _, json_str = parts

                    download_info = json.loads(json_str)
                    message_info = {
                        'name': download_info.get('name', ''),
                        'status': download_info.get('status', ''),
                        'error': download_info.get('error', []),
                    }
                    await self._transport_receive({'type': 'event', 'event': 'apaevt_status_download', 'body': {'info': message_info}})
                else:
                    await self._transport_receive({'type': 'event', 'event': 'output', 'body': {'category': 'console', 'output': f'Incomplete DL message: {message}\n'}})
            except (json.JSONDecodeError, IndexError) as e:
                self._debug_message(f'Malformed DL message: {message}, error: {e}')
                await self._transport_receive({'type': 'event', 'event': 'output', 'body': {'category': 'console', 'output': f'Malformed DL message: {message}\n'}})

        # Parse user messages: '>USR*htmlstr'
        elif message.startswith('>USR*'):
            try:
                parts = message.split('*', 1)
                if len(parts) > 1:
                    jsonmessage = parts[1]
                    value = json.loads(jsonmessage)
                else:
                    value = []
                await self._transport_receive({'type': 'event', 'event': 'apaevt_status_user', 'body': {'notes': value}})
            except (json.JSONDecodeError, IndexError) as e:
                self._debug_message(f'Malformed USR message: {message}, error: {e}')
                await self._transport_receive({'type': 'event', 'event': 'output', 'body': {'category': 'console', 'output': f'Malformed USR message: {message}\n'}})

        # Parse metrics messages: '>MET*json_data'
        elif message.startswith('>MET*'):
            try:
                parts = message.split('*', 1)
                if len(parts) >= 2:
                    _, json_str = parts
                    metrics = json.loads(json_str)
                    await self._transport_receive({'type': 'event', 'event': 'apaevt_status_metrics', 'body': {'metrics': metrics}})
                else:
                    await self._transport_receive({'type': 'event', 'event': 'output', 'body': {'category': 'console', 'output': f'Incomplete MET message: {message}\n'}})
            except (json.JSONDecodeError, IndexError) as e:
                self._debug_message(f'Malformed MET message: {message}, error: {e}')
                await self._transport_receive({'type': 'event', 'event': 'output', 'body': {'category': 'console', 'output': f'Malformed MET message: {message}\n'}})

        # Parse info messages: '>INF*json_data'
        elif message.startswith('>INF*'):
            try:
                parts = message.split('*', 1)
                if len(parts) >= 2:
                    _, json_str = parts
                    info = json.loads(json_str)
                    await self._transport_receive({'type': 'event', 'event': 'apaevt_status_info', 'body': {'info': info}})
                else:
                    await self._transport_receive({'type': 'event', 'event': 'output', 'body': {'category': 'console', 'output': f'Incomplete INF message: {message}\n'}})
            except (json.JSONDecodeError, IndexError) as e:
                self._debug_message(f'Malformed INF message: {message}, error: {e}')
                await self._transport_receive({'type': 'event', 'event': 'output', 'body': {'category': 'console', 'output': f'Malformed INF message: {message}\n'}})

        # Parse service status messages: '>SVC*status_flag'
        elif message.startswith('>SVC*'):
            try:
                parts = message.split('*', 1)
                if len(parts) >= 2:
                    _, s_status = parts
                    status = bool(int(s_status))
                    await self._transport_receive({'type': 'event', 'event': 'apaevt_status_state', 'body': {'service': status}})
                else:
                    await self._transport_receive({'type': 'event', 'event': 'output', 'body': {'category': 'console', 'output': f'Incomplete SVC message: {message}\n'}})
            except (ValueError, IndexError) as e:
                self._debug_message(f'Malformed SVC message: {message}, error: {e}')
                await self._transport_receive({'type': 'event', 'event': 'output', 'body': {'category': 'console', 'output': f'Malformed SVC message: {message}\n'}})

        # Parse job status messages: '>JOB*status_message'
        elif message.startswith('>JOB*'):
            try:
                parts = message.split('*', 1)
                status = parts[1] if len(parts) >= 2 else 'Empty job status'
                await self._transport_receive({'type': 'event', 'event': 'apaevt_status_message', 'body': {'message': status}})
            except IndexError:
                await self._transport_receive({'type': 'event', 'event': 'apaevt_status_message', 'body': {'message': 'Malformed job message'}})

        # Parse debug command messages: '>DBG*operation*id*total_pipes*pipe_id'
        elif message.startswith('>DBG*'):
            try:
                _, op, id, total_pipes, pipe_id, trace_str = message.split('*', 5)

                # Attempt to get the data trace
                trace = {}
                try:
                    trace = json.loads(trace_str)
                except Exception:
                    pass

                # Output it
                await self._transport_receive(
                    {
                        'type': 'event',
                        'event': 'apaevt_trace',
                        'body': {
                            'op': op.lower(),
                            'id': int(id, 16),
                            'total_pipes': int(total_pipes, 16),
                            'pipe_id': pipe_id,
                            'trace': trace
                        },
                    }
                )
            except (ValueError, IndexError) as e:
                self._debug_message(f'Malformed DBG message: {message}, error: {e}')
                await self._transport_receive({'type': 'event', 'event': 'output', 'body': {'category': 'console', 'output': f'Malformed DBG message: {message}\n'}})

        # Parse exit status messages: '>EXIT*exit_code_hex*exit_message'
        elif message.startswith('>EXIT*'):
            try:
                parts = message.split('*', 3)
                if len(parts) == 4:
                    _, s_exitCode, exitMessage, _ = parts
                    try:
                        exitCode = int(s_exitCode, 16)
                    except ValueError:
                        exitCode = 0 if s_exitCode == 'CANCELLED' else 1
                    await self._transport_receive({'type': 'event', 'event': 'apaevt_exit', 'body': {'exitCode': exitCode, 'message': exitMessage}})

                    # TRIGGER ON_DISCONNECTED CALLBACK (process exit)
                    await self._transport_disconnected(f'Process exited: {exitMessage} (code: {exitCode})', has_error=(exitCode != 0))

                elif len(parts) == 3:
                    _, s_exitCode = parts
                    try:
                        exitCode = int(s_exitCode, 16)
                    except ValueError:
                        exitCode = 1
                    await self._transport_receive({'type': 'event', 'event': 'apaevt_exit', 'body': {'exitCode': exitCode, 'message': 'Process exited'}})

                    # TRIGGER ON_DISCONNECTED CALLBACK (process exit)
                    await self._transport_disconnected(f'Process exited with code: {exitCode}', has_error=(exitCode != 0))

                else:
                    await self._transport_receive({'type': 'event', 'event': 'apaevt_exit', 'body': {'exitCode': 1, 'message': 'Incomplete exit message'}})

                    # TRIGGER ON_DISCONNECTED CALLBACK (malformed exit)
                    await self._transport_disconnected('Process exited with incomplete exit message', has_error=True)
            except IndexError:
                await self._transport_receive({'type': 'event', 'event': 'apaevt_exit', 'body': {'exitCode': 1, 'message': 'Malformed exit message'}})
                # TRIGGER ON_DISCONNECTED CALLBACK (malformed exit)
                await self._transport_disconnected('Process exited with malformed exit message', has_error=True)

        # Parse SSE messages: '>SSE*{"pipe_id": N, "message": "...", "data": {...}}'
        elif message.startswith('>SSE*'):
            try:
                parts = message.split('*', 1)
                payload = json.loads(parts[1]) if len(parts) > 1 else {}
                await self._transport_receive({
                    'type': 'event',
                    'event': 'apaevt_sse',
                    'body': payload,
                })
            except Exception as e:
                self._debug_message(f'Malformed SSE message: {message}, error: {e}')

        # Handle unknown control messages starting with '>'
        elif message.startswith('>'):
            self._debug_message(f'Unknown control message: {message}')
            await self._transport_receive({'type': 'event', 'event': 'output', 'body': {'category': 'console', 'output': f'Unknown control: {message}\n'}})

        # Handle regular console output (non-control messages)
        else:
            await self._transport_receive({'type': 'event', 'event': 'output', 'body': {'category': 'console', 'output': f'{message}\n'}})
