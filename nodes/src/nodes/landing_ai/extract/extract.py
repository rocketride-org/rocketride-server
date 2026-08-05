# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

import json
import traceback
from typing import Any, Dict, Optional

from rocketlib import debug, warning, error

from ..landing_ai_base import build_client, get_node_config, load_schema_from_data_url, resolve_api_key


class Extractor:
    """Wraps the ADE ``extract`` API: parsed Markdown + JSON Schema -> structured fields."""

    def __init__(self, provider: str, connConfig: Dict[str, Any]):
        """Build the extractor from config; a bad/missing schema is deferred to ``extract()``."""
        config = get_node_config(provider, connConfig)
        self._api_key: Optional[str] = resolve_api_key(config)
        self._region: str = config.get('region') or 'production'
        if self._region not in ('production', 'eu'):
            self._region = 'production'
        self._strict: bool = bool(config.get('strict', False))

        # Capture (don't raise) a schema error here so beginGlobal doesn't crash the
        # whole pipeline on a bad upload; extract() raises it at run time instead.
        self._schema: Dict[str, Any] = {}
        self._schema_error: Optional[str] = None
        try:
            self._schema = load_schema_from_data_url(config.get('schema_file', ''))
        except ValueError as e:
            self._schema_error = str(e)

        debug(
            f'Landing.ai Extract: initialized (strict={self._strict}, region={self._region}, '
            f'schema_error={self._schema_error}, schema_keys={list(self._schema.keys())})'
        )

    def extract(self, markdown: str) -> Any:
        """Run ADE Extract over ``markdown`` -> extracted data.

        Returns ``{}`` when no key is configured or the markdown is empty; a bad
        schema or a failed API call is logged and re-raised.
        """
        if self._schema_error:
            raise ValueError(f'Landing.ai Extract: {self._schema_error}')
        if not self._api_key:
            error('Landing.ai Extract: no API key configured')
            return {}
        if not markdown or not markdown.strip():
            debug('Landing.ai Extract: empty markdown, nothing to extract')
            return {}

        try:
            client = build_client(self._api_key, self._region)
            debug(f'Landing.ai Extract: calling client.extract() ({len(markdown)} chars of markdown)')
            # schema must be a JSON string — a dict gets flattened to multipart keys and 422s.
            response = client.extract(markdown=markdown, schema=json.dumps(self._schema), strict=self._strict)
            return self._map_response(response)
        except Exception as e:  # noqa: BLE001 — log, then re-raise so the failure isn't silently empty
            error(f'Landing.ai Extract: extraction failed: {e}')
            debug(f'Landing.ai Extract: traceback: {traceback.format_exc()}')
            raise

    def _map_response(self, response: Any) -> Any:
        """Pull ``response.extraction`` off an ADE ExtractResponse."""
        extraction = getattr(response, 'extraction', None)

        metadata = getattr(response, 'metadata', None)
        if metadata is not None:
            credit_usage = getattr(metadata, 'credit_usage', None)
            if credit_usage is not None:
                debug(f'Landing.ai Extract: credit usage {credit_usage}')
            warnings = getattr(metadata, 'warnings', None)
            if warnings:
                warning(f'Landing.ai Extract: partial extraction: {warnings}')

        return extraction if extraction is not None else {}
