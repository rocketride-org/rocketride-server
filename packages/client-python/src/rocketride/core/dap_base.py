# MIT License
#
# Copyright (c) 2026 RocketRide, Inc.
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
Debug Adapter Protocol (DAP) Base Mixin Classes.

This module provides the foundational DAPBase mixin class for building Debug Adapter Protocol
components. Use this module when creating DAP servers, clients, transports, or protocol handlers
that need standardized logging, error handling, and message construction capabilities.

The module implements the core DAP message lifecycle including request/response correlation,
event generation, error handling with traceback information, and two-level debug output for
both operational and protocol-level debugging.

Key Components:
    DAPBase: Base mixin class providing DAP functionality

Usage:
    from dap_base import DAPBase

    class MyDAPServer(DAPBase):
        def __init__(self):
            super().__init__(module="MyServer")

Features:
    - Automatic sequence number generation for message correlation
    - Two-level debug output (general messages and protocol details)
    - Standardized DAP message builders (requests, responses, events, errors)
    - Exception handling with traceback information
    - Transport binding for network communication
    - Configurable logging integration
"""

import os
import sys
import traceback
import inspect
import logging
from typing import Dict, Any, Optional, Union


class DAPBase:
    """
    Mixin class providing standardized logging and error handling for DAP components.

    This class serves as a base mixin for all DAP (Debug Adapter Protocol) related
    components, providing consistent logging, error handling, and debugging capabilities.
    It centralizes common functionality needed across different DAP implementations
    including servers, clients, transports, and protocol handlers.

    Key Features:
        - Standardized error logging and exception raising
        - Hierarchical debug message levels (general vs protocol-specific)
        - Configurable message type prefixes for multi-instance debugging
        - Consistent formatting across all DAP components
        - Support for exception chaining to preserve error context
        - Request/response correlation system for async operations
        - Message building utilities following DAP specification

    Usage:
        This class is designed to be used as a mixin with other DAP classes:

        class DAPConn(DAPBase, SomeOtherBase):
            def __init__(self, module: str, **kwargs):
                super().__init__(module, **kwargs)

            def some_method(self):
                self.show_message('Server started')
                try:
                    # ... some operation
                except Exception as e:
                    self.raise_exception(e)

    Debug Levels:
        - DebugOut: General operational messages (connections, state changes)
        - DebugProtocol: Detailed protocol messages (raw DAP packets, wire format)

    Attributes:
        _msg_type (str): Message type identifier used in log prefixes to distinguish
                        between different DAP component instances in complex debugging
                        scenarios.
        _seq_counter (int): Counter for generating unique sequence numbers.
    """

    def __init__(self, module: str = 'UNKOWN', **kwargs) -> None:
        """
        Initialize the DAP base class with configuration and module identification.

        Args:
            config (Dict[str, Any]): Configuration dictionary for the DAP instance.
                                    Defaults to empty dict.
            **kwargs: Additional keyword arguments. The 'module' key is used for
                    logging prefixes and component identification. If not provided,
                    defaults to 'UNKNOWN'.
        """
        # Message type identifier for logging - helps distinguish different DAP instances
        # This should be set by concrete classes to provide meaningful log prefixes
        self._msg_type: str = module

        # Set the starting packet identifier for DAP message sequencing
        self._seq_counter = 0

        # Route the debugger output either through our kernel
        # or through logging depending on which one is running us
        try:
            from rocketride import debug, Lvl

            def _debug_message(message: str) -> None:
                debug(Lvl.DebugOut, message)

            def _debug_protocol(message: str) -> None:
                debug(Lvl.DebugProtocol, message)

        except ImportError:
            # Create a logger for DAP components
            logger = logging.getLogger('rocketride')

            # Extreme logging
            logging.addLevelName(3, 'PROTOCOL')  # Very uncommon number

            def _debug_message(message: str) -> None:
                logger.debug(message)

            def _debug_protocol(message: str) -> None:
                logger.log(3, message)

        # Setup the callbacks for debug messages
        self._call_debug_message = _debug_message
        self._call_debug_protocol = _debug_protocol

        # Setup the transport if specified and bind it
        self._transport = kwargs.get('transport', None)

        # Bind the transport to this client
        if self._transport:
            self._bind_transport(self._transport)

    def _bind_transport(self, transport) -> None:
        """
        Bind a transport to this client's handlers.

        Used when the transport is created lazily (e.g. in _internal_connect).
        Call this after setting self._transport to the new transport instance.
        """
        transport.bind(
            on_debug_message=self.debug_message,
            on_debug_protocol=self.debug_protocol,
            on_receive=self.on_receive,
            on_connected=self.on_connected,
            on_disconnected=self.on_disconnected,
        )

    async def _call_method(self, message: Dict[str, Any], method_name: str, default_name: str):
        """
        Attempt to call a specific method, falling back to a default method.

        This utility method implements a flexible method dispatch pattern that allows
        for both specific command handlers and fallback handlers. It's used by the
        dispatch system to provide graceful degradation when specific handlers
        aren't available.

        Args:
            request (Dict[str, Any]): The DAP message/request to pass to the method.
            method_name (str): Primary method name to attempt (e.g., 'on_initialize').
            default_name (str): Fallback method name if primary doesn't exist (e.g., 'on_request').

        Returns:
            Tuple[bool, Any]: A tuple containing:
                - bool: True if a method was found and called, False otherwise
                - Any: The return value from the called method, or None if no method called

        Example:
            # Try to call 'on_initialize', fall back to 'on_request'
            handled, result = await self._call_method(request, 'on_initialize', 'on_request')
        """
        try:
            if method_name:
                # 1. Look for a specific handler method for this command
                method = getattr(self, method_name, None)
                if callable(method):
                    # Found specific handler - call it with the request
                    return (True, await method(message))

            if default_name:
                # 2. Try the fallback default handler if no specific handler exists
                method = getattr(self, default_name, None)
                if callable(method):
                    # Found default handler - call it with the request
                    return (True, await method(message))

            # No handler found - return indication that nothing was called
            return (False, None)

        except Exception as e:
            return (True, self.build_exception(message, e))

    def _next_seq(self) -> int:
        """
        Generate the next sequence number for DAP message correlation.

        Sequence numbers are critical for the DAP protocol as they enable correlation
        between requests and their corresponding responses. Each message that requires
        correlation gets a unique, monotonically increasing sequence number.

        Returns:
            int: A unique sequence number for the next DAP message

        Note:
            Sequence numbers start at 1 and increment for each message. They are
            used to match responses back to their originating requests in async
            communication scenarios.
        """
        # Ensure sequence counter is initialized (defensive programming)
        if not hasattr(self, '_seq_counter'):
            self._seq_counter = 0

        # Increment and return the next sequence number
        self._seq_counter += 1
        return self._seq_counter

    def raise_exception(self, exception: Exception) -> None:
        """
        Log an error message and raise the provided exception.

        This method provides consistent error handling across the DAP implementation,
        ensuring errors are logged before being raised. This is crucial for debugging
        complex DAP communication issues where errors can propagate through multiple
        layers of the protocol stack.

        Args:
            exception (Exception): The exception instance to log and raise. The
                                 exception's string representation will be logged
                                 before the exception is re-raised.

        Raises:
            Exception: The same exception that was passed in (re-raised)

        Usage:
            try:
                await websocket.send(message)
            except ConnectionError as e:
                # This will log the error and re-raise it
                self.raise_exception(e)
        """
        # Log the error message using the standard logging format
        # This ensures all errors are captured in logs before exceptions are raised
        self.debug_message(f'EXCEPTION: {str(exception)}')

        # Get the current exception info to preserve original traceback
        exc_type, exc_value, exc_traceback = sys.exc_info()

        if exc_traceback is not None:
            # Raise the new exception with the original traceback
            raise exception.with_traceback(exc_traceback)
        else:
            # No active exception - just raise the new exception
            raise exception

    def debug_message(self, msg: str) -> None:
        """
        Output a general operational message with the instance's message type prefix.

        This method provides consistent logging format across all DAP implementations,
        making it easier to trace messages and identify their sources in complex
        debugging scenarios involving multiple DAP components (servers, clients,
        transports, etc.).

        Messages logged through this method are intended for general operational
        information such as connection events, state changes, configuration updates,
        and high-level operational status. For detailed protocol-level debugging,
        use show_protocol() instead.

        Args:
            msg (str): The operational message to log. Should be descriptive and
                      provide meaningful context about the operation or state change.

        Log Format:
            [MESSAGE_TYPE]: message_content

        Examples:
            [SERVER-1]: DAP server listening on localhost:5678
            [CLIENT]: Connected to DAP server
            [TRANSPORT]: WebSocket connection established
            [DEBUGPY]: Debugpy client connection accepted from ('127.0.0.1', 60790)

        Debug Level:
            Uses DebugOut level, which is intended for general operational logging
            that provides insight into the DAP component's behavior without overwhelming
            the logs with protocol-specific details.
        """
        # Log with debug output level, including the message type prefix for identification
        if self._call_debug_message:
            self._call_debug_message(f'[{self._msg_type}]: {msg}')

    def debug_protocol(self, packet: str) -> None:
        """
        Output a protocol-level debug message for detailed DAP communication tracing.

        This method is specifically designed for logging raw protocol messages, wire
        format data, and detailed communication traces at a more verbose debug level.
        It's essential for debugging protocol issues, message formatting problems,
        and understanding the detailed flow of DAP communication.

        Protocol messages logged through this method include:
        - Raw JSON DAP messages (requests, responses, events)
        - Wire format details (Content-Length headers, etc.)
        - Protocol state transitions
        - Detailed message parsing and serialization information

        Args:
            packet (str): The protocol message, packet, or detailed trace information
                         to log. This typically includes raw JSON messages, header
                         information, or protocol-specific debugging data.

        Log Format:
            [MESSAGE_TYPE]: protocol_details

        Examples:
            [DEBUGPY]: Sending: {"type": "request", "command": "initialize", ...}
            [SERVER-1]: Received: {"type": "response", "success": true, ...}
            [STDIO]: Received: {"type": "event": "output", ...}

        Debug Level:
            Uses DebugProtocol level, which is a more verbose level specifically
            for protocol debugging. This allows filtering to see only high-level
            operational messages or to dive deep into protocol-level details as needed.

        Use Cases:
            - Debugging message parsing issues
            - Tracing request/response correlation
            - Understanding protocol handshake sequences
            - Analyzing performance of message transmission
            - Troubleshooting wire format compatibility issues
        """
        # Log with protocol debug level for detailed communication tracing
        if self._call_debug_protocol:
            self._call_debug_protocol(f'[{self._msg_type}]: {packet}')

    async def on_event(self, event: Dict[str, Any]) -> None:
        """
        Handle incoming DAP events from the transport layer.

        Override this method to process DAP events like 'stopped', 'output', 'terminated'.
        Call this method when events are received from the connected transport.

        Args:
            event: DAP event message containing type='event' and event-specific data

        Example:
            async def on_event(self, event):
                if event.get('event') == 'stopped':
                    reason = event.get('body', {}).get('reason')
                    self.debug_message(f"Execution stopped: {reason}")
        """
        pass

    async def on_connected(self, connection_info: str) -> None:
        """
        Handle transport connection establishment.

        Override this method to perform initialization when the transport layer
        successfully establishes a connection. Call this method automatically from the transport.

        Args:
            connection_info: String describing the connection (e.g., "localhost:5678")

        Example:
            async def on_connected(self, connection_info):
                self.debug_message(f"Connected to {connection_info}")
                await self.send_initialize_request()
        """
        pass

    async def on_disconnected(self, reason: Optional[str] = None, has_error: bool = False) -> None:
        """
        Handle transport disconnection and cleanup.

        Override this method to perform cleanup when the transport layer disconnects.
        Call this method automatically from the transport when connection is lost or closed.

        Args:
            reason: Optional description of why the disconnection occurred
            has_error: True if disconnection was due to an error, False for normal closure

        Example:
            async def on_disconnected(self, reason=None, has_error=False):
                if has_error:
                    self.debug_message(f"Connection lost due to error: {reason}")
                else:
                    self.debug_message("Connection closed normally")
                await self.cleanup_resources()
        """
        pass

    async def on_connect_error(self, error: Exception) -> None:
        """
        Handle connection attempt failure (e.g. during connect or reconnect).

        Override this method to be notified when a connection attempt fails.
        Used by persist-mode connection logic to report auth or network errors.

        Args:
            error: The exception raised by the failed connection attempt.
        """
        pass

    def did_fail(self, request: Dict[str, Any]) -> bool:
        """
        Check if a DAP request indicates failure based on its response fields.

        This utility method provides a consistent way to check if a DAP message
        represents a failed operation, following the DAP specification for
        error indication. According to the DAP spec, responses indicate success
        or failure through the 'success' field.

        Args:
            request (Dict[str, Any]): The DAP message to check for failure.
                                    Expected to be a response message with
                                    optional 'success' field.

        Returns:
            bool: True if the message indicates failure, False otherwise.

        Note:
            According to DAP spec, a message is considered failed if the 'success'
            field is explicitly set to False. Missing 'success' field is treated
            as success (default behavior). This follows the principle that
            responses are successful unless explicitly marked as failed.
        """
        # Check if 'success' field exists and is explicitly False
        # Missing 'success' field defaults to True (successful)
        return request.get('success', True) is False

    def get_web_response(self, message: Dict[str, Any]) -> Dict[str, Any]:
        """
        Extract the web error details from a DAP request message.

        This utility method provides a consistent way to retrieve error information
        from DAP messages, following the DAP specification for error reporting.
        According to the DAP spec, errors are indicated by the presence of an
        'error' field in the response message.

        Args:
            request (Dict[str, Any]): The DAP message to check for error details.
                                    Expected to be a response message with
                                    optional 'error' field.

        Returns:
            Optional[Dict[str, Any]]: The error details if present, None otherwise.
        """
        try:
            from ai.web import error, response
        except ImportError:
            # Fallback implementation if ai.web is not available
            def error(msg, file=None, lineno=None):
                return {'error': True, 'message': msg, 'file': file, 'lineno': lineno}

            def response(body):
                return {'success': True, 'body': body}

        # Make sure it actually failed
        if message.get('success', True) is not False:
            # Get the response body and return the web response
            body = message.get('body', {})
            return response(body)
        else:
            # Get the specifics about the error
            msg = message.get('message', 'Unknown error')
            trace = message.get('trace', {})
            file = trace.get('file', None)
            lineno = trace.get('lineno', None)

            # Build the error
            return error(msg, file=file, lineno=lineno)

    def build_request(self, command: str, *, token: str = None, arguments: Optional[Dict[str, Any]] = None, data: Union[bytes, str] = None) -> Dict[str, Any]:
        """
        Build a DAP request message following the protocol specification.

        This utility method constructs a properly formatted DAP request message
        that can be sent to a DAP server or forwarded through the protocol stack.
        The request includes all required fields and optional arguments.

        Args:
            command (str): The DAP command to execute (e.g., 'initialize', 'launch',
                         'setBreakpoints'). This should match valid DAP commands.
            arguments (Optional[Dict[str, Any]]): Optional command-specific arguments.
                                                For example, initialize command might
                                                include client capabilities.

        Returns:
            Dict[str, Any]: A complete DAP request message ready for transmission
                          following the DAP specification format.

        DAP Request Format (according to specification):
            {
                "type": "request",
                "seq": <unique_sequence_number>,
                "command": <command_name>,
                "arguments": <optional_command_arguments>
            }

        Example:
            request = self.build_request('setBreakpoints', arguments={
                'source': {'path': '/path/to/file.py'},
                'breakpoints': [{'line': 10}]
            })
        """
        # Build the basic request structure with required DAP fields
        request = {
            'type': 'request',  # DAP message type for requests
            'seq': self._next_seq(),  # Unique sequence for correlation
            'command': command,  # The DAP command to execute
        }

        # Include token for task correlation
        if token is not None:
            request['token'] = token

        # Include command arguments if provided
        if arguments is not None:
            request['arguments'] = arguments

        # Include data payload if provided
        if data is not None:
            if isinstance(data, str):
                request['data'] = data.encode('utf-8')
            elif isinstance(data, bytes):
                request['data'] = data
            else:
                raise ValueError('Data must be a string or bytes')

        return request

    def build_response(self, request: Dict[str, Any], *, body: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """
        Build a successful DAP response message for a given request.

        This method constructs a properly formatted DAP response that correlates
        with the original request through sequence number matching. The response
        follows the DAP specification format and includes all required fields
        for a successful operation.

        Args:
            request (Dict[str, Any]): The original DAP request to respond to.
                                    Must contain 'seq' and 'command' fields for
                                    proper correlation.
            body (Optional[Dict[str, Any]]): Optional response data/payload.
                                           Command-specific response data such as
                                           capabilities, variables, or stack frames.

        Returns:
            Dict[str, Any]: A complete DAP response message ready for transmission
                          following the DAP specification format.

        DAP Response Format (according to specification):
            {
                "type": "response",
                "seq": <unique_sequence_number>,
                "request_seq": <original_request_sequence>,
                "command": <original_command_name>,
                "success": true,
                "body": <optional_response_data>
            }

        Example:
            response = self.build_response(initialize_request, body={
                'supportsConfigurationDoneRequest': True,
                'supportsEvaluateForHovers': True
            })
        """
        # Build the basic response structure with required DAP fields
        response = {
            'type': 'response',  # DAP message type for responses
            'seq': self._next_seq(),  # Unique sequence for this response
            'request_seq': request.get('seq'),  # Reference to original request sequence
            'command': request.get('command'),  # Echo the original command name
            'success': True,  # Indicate successful processing
        }

        # Include response body if provided
        if body is not None:
            response['body'] = body

        return response

    def build_event(self, event: str, *, id: str = None, body: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """
        Build a DAP event message to notify clients of state changes.

        Events are unsolicited messages sent from the debug adapter to the client
        to notify of important state changes like breakpoint hits, process termination,
        output generation, thread creation, etc. Unlike responses, events are not
        correlated with specific requests and can be sent at any time.

        Args:
            event (str): The event name as defined by the DAP specification
                        (e.g., 'stopped', 'output', 'terminated', 'thread',
                        'breakpoint', 'module', 'loadedSource').
            body (Optional[Dict[str, Any]]): Event-specific data payload containing
                                           details about the event. For example,
                                           'stopped' events include reason and thread ID.
            id (str): Optional identifier for the event, useful for correlating
                       events with specific tasks or requests.

        Returns:
            Dict[str, Any]: A complete DAP event message ready for transmission
                          following the DAP specification format.

        DAP Event Format (according to specification):
            {
                "type": "event",
                "seq": <unique_sequence_number>,
                "event": <event_name>,
                "body": <optional_event_data>
            }

        Example:
            event = self.build_event('stopped', body={
                'reason': 'breakpoint',
                'threadId': 1,
                'hitBreakpointIds': [1]
            })
        """
        # Build the basic event structure with required DAP fields
        message = {
            'type': 'event',  # DAP message type for events
            'seq': self._next_seq(),  # Unique sequence for this event
            'event': event,  # Specific event name as per DAP spec
        }

        # Include event body if provided
        if body is not None:
            message['body'] = body

        # Include id if provided, useful for correlating events with tasks
        if id is not None:
            message.setdefault('body', {})
            message['body']['__id'] = id

        return message

    def build_error(self, request: Dict[str, Any], message: str) -> Dict[str, Any]:
        """
        Build a DAP error response.

        Args:
            request (Dict[str, Any]): The original request that caused the error.
                                    Must contain 'seq' and 'command' fields for
                                    proper correlation.
            message (str): Human-readable error description explaining what went
                         wrong and why the request could not be fulfilled.

        Returns:
            Dict[str, Any]: A complete DAP error response with trace information
                          following the DAP specification format.

        DAP Error Response Format (according to specification):
            {
                "type": "response",
                "seq": <unique_sequence_number>,
                "request_seq": <original_request_sequence>,
                "command": <original_command_name>,
                "success": false,
                "message": <error_description>,
            }
        """
        # Build the basic error response structure
        response = {
            'type': 'response',  # DAP message type for responses
            'seq': self._next_seq(),  # Unique sequence for this response
            'request_seq': request.get('seq'),  # Reference to original request sequence
            'command': request.get('command'),  # Echo the original command name
            'success': False,  # Indicate failure
            'message': message,  # Human-readable error description
        }

        try:
            # Get the call stack
            stack = inspect.stack()

            # stack[0] is current function, stack[1] is caller
            caller = stack[1]

            # Get filename and line number from caller frame
            filename = os.path.basename(caller.filename)
            lineno = caller.lineno

            # Put it in the response
            response['trace'] = {'file': filename, 'lineno': lineno}

        except Exception:
            # It is not critical we add these
            pass

        # Return it
        return response

    def build_exception(self, request: Dict[str, Any], e: Exception) -> Dict[str, Any]:
        """
        Build a DAP exception response with debugging information.

        This method creates a properly formatted error response that includes
        not only the error message but also file and line number information
        about where the error originated. This debugging information helps
        developers trace issues in the debug adapter implementation.

        Args:
            request (Dict[str, Any]): The original request that caused the error.
                                    Must contain 'seq' and 'command' fields for
                                    proper correlation.
            e (Exception): The exception that was raised, containing traceback info.

        Returns:
            Dict[str, Any]: A complete DAP error response with trace information
                        following the DAP specification format.
        """
        # Build the basic error response structure
        response = {
            'type': 'response',  # DAP message type for responses
            'seq': self._next_seq(),  # Unique sequence for this response
            'request_seq': request.get('seq'),  # Reference to original request sequence
            'command': request.get('command'),  # Echo the original command name
            'success': False,  # Indicate failure
            'message': str(e),  # Human-readable error description
        }

        # Extract traceback information from the exception
        if hasattr(e, '__traceback__') and e.__traceback__ is not None:
            # Get the traceback from the exception
            tb = e.__traceback__

            # Walk to the end of the traceback to find where the exception actually occurred
            while tb.tb_next is not None:
                tb = tb.tb_next

            # Extract the file and line number where the exception was raised
            filename = tb.tb_frame.f_code.co_filename
            lineno = tb.tb_lineno

            # Add debugging trace information to the response
            response['trace'] = {
                'file': os.path.basename(filename),  # Just filename, not full path for clarity
                'lineno': lineno,  # Line number where error occurred
            }
        else:
            # Fallback: use current call stack if no traceback available
            stack = traceback.extract_stack()
            if len(stack) >= 2:
                filename, lineno, _, _ = stack[-2]  # [-2] is the caller
                response['trace'] = {
                    'file': os.path.basename(filename),
                    'lineno': lineno,
                }

        return response
