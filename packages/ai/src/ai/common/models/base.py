"""
Base Model Client: Shared WebSocket/DAP client for model proxies.

This module provides the base functionality for communicating with the
model server over WebSocket using DAP protocol.
"""

import hashlib
import json
import sys
import asyncio
import time
from typing import Any, Dict, List, Optional, Tuple

from ai.common.dap import DAPClient, TransportWebSocket
from ai import node as ai_node


class BaseLoader:
    """
    Base class for all model loaders.

    Provides common functionality:
    - Dependency loading (via depends())
    - Model ID generation (hashing identity params)
    - Identity description (human-readable)

    Subclasses must define:
    - LOADER_TYPE: str - unique identifier for loader type
    - _REQUIREMENTS_FILE: str - path to requirements_*.txt file
    - _DEFAULTS: dict - default values for identity params (applied before hashing)
    - _SERVER_PARAMS: set - params to exclude from identity hash

    Subclasses should implement:
    - load(): Load model and return (model, metadata, gpu_index)
    - preprocess(): Prepare inputs for inference
    - inference(): Run model inference
    - postprocess(): Extract and format outputs
    """

    LOADER_TYPE: str = 'base'
    _REQUIREMENTS_FILE: Optional[str] = None
    _dependencies_loaded: bool = False
    _SERVER_PARAMS = {'allocate_gpu', 'exclude_gpus', 'device'}
    _DEFAULTS: dict = {}

    @classmethod
    def _ensure_dependencies(cls) -> None:
        """
        Load pip dependencies for this loader (once only).

        This is called before importing external libraries. It uses the
        depends() function to ensure all required packages are installed.

        Only runs once per loader class - subsequent calls are no-ops.
        This is only needed for local mode; remote mode never imports
        the actual ML libraries.
        """
        if cls._REQUIREMENTS_FILE and not cls._dependencies_loaded:
            import ai.common.torch  # noqa: F401 — side-effect: installs and initialises torch
            from depends import depends

            depends(cls._REQUIREMENTS_FILE)
            cls._dependencies_loaded = True

    @classmethod
    def generate_model_id(cls, model_name: str, **loader_options) -> str:
        """
        Generate unique model ID from model_name + all loader_options.

        Applies defaults so identical configurations produce the same hash.
        For example: Model('tiny') and Model('tiny', language='en') produce
        the same hash if 'en' is the default for language.

        Args:
            model_name: The model name/path
            **loader_options: All loader parameters

        Returns:
            String like 'model_a1b2c3d4e5'
        """
        identity = {
            'loader': cls.LOADER_TYPE,
            'model_name': model_name,
        }

        # Apply defaults first, then overlay provided options
        merged = {**cls._DEFAULTS, **loader_options}

        for k, v in sorted(merged.items()):
            if k not in cls._SERVER_PARAMS and v is not None:
                identity[k] = v if isinstance(v, (bool, int, float, str)) else str(v)

        identity_str = json.dumps(identity, sort_keys=True, separators=(',', ':'))
        hash_digest = hashlib.sha256(identity_str.encode()).hexdigest()[:10]

        return f'model_{hash_digest}'

    @classmethod
    def get_identity_description(cls, model_name: str, **loader_options) -> str:
        """
        Get human-readable description of model identity.

        Args:
            model_name: The model name/path
            **loader_options: All loader parameters

        Returns:
            String like 'model_name (param1=val1, param2=val2)'
        """
        merged = {**cls._DEFAULTS, **loader_options}

        parts = []
        for k, v in sorted(merged.items()):
            if k not in cls._SERVER_PARAMS and v is not None:
                if isinstance(v, bool):
                    parts.append(f'{k}={"yes" if v else "no"}')
                else:
                    parts.append(f'{k}={v}')

        return f'{model_name} ({", ".join(parts)})' if parts else model_name

    @staticmethod
    def load(
        model_name: str,
        device: Optional[str] = None,
        allocate_gpu: Optional[callable] = None,
        exclude_gpus: Optional[List[int]] = None,
        **kwargs,
    ) -> Tuple[Any, Dict[str, Any], int]:
        """Load model - must be implemented by subclasses."""
        raise NotImplementedError('Subclasses must implement load()')

    @staticmethod
    def preprocess(model: Any, inputs: List[Any], metadata: Optional[Dict] = None) -> Dict[str, Any]:
        """Preprocess inputs - must be implemented by subclasses."""
        raise NotImplementedError('Subclasses must implement preprocess()')

    @staticmethod
    def inference(
        model: Any,
        preprocessed: Dict[str, Any],
        metadata: Optional[Dict] = None,
        stream: Optional[Any] = None,
    ) -> Any:
        """Run inference - must be implemented by subclasses."""
        raise NotImplementedError('Subclasses must implement inference()')

    @staticmethod
    def postprocess(
        model: Any,
        raw_output: Any,
        batch_size: int,
        output_fields: List[str],
        **kwargs,
    ) -> List[Dict[str, Any]]:
        """Postprocess outputs - must be implemented by subclasses."""
        raise NotImplementedError('Subclasses must implement postprocess()')


def get_model_server_address() -> Optional[tuple]:
    """
    Extract --modelserver=<address> from command line arguments.

    Accepts:
        --modelserver=5590          -> ('localhost', 5590)
        --modelserver=localhost:5590 -> ('localhost', 5590)
        --modelserver=192.168.1.1:5590 -> ('192.168.1.1', 5590)

    Returns:
        (host, port) tuple if found, None otherwise
    """
    for arg in sys.argv:
        if arg.startswith('--modelserver='):
            try:
                value = arg.split('=')[1]
                if ':' in value:
                    # Full address: host:port
                    host, port_str = value.rsplit(':', 1)
                    return (host, int(port_str))
                else:
                    # Just port number
                    return ('localhost', int(value))
            except (IndexError, ValueError):
                return None
    return None


def get_model_server_port() -> Optional[int]:
    """
    Legacy function - returns just the port number.

    Returns:
        Port number if --modelserver is set, None otherwise
    """
    addr = get_model_server_address()
    return addr[1] if addr else None


class ModelClient:
    """
    Simple DAP client for communicating with model server.

    This class provides a shared connection that multiple threads can use
    concurrently. DAP supports concurrent commands over a single connection.

    Attributes:
        port (int): Model server port
        url (str): WebSocket URL for model server
        client (DAPClient): DAP client for communication
        model_id (Optional[str]): Server-assigned model ID
        metadata (Dict): Model metadata from server
        _model_name (Optional[str]): Model name to load
        _model_type (Optional[str]): Model type
        _model_kwargs (Dict): Model loading arguments
        _connect_lock (asyncio.Lock): Lock for thread-safe connection
    """

    def __init__(self, port: int, host: str = 'localhost'):
        """
        Initialize the model client.

        Args:
            port: Model server port number
            host: Model server host (default: localhost)
        """
        self.port = port
        self.host = host
        self.url = f'ws://{host}:{port}/models'
        self.client: Optional[DAPClient] = None
        self.model_id: Optional[str] = None
        self.metadata: Dict = {}
        self._model_name: Optional[str] = None
        self._model_type: Optional[str] = None
        self._loader_options: Optional[dict] = None
        self._connect_lock = asyncio.Lock()

    def load_model(
        self,
        model_name: str,
        model_type: str,
        loader_options: dict = None,
    ) -> None:
        """
        Connect and load model on server.

        This method handles both connection and model loading in a single
        thread-safe operation. Should be called once during initialization.

        Note: output_fields is NOT passed here - it's a per-request parameter.

        Args:
            model_name: Model name/path
            model_type: Model type ('sentence_transformer', 'transformers', 'whisper', 'piper', ...)
            loader_options: Options passed to the loader (identity + HF params)

        Raises:
            Exception: If connection or model loading fails (no retry)
        """
        # Store model info for reconnection
        self._model_name = model_name
        self._model_type = model_type
        self._loader_options = loader_options

        # Run async operation on global event loop (ai.node.server_loop)
        # This allows synchronous worker threads to safely call async WebSocket operations
        future = asyncio.run_coroutine_threadsafe(self._connect_and_load(), ai_node.server_loop)
        future.result()  # Block until complete

    async def _connect_and_load(self) -> None:
        """
        Connect and load model with retry logic (internal use only).

        Thread-safe method that handles both initial connection and reconnection.
        Uses stored model info from load_model().
        Retries for up to 5 minutes with exponential backoff (max 5 seconds between retries).
        """
        async with self._connect_lock:
            # Double-check if already connected (prevents multiple
            # threads from reconnecting simultaneously)
            if self.client and self.client._transport.is_connected():
                return

            # Retry parameters
            max_total_time = 300  # 5 minutes total
            max_retry_delay = 5.0  # 5 seconds max between retries
            base_delay = 0.5  # Start with 500ms
            start_time = time.time()
            attempt = 0

            while True:
                try:
                    # Clean up old connection if any (reconnection scenario)
                    if self.client:
                        print('[MODEL_CLIENT] Disconnecting old client')
                        try:
                            await self.client.disconnect()
                        except Exception:
                            pass  # Ignore errors during cleanup
                    else:
                        # Create a new client connection
                        print(f'[MODEL_CLIENT] Creating new client for {self.url}')
                        transport = TransportWebSocket(self.url)
                        self.client = DAPClient(module='MODEL_CLIENT', transport=transport)

                    # Clear model ID before reconnection
                    self.model_id = None

                    # Connect (or reconnect) to server
                    print(f'[MODEL_CLIENT] Connecting to {self.url} (attempt {attempt + 1})')
                    await self.client.connect()
                    print('[MODEL_CLIENT] Connected successfully')

                    # Load model on server (if model info is stored)
                    if self._model_name and self._model_type:
                        print(f'[MODEL_CLIENT] Loading {self._model_type} model: {self._model_name}')

                        # Build DAP request with clean structure
                        # Note: output_fields is NOT sent during load - it's per-request
                        arguments = {
                            'model_name': self._model_name,
                            'model_type': self._model_type,
                        }
                        if self._loader_options:
                            arguments['loader_options'] = self._loader_options

                        request = self.client.build_request('load_model', arguments=arguments)
                        result = await self.client.request(request)

                        # Check for errors in response
                        if not result.get('success', True):
                            error_msg = result.get('message', 'Unknown error')
                            raise Exception(f'Model load failed: {error_msg}')

                        # Extract response body
                        body = result.get('body', {})
                        if 'error' in body:
                            raise Exception(f'Model load failed: {body["error"]}')

                        self.model_id = body.get('model_id')
                        if not self.model_id:
                            raise Exception('Model load failed: No model_id returned')

                        self.metadata = body.get('metadata', {})
                        print(f'[MODEL_CLIENT] Model loaded: {self.model_id}')
                    return

                except Exception as e:
                    attempt += 1
                    elapsed = time.time() - start_time

                    # Check if we've exceeded total retry time
                    if elapsed >= max_total_time:
                        print(f'[MODEL_CLIENT] Failed to reconnect after {elapsed:.1f}s: {e}')
                        raise

                    # Calculate exponential backoff delay (capped at max_retry_delay)
                    delay = min(base_delay * (2 ** (attempt - 1)), max_retry_delay)

                    # Don't wait longer than remaining time
                    remaining = max_total_time - elapsed
                    delay = min(delay, remaining)

                    print(f'[MODEL_CLIENT] Connection attempt {attempt} failed: {e}')
                    print(f'[MODEL_CLIENT] Retrying in {delay:.1f}s (elapsed: {elapsed:.1f}s / {max_total_time}s)')

                    await asyncio.sleep(delay)

    def disconnect(self) -> None:
        """Disconnect from model server."""
        # Run async disconnect on global event loop
        future = asyncio.run_coroutine_threadsafe(self._disconnect_async(), ai_node.server_loop)
        future.result()  # Block until complete

    async def _disconnect_async(self) -> None:
        """Disconnect from server asynchronously (internal use only)."""
        async with self._connect_lock:
            # If we have a connection and loaded model
            if self.client and self.model_id:
                # Unload model from server first
                if self.model_id:
                    try:
                        request = self.client.build_request('unload_model', arguments={'model_id': self.model_id})
                        await self.client.request(request)
                    except Exception:
                        pass  # Ignore errors during cleanup

                    # Reset model
                    self.model_id = None

                # Close WebSocket connection
                await self.client.disconnect()

                # Release the client - we will get a new one if we connect again
                self.client = None

    def send_command(self, command: str, arguments: Dict[str, Any], retry_on_error: bool = True) -> Any:
        """
        Send a DAP command to the model server with automatic reconnection.

        Used for inference and other commands (not model loading).

        Args:
            command: Command name
            arguments: Command arguments
            retry_on_error: Whether to attempt reconnection on error (default: True)

        Returns:
            Command response body

        Raises:
            Exception: If command fails and retry_on_error is False, or if retry fails
        """
        # Run async command on global event loop
        future = asyncio.run_coroutine_threadsafe(self._send_command_async(command, arguments, retry_on_error), ai_node.server_loop)
        return future.result()  # Block until complete

    async def _send_command_async(self, command: str, arguments: Dict[str, Any], retry_on_error: bool) -> Any:
        """Send command asynchronously with retry logic (internal use only)."""
        try:
            # Always inject the current model_id into arguments
            # The ModelClient owns the model_id, callers shouldn't need to specify it
            # Use spread operator to create new dict without modifying caller's dict
            request = self.client.build_request(command, arguments={**arguments, 'model_id': self.model_id})
            response = await self.client.request(request)

            # Check if command was successful
            if not response.get('success', True):  # Default to True if 'success' field missing
                error_msg = response.get('message', 'Unknown error')
                raise RuntimeError(f'Command failed: {error_msg}')

            return response.get('body', {})
        except BaseException as e:
            # Catch all exceptions including CancelledError (which inherits from BaseException, not Exception)
            print(f'[MODEL_CLIENT] Command "{command}" failed: {e}')

            # Check if we should attempt reconnection
            if not retry_on_error:
                raise

            # Trigger reconnection
            await self._connect_and_load()

            # Retry the command once after successful reconnection
            print(f'[MODEL_CLIENT] Retrying command "{command}" with model_id={self.model_id}')

            # Inject the current model_id (will be the new one after reconnection)
            # Use spread operator to create new dict without modifying caller's dict
            try:
                request = self.client.build_request(command, arguments={**arguments, 'model_id': self.model_id})
                response = await self.client.request(request)

                # Check if command was successful
                if not response.get('success', True):
                    error_msg = response.get('message', 'Unknown error')
                    raise RuntimeError(f'Command failed: {error_msg}')

                return response.get('body', {})
            except BaseException as retry_error:
                print(f'[MODEL_CLIENT] Command retry after reconnection failed: {retry_error}')
                raise
