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
Service Definitions for RocketRide Client.

This module provides methods to retrieve service (connector) definitions from
the RocketRide server. Service definitions include schemas, UI schemas, and
configuration metadata used for pipeline configuration and validation.

Usage:
    # Get all available service definitions
    services = await client.get_services()
    # services is a dict with 'services' and 'version' keys from the runtime

    # Get a specific service by name
    ocr_schema = await client.get_service('ocr')
    if ocr_schema:
        print('OCR schema:', ocr_schema)
"""

from typing import Dict, Any, Optional

from ..core import DAPClient
from ..types.pipeline import PipelineConfig


class ServicesMixin(DAPClient):
    """
    Provides service definition retrieval for the RocketRide client.

    This mixin adds get_services() and get_service() to fetch connector
    definitions from the server via the DAP rrext_services command.
    Definitions include schemas, UI schemas, and metadata.

    This is automatically included when you use RocketRideClient.
    """

    def __init__(self, **kwargs):
        """Initialize services functionality."""
        super().__init__(**kwargs)

    async def get_services(self) -> Dict[str, Any]:
        """
        Retrieve all available service definitions from the server.

        Returns the full services structure from the runtime, including a
        'services' dict (logical type -> definition) and 'version'.

        Returns:
            Dict containing 'services' (dict of service definitions) and
            'version'. Returns {} if the response has no body.

        Raises:
            RuntimeError: If the server returns an error.
        """
        request = self.build_request(command='rrext_services', arguments={})
        response = await self.request(request)

        if self.did_fail(response):
            error_msg = response.get('message', 'Failed to retrieve services')
            raise RuntimeError(f'Failed to retrieve services: {error_msg}')

        return response.get('body') or {}

    async def get_service(self, service: str) -> Optional[Dict[str, Any]]:
        """
        Retrieve a specific service definition by name.

        Args:
            service: Logical name of the service (e.g. 'ocr', 'embed', 'chat').

        Returns:
            The service definition dict, or None if not found.

        Raises:
            ValueError: If service is empty.
            RuntimeError: If the server returns an error (e.g. service not found).
        """
        if not service:
            raise ValueError('Service name is required')

        request = self.build_request(
            command='rrext_services',
            arguments={'service': service},
        )
        response = await self.request(request)

        if self.did_fail(response):
            error_msg = response.get('message', f"Service '{service}' not found")
            raise RuntimeError(f"Failed to retrieve service '{service}': {error_msg}")

        return response.get('body')

    async def validate(
        self,
        pipeline: PipelineConfig,
        *,
        source: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Validate a pipeline configuration.

        Sends the pipeline to the server for structural validation, checking
        component compatibility, connection integrity, and the resolved
        execution chain.

        Source resolution follows the same logic as :meth:`use`:
        1. Explicit ``source`` parameter (if provided)
        2. ``source`` field inside the pipeline config
        3. Implied source: the single component whose config.mode is 'Source'

        Args:
            pipeline: Pipeline configuration to validate.
            source: Optional override for the source component ID.

        Returns:
            Validation result containing errors, warnings, resolved component,
            and the execution chain.

        Raises:
            RuntimeError: If the server returns a validation error.

        Example:
            result = await client.validate(
                pipeline={'components': [...], 'project_id': '123'},
                source='webhook_1',
            )
        """
        arguments: Dict[str, Any] = {'pipeline': pipeline}
        if source is not None:
            arguments['source'] = source

        request = self.build_request(
            command='rrext_validate',
            arguments=arguments,
        )
        response = await self.request(request)

        if self.did_fail(response):
            error_msg = response.get('message', 'Validation failed')
            raise RuntimeError(f'Pipeline validation failed: {error_msg}')

        return response.get('body') or {}
