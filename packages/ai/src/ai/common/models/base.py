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
Base Model Client: Shared client for model server proxies.

ModelClient subclasses RocketRideClient with ws_path='/models' so it
connects to the model server endpoint.  All URI normalisation, protocol
selection (ws vs wss), auth, and reconnection are handled by the SDK.

get_model_server_address() reads --modelserver=<addr> from sys.argv and
returns the raw string — no parsing or URL construction.
"""

import contextlib
import threading
import hashlib
import json
import sys
import asyncio
import time
from typing import Any, Dict, List, Optional, Tuple, Union

from rocketride import RocketRideClient
from ai import node as ai_node


# =============================================================================
# BASE LOADER
# =============================================================================


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
    _REQUIREMENTS_FILE: Optional[Union[str, List[str]]] = None
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
        if cls._dependencies_loaded or not cls._REQUIREMENTS_FILE:
            return

        import ai.common.torch  # noqa: F401
        from depends import depends

        # Accept a single file or an ordered list (e.g. shared base then extras).
        files = [cls._REQUIREMENTS_FILE] if isinstance(cls._REQUIREMENTS_FILE, str) else cls._REQUIREMENTS_FILE
        for req in files:
            depends(req)
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


# =============================================================================
# MODEL SERVER ADDRESS
# =============================================================================


def get_model_server_address() -> Optional[str]:
    """
    Extract --modelserver=<address> from command line arguments.

    Returns the raw address string exactly as provided — no parsing,
    no protocol prefixing.  The RocketRide client SDK handles URI
    normalisation (ws vs wss, default ports, etc.).

    Accepts any format the client SDK understands:
        --modelserver=5590
        --modelserver=localhost:5590
        --modelserver=model.rocketride.dev:443
        --modelserver=wss://model.rocketride.dev:443

    Returns:
        Address string if --modelserver is set, None otherwise.
    """
    for arg in sys.argv:
        if arg.startswith('--modelserver='):
            value = arg.split('=', 1)[1]
            return value if value else None
    return None


def is_model_server_enabled() -> bool:
    """
    True when a model server is configured via ``--modelserver``.

    Reflects configuration only (the flag is set with a non-empty address); it does
    not verify the server is reachable or running.

    Returns:
        True if ``--modelserver=<address>`` is present, False otherwise.
    """
    return bool(get_model_server_address())


def make_device_lock() -> contextlib.AbstractContextManager:
    """Return the device-access guard for the current run mode.

    Local in-process GPU inference must serialize, so this returns a real
    ``threading.Lock``. In proxy mode the model server batches and the DAP transport
    multiplexes concurrent requests, so a node-side lock would only throttle it —
    returns a no-op ``contextlib.nullcontext`` instead.

    Returns:
        A context manager — ``threading.Lock`` locally, ``nullcontext`` when proxying.
    """
    return contextlib.nullcontext() if is_model_server_enabled() else threading.Lock()


# =============================================================================
# MODEL CLIENT
# =============================================================================


class ModelClient(RocketRideClient):
    """
    Client for communicating with the model server.

    Subclasses RocketRideClient with ws_path='/models' so all URI
    normalisation, protocol selection, auth, and transport management
    are inherited from the SDK.

    Adds model-specific functionality:
    - load_model / unload via rrext_ms_load_model / rrext_ms_unload_model
    - send_command with auto-reconnect and model reload on transport errors
    - Metrics recording from server-reported perf counters
    """

    def __init__(self, address: str):
        """
        Initialize the model client.

        Args:
            address: Model server address in any format the client SDK
                     understands (e.g. "5590", "localhost:5590",
                     "model.rocketride.dev:443", "wss://host:443").
        """
        super().__init__(uri=address, module='MODEL_CLIENT', ws_path='/models')
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
            model_type: Model type ('sentence_transformer', 'transformers', 'whisper', 'kokoro')
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
            if self.is_connected():
                return

            # Retry parameters
            max_total_time = 300  # 5 minutes total
            max_retry_delay = 5.0  # 5 seconds max between retries
            base_delay = 0.5  # Start with 500ms
            start_time = time.time()
            attempt = 0

            while True:
                try:
                    # Disconnect old connection if any (reconnection scenario)
                    if self.is_connected():
                        print('[MODEL_CLIENT] Disconnecting old client')
                        try:
                            await super().disconnect()
                        except Exception:
                            pass  # Ignore errors during cleanup

                    # Clear model ID before reconnection
                    self.model_id = None

                    # Connect to server using RocketRideClient.connect()
                    print(f'[MODEL_CLIENT] Connecting to {self._uri} (attempt {attempt + 1})')
                    await super().connect()
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

                        result = await super().request(self.build_request('rrext_ms_load_model', arguments=arguments))

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

    async def _disconnect_async(self) -> None:
        """Disconnect from server, unloading the model first."""
        async with self._connect_lock:
            if self.is_connected() and self.model_id:
                # Unload model from server first
                try:
                    await super().request(
                        self.build_request('rrext_ms_unload_model', arguments={'model_id': self.model_id})
                    )
                except Exception:
                    pass  # Ignore errors during cleanup

                self.model_id = None

            await super().disconnect()

    def disconnect(self) -> None:
        """Disconnect from model server (synchronous).

        Overrides the async RocketRideClient.disconnect() because ModelClient
        callers (model wrappers, tests, OCR cleanup) call disconnect()
        synchronously from worker threads.
        """
        future = asyncio.run_coroutine_threadsafe(self._disconnect_async(), ai_node.server_loop)
        future.result()

    def send_command(self, command: str, arguments: Dict[str, Any], retry_on_error: bool = True) -> Any:
        """
        Send a DAP command to the model server with automatic reconnection.

        Used for inference and other commands (not model loading).
        If the response contains a ``perf`` dict (server-reported timing
        breakdown), it is automatically recorded into the metrics singleton
        via ``metrics.add_time()``.

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
        future = asyncio.run_coroutine_threadsafe(
            self._send_command_async(command, arguments, retry_on_error), ai_node.server_loop
        )
        body = future.result()  # Block until complete

        # Record server-reported perf counters (preprocess, gpu, postprocess,
        # queue_wait, latency) into the metrics singleton — one call covers
        # all model wrappers that go through ModelClient
        perf = body.get('perf') if isinstance(body, dict) else None
        if perf:
            from ai.web.metrics import metrics

            metrics.add_time(perf)

        return body

    async def _send_command_async(self, command: str, arguments: Dict[str, Any], retry_on_error: bool) -> Any:
        """
        Send command asynchronously with retry logic (internal use only).

        Distinguishes between transport errors (connection dropped, WebSocket
        failure) and server-reported errors (valid response with success=false).
        Only transport errors trigger reconnection and retry — server errors
        propagate immediately since retrying the same request won't help.
        """
        try:
            # Send the DAP request over WebSocket.  Transport-level failures
            # (connection dropped, WebSocket error) raise here and are caught
            # by the except below for retry.
            response = await super().request(
                self.build_request(command, arguments={**arguments, 'model_id': self.model_id})
            )
        except BaseException as e:
            # Transport-level failure — reconnect and retry once if allowed
            print(f'[MODEL_CLIENT] Transport error for "{command}": {e}')

            if not retry_on_error:
                raise

            # Reconnect to the model server and reload the model
            await self._connect_and_load()

            # Retry the command once after successful reconnection
            print(f'[MODEL_CLIENT] Retrying command "{command}" with model_id={self.model_id}')
            try:
                response = await super().request(
                    self.build_request(command, arguments={**arguments, 'model_id': self.model_id})
                )
            except BaseException as retry_error:
                print(f'[MODEL_CLIENT] Retry failed for "{command}": {retry_error}')
                raise

        # Check if the server returned an error in the response.
        if not response.get('success', True):
            error_msg = response.get('message', 'Unknown error')
            raise RuntimeError(f'Command failed: {error_msg}')

        return response.get('body', {})
