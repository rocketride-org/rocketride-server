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

import traceback
from typing import Any, Dict, List, Optional, Tuple

from ai.common.reader import ReaderBase
from ai.common.utils import guess_filename
from rocketlib import debug, warning, error

from ..landing_ai_base import build_client, get_node_config, resolve_api_key


class Parser(ReaderBase):
    """Wraps the ADE ``parse`` API: document bytes -> (Markdown text, tables)."""

    def __init__(self, provider: str, connConfig: Dict[str, Any], bag: Dict[str, Any]):
        """Build the parser from the node config (api_key, model, region)."""
        super().__init__(provider, connConfig, bag)
        self.bag = bag

        config = get_node_config(provider, connConfig)
        self._api_key: Optional[str] = resolve_api_key(config)
        self._model: str = config.get('model') or 'dpt-2-latest'
        self._region: str = config.get('region') or 'production'
        if self._region not in ('production', 'eu'):
            self._region = 'production'

        debug(
            f'Landing.ai Parse: initialized (model={self._model}, region={self._region}, '
            f'api_key={"set" if self._api_key else "not set"})'
        )

    def read(self, file_data: bytes) -> str:
        """Return only the Markdown text (ReaderBase hook)."""
        text, _tables = self.parse(file_data)
        return text

    def parse(self, file_data: bytes, file_name: Optional[str] = None) -> Tuple[str, List[str]]:
        """Parse ``file_data`` with ADE -> (markdown, tables).

        Returns ("", []) when no key is configured or the document is empty; a
        parse failure is logged and re-raised. ADE infers the type from
        ``file_name``; a name is sniffed from the bytes when absent.
        """
        if not self._api_key:
            error('Landing.ai Parse: no API key configured')
            return '', []
        if not file_data:
            debug('Landing.ai Parse: empty document data; nothing to parse')
            return '', []

        # ADE infers the type from the filename; sniff one when absent.
        if not file_name:
            file_name = guess_filename(file_data, 'pdf')

        try:
            client = build_client(self._api_key, self._region)
            debug(f'Landing.ai Parse: calling client.parse() ({len(file_data)} bytes, name={file_name})')
            response = client.parse(document=(file_name, file_data), model=self._model)
            return self._map_response(response)
        except Exception as e:  # noqa: BLE001 — log, then re-raise so the failure isn't silently empty
            error(f'Landing.ai Parse: error parsing document: {e}')
            debug(f'Landing.ai Parse: traceback: {traceback.format_exc()}')
            raise

    def _map_response(self, response: Any) -> Tuple[str, List[str]]:
        """Map an ADE ParseResponse to (markdown, [table blocks])."""
        text = getattr(response, 'markdown', '') or ''

        tables: List[str] = []
        for chunk in getattr(response, 'chunks', None) or []:
            chunk_type = (getattr(chunk, 'type', '') or '').lower()
            chunk_md = getattr(chunk, 'markdown', '') or ''
            if chunk_type == 'table' and chunk_md.strip():
                tables.append(chunk_md)

        metadata = getattr(response, 'metadata', None)
        if metadata is not None:
            credit_usage = getattr(metadata, 'credit_usage', None)
            if credit_usage is not None:
                debug(f'Landing.ai Parse: credit usage {credit_usage}')
            failed_pages = getattr(metadata, 'failed_pages', None)
            if failed_pages:
                warning(f'Landing.ai Parse: some pages failed to parse: {failed_pages}')

        debug(f'Landing.ai Parse: extracted {len(text)} chars of text, {len(tables)} table(s)')
        return text, tables
