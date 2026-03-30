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
Pipeline Execution Management for RocketRide Client.

This module provides pipeline execution capabilities including starting, monitoring,
and terminating RocketRide processing pipelines. Pipelines are the core processing
units in RocketRide that handle data transformation, analysis, and AI operations.

Key Features:
- Start pipelines from configuration files or objects
- Monitor pipeline execution status and progress
- Terminate running pipelines when needed
- Support for various pipeline configurations
- Custom arguments and threading options

Usage:
    # Start a pipeline from a configuration file
    token = await client.use(filepath="text_processor.json")

    # Start with custom parameters
    result = await client.use(
        filepath="data_analyzer.json",
        threads=4,
        args=["--verbose", "--output-format=json"]
    )

    # Monitor pipeline status
    status = await client.get_task_status(token)
    print(f"Pipeline state: {status['state']}")

    # Terminate if needed
    await client.terminate(token)
"""

import asyncio
import json
import re
import copy
from typing import Dict, Any, List, Optional
from ..core import DAPClient
from ..types.pipeline import PipelineConfig
from ..types.task import TASK_STATUS

try:
    import json5
except ImportError:
    json5 = None


class ExecutionMixin(DAPClient):
    """
    Provides pipeline execution capabilities for the RocketRide client.

    This mixin adds the ability to start, monitor, and control RocketRide pipelines.
    Pipelines are processing workflows that can handle data transformation,
    analysis, AI operations, and other tasks defined in configuration files.

    Pipeline execution follows this pattern:
    1. Start a pipeline with use() - returns a token
    2. Send data to the pipeline using the token
    3. Monitor progress with get_task_status()
    4. Terminate if needed with terminate()

    This is automatically included when you use RocketRideClient, so you can
    call methods like client.use() and client.get_task_status() directly.
    """

    def __init__(self, **kwargs):
        """Initialize pipeline execution capabilities."""
        super().__init__(**kwargs)

    def _substitute_env_vars(self, value: str) -> str:
        """
        Substitute environment variables in a string.

        Replaces ${ROCKETRIDE_*} patterns with values from client's env dictionary.
        If variable is not found, leaves it unchanged.

        Args:
            value: String that may contain ${ROCKETRIDE_*} patterns

        Returns:
            String with variables replaced (or unchanged if not found)
        """

        def replacer(match):
            var_name = match.group(1)
            # Check if variable exists in client's env
            if hasattr(self, '_env') and var_name in self._env:
                return str(self._env[var_name])
            # If not found, leave as is
            return match.group(0)

        # Match ${ROCKETRIDE_*} patterns
        return re.sub(r'\$\{(ROCKETRIDE_[^}]+)\}', replacer, value)

    def _process_env_substitution(self, obj: Any) -> Any:
        """
        Recursively process an object/list to substitute environment variables.

        Only processes string values, leaving other types unchanged.

        Args:
            obj: Object to process (can be dict, list, str, or any other type)

        Returns:
            Processed object with environment variables substituted
        """
        if isinstance(obj, str):
            # If it's a string, perform substitution
            return self._substitute_env_vars(obj)
        elif isinstance(obj, list):
            # If it's a list, process each element
            return [self._process_env_substitution(item) for item in obj]
        elif isinstance(obj, dict):
            # If it's a dict, process each value
            return {key: self._process_env_substitution(value) for key, value in obj.items()}
        else:
            # For other types (int, float, bool, None), return as is
            return obj

    async def use(
        self,
        *,
        token: str = None,
        filepath: str = None,
        pipeline: Optional[PipelineConfig] = None,
        source: str = None,
        threads: int = None,
        use_existing: bool = None,
        args: List[str] = None,
        ttl: int = None,
        pipelineTraceLevel: str = None,
    ) -> Dict[str, Any]:
        """
        Start an RocketRide pipeline for processing data.

        This is your main method for starting pipelines. Pipelines define how your
        data will be processed - they can analyze text, extract information, perform
        AI operations, transform data formats, and more.

        You can start pipelines from:
        - Configuration files (JSON or JSON5 format, including ``.pipe`` files)
        - Pipeline configuration objects (dictionaries)
        - Both with custom parameters and arguments

        When loading from a file via ``filepath``, the client automatically unwraps
        ``.pipe`` files that use the ``{ "pipeline": { ... } }`` wrapper format. If the
        file contains a top-level ``pipeline`` key, the inner object is extracted;
        otherwise the file content is used as-is.

        When passing a ``pipeline`` dict directly, provide a flat PipelineConfig with
        ``components``, ``source``, and ``project_id`` at the top level — do NOT wrap
        it in ``{ "pipeline": { ... } }``.

        Args:
            token: Custom task token (server generates one if not provided)
            filepath: Path to a ``.pipe`` or JSON/JSON5 pipeline configuration file
            pipeline: Flat PipelineConfig dict (components, source, project_id at top level)
            source: Override the source specified in the pipeline config
            threads: Number of processing threads to use (default: server decides)
            use_existing: Whether to reuse existing pipeline with same token
            args: Command-line style arguments to pass to the pipeline
            ttl: Time-to-live in seconds for idle pipelines (optional, server default
                if not provided; use 0 for no timeout)
            pipelineTraceLevel: Pipeline trace level ('none', 'metadata', 'summary',
                'full'). When set, captures every lane write and invoke call in the
                response under '_trace'.

        Returns:
            Dict containing:
            - token: Task token for sending data and monitoring (str)
            - Additional pipeline startup information

        Raises:
            ValueError: If neither filepath nor pipeline provided, or API key missing
            RuntimeError: If pipeline execution fails to start
            FileNotFoundError: If filepath doesn't exist
            json.JSONDecodeError: If configuration file has invalid JSON

        Example:
            # Start from a .pipe file (wrapper is automatically unwrapped)
            result = await client.use(filepath='chat.pipe')
            token = result['token']

            # Send data to the pipeline
            response = await client.send(token, "Analyze this text")

            # Start with custom parameters
            result = await client.use(
                filepath='data_processor.pipe',
                threads=8,                    # Use 8 processing threads
                args=['--verbose'],           # Enable verbose logging
                source='custom_input'         # Override input source
            )

            # Reuse an existing pipeline
            result = await client.use(filepath='chat.pipe', use_existing=True)

            # Start from a flat Python configuration
            config: PipelineConfig = {
                'project_id': 'e30fee74-0f71-4af2-8dab-5d89deee8f84',
                'source': 'webhook_1',
                'components': [
                    {'id': 'webhook_1', 'provider': 'webhook', 'config': {}},
                    {'id': 'ai_chat_1', 'provider': 'ai_chat', 'config': {'model': 'gpt-4'},
                     'input': [{'from': 'webhook_1', 'lane': 'output'}]},
                    {'id': 'response_1', 'provider': 'response', 'config': {},
                     'input': [{'from': 'ai_chat_1', 'lane': 'answer'}]}
                ]
            }
            result = await client.use(pipeline=config)

        Pipeline Configuration Format (PipelineConfig):
            {
                "source": "entry_component_id",
                "project_id": "unique-guid",
                "components": [
                    {"id": "comp_1", "provider": "webhook", "config": {...}},
                    {"id": "comp_2", "provider": "ai_chat", "config": {...},
                     "input": [{"from": "comp_1", "lane": "output"}]}
                ]
            }

        Tips:
            - JSON5 files support comments and trailing commas for easier editing
            - Use threads parameter for CPU-intensive operations
            - Custom args are passed to pipeline steps that support them
            - The returned token is needed for all data operations with this pipeline
        """
        # Validate required parameters
        if not pipeline and not filepath:
            raise ValueError('Pipeline configuration or file path is required and must be specified')

        # Load pipeline configuration from file if needed
        if not pipeline:

            def _load_pipeline_config(path: str):
                with open(path, 'r', encoding='utf-8') as file:
                    parsed = json5.load(file) if json5 else json.load(file)
                return parsed.get('pipeline', parsed) if isinstance(parsed, dict) else parsed

            try:
                pipeline_config = await asyncio.to_thread(_load_pipeline_config, filepath)
            except FileNotFoundError as err:
                raise FileNotFoundError(f"Pipeline file not found: '{filepath}'. Please provide a valid file path or use inline pipeline configuration.") from err
        else:
            pipeline_config = pipeline

        # Create a deep copy to avoid modifying the original
        processed_config = copy.deepcopy(pipeline_config)

        # Perform environment variable substitution
        processed_config = self._process_env_substitution(processed_config)

        # Override source if specified (after substitution)
        if source is not None:
            processed_config['source'] = source

        # Build execution request with all parameters
        arguments = {
            'apikey': self._apikey,
            'pipeline': processed_config,  # Use processed config with variables substituted
            'args': args or [],  # Default to empty args list
        }

        # Add TTL if provided (server uses its default if not specified)
        if ttl is not None:
            arguments['ttl'] = ttl

        # Add optional parameters if specified
        if token is not None:
            arguments['token'] = token
        if threads is not None:
            arguments['threads'] = threads
        if use_existing is not None:
            arguments['useExisting'] = use_existing
        if pipelineTraceLevel is not None:
            arguments['pipelineTraceLevel'] = pipelineTraceLevel

        # Send execution request to server
        request = self.build_request(command='execute', arguments=arguments)
        response = await self.request(request)

        # Check for execution errors
        if self.did_fail(response):
            error_msg = response.get('message', 'Unknown execution error')
            self.debug_message(f'Pipeline execution failed: {error_msg}')
            raise RuntimeError(error_msg)

        # Extract and validate response
        response_body = response.get('body', {})
        task_token = response_body.get('token', '')

        if not task_token:
            raise RuntimeError('Server did not return a task token in successful response')

        self.debug_message(f'Pipeline execution started successfully, task token: {task_token}')
        return response_body

    async def terminate(self, token: str) -> None:
        """
        Terminate a running pipeline.

        Stops the execution of a pipeline gracefully. The pipeline will complete
        any currently processing items but won't accept new data. Use this when
        you need to stop a long-running or problematic pipeline.

        Args:
            token: Task token of the pipeline to terminate (from use())

        Raises:
            RuntimeError: If termination fails
            ValueError: If token is invalid

        Example:
            # Start a pipeline
            result = await client.use(filepath="long_processor.json")
            token = result['token']

            # Send some data
            await client.send(token, "Process this")

            # Terminate if needed (perhaps user cancelled)
            try:
                await client.terminate(token)
                print("Pipeline terminated successfully")
            except RuntimeError as e:
                print(f"Failed to terminate pipeline: {e}")

        Notes:
            - Termination is graceful - current operations complete
            - The pipeline becomes unusable after termination
            - You'll need to start a new pipeline for further processing
            - Termination is final - pipelines cannot be restarted
        """
        # Send termination request
        request = self.build_request(command='terminate', token=token)
        response = await self.request(request)

        # Check for termination errors
        if self.did_fail(response):
            error_msg = response.get('message', 'Unknown termination error')
            self.debug_message(f'Pipeline termination failed: {error_msg}')
            raise RuntimeError(error_msg)

    async def get_task_status(self, token: str) -> TASK_STATUS:
        """
        Get the current status of a running pipeline.

        Retrieves detailed information about a pipeline's execution state,
        progress, performance metrics, and any errors. Use this to monitor
        long-running pipelines and provide user feedback.

        Args:
            token: Task token of the pipeline to check (from use())

        Returns:
            Dict containing status information:
            - state: Current execution state ('starting', 'running', 'completed', 'failed', etc.)
            - progress: Progress information if available (items processed, percentage, etc.)
            - error: Error message if pipeline failed
            - started_at: When execution started (timestamp)
            - completed_at: When execution finished (timestamp, if completed)
            - performance: Processing speed and resource usage metrics
            - Additional pipeline-specific status data

        Raises:
            RuntimeError: If status retrieval fails
            ValueError: If token is invalid

        Example:
            # Start pipeline and monitor status
            result = await client.use(filepath="data_processor.json")
            token = result['token']

            # Send data to process
            await client.send(token, large_dataset)

            # Monitor until completion
            while True:
                status = await client.get_task_status(token)
                state = status.get('state')

                if state == 'running':
                    progress = status.get('progress', {})
                    print(f"Processing: {progress.get('percentage', 0):.1f}%")
                elif state == 'completed':
                    print("Pipeline completed successfully!")
                    break
                elif state == 'failed':
                    error = status.get('error', 'Unknown error')
                    print(f"Pipeline failed: {error}")
                    break

                await asyncio.sleep(1)  # Check every second

        Status States:
            - 'starting': Pipeline is initializing
            - 'running': Pipeline is actively processing data
            - 'waiting': Pipeline is waiting for more data
            - 'completed': Pipeline finished successfully
            - 'failed': Pipeline encountered an error
            - 'terminated': Pipeline was stopped by user

        Tips:
            - Poll status regularly for long-running operations
            - Check 'progress' field for completion percentage
            - Use 'error' field for detailed error information
            - Performance metrics help optimize pipeline configurations
        """
        # Send status request
        request = self.build_request(command='rrext_get_task_status', token=token)
        response = await self.request(request)

        # Check for status retrieval errors
        if self.did_fail(response):
            error_msg = response.get('message', 'Unknown status retrieval error')
            self.debug_message(f'Pipeline status retrieval failed: {error_msg}')
            raise RuntimeError(error_msg)

        # Return status information
        return response.get('body', {})
