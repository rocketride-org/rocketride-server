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
    # services is a dict with 'services', 'icons' and 'version' keys from the engine

    # Get a specific service by name
    ocr_schema = await client.get_service('ocr')
    print('OCR schema:', ocr_schema)
"""

from typing import Dict, Any, Optional

from ..core import DAPClient
from ..types.pipeline import PipelineConfig
from ..types.service import SERVICES_RESPONSE, SERVICE_DEFINITION, VALIDATION_RESULT


class ServicesMixin(DAPClient):
    """
    Provides service definition retrieval for the RocketRide client.

    This mixin adds get_services() and get_service() to fetch connector
    definitions from the server via the DAP rrext_services command.
    get_services() returns lightweight summaries (display fields; each
    summary's 'icon' field is an id into the deduplicated 'icons' SVG
    table); get_service() returns one full definition with the
    configuration schema sections.

    This is automatically included when you use RocketRideClient.
    """

    def __init__(self, **kwargs):
        """Initialize services functionality."""
        super().__init__(**kwargs)

    async def get_services(self) -> SERVICES_RESPONSE:
        """
        Retrieve all service summaries from the server.

        Returns the server's cached catalog: a 'services' dict (logical
        type -> summary), an 'icons' table (icon id -> raw SVG text,
        deduplicated — each summary's 'icon' field is an id into it), and
        'version'. The configuration schema is served by get_service()
        on demand.

        Returns:
            Dict containing 'services', 'icons', and 'version'. Returns
            {} if the response has no body.

        Raises:
            RuntimeError: If the server returns an error.
        """
        return await self.call('rrext_services')

    async def get_service(self, service: str) -> SERVICE_DEFINITION:
        """
        Retrieve a specific service's FULL definition by name.

        The full definition extends the summary with the dynamic
        configuration sections (schema + UI schema per section) used by
        the configure panel.

        Args:
            service: Logical name of the service (e.g. 'ocr', 'embed', 'chat').

        Returns:
            The service definition dict.

        Raises:
            ValueError: If service is empty.
            RuntimeError: If the server returns an error — an unknown
                service name is an error, not an empty result.
        """
        if not service:
            raise ValueError('Service name is required')

        return await self.call('rrext_services', service=service)

    async def validate(
        self,
        pipeline: PipelineConfig,
        *,
        source: Optional[str] = None,
    ) -> VALIDATION_RESULT:
        """
        Validate a pipeline configuration.

        Sends the pipeline to the server for structural validation, checking
        required fields and component references.

        Source resolution follows the same logic as :meth:`use`:
        1. Explicit ``source`` parameter (if provided)
        2. ``source`` field inside the pipeline config
        3. Implied source: the single component whose config.mode is 'Source'

        Args:
            pipeline: Pipeline configuration to validate.
            source: Optional override for the source component ID.

        Returns:
            Validation result containing errors and warnings.

        Raises:
            RuntimeError: If the server returns a validation error.

        Example:
            result = await client.validate(
                pipeline={'components': [...], 'project_id': '123'},
                source='webhook_1',
            )
        """
        try:
            kwargs: Dict[str, Any] = {'pipeline': pipeline}
            if source is not None:
                kwargs['source'] = source

            return await self.call('rrext_validate', **kwargs)
        except Exception as err:
            raise RuntimeError(f'Pipeline validation failed: {err}') from err
