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

import os
from typing import Any, Dict, List, Optional, Tuple
from ai.common.reader import ReaderBase
from ai.common.config import Config
from rocketlib import debug


class Parser(ReaderBase):
    """Wraps the LandingAI Agentic Document Extraction (ADE) SDK.

    Keeps IInstance a thin adapter: this module owns the vendor SDK call and the
    response -> (text, tables) shaping, so it is unit-testable without the engine.
    """

    def __init__(self, provider: str, connConfig: Dict[str, Any], bag: Dict[str, Any]):
        """Initialize the parser from the node's configuration."""
        # Init the base
        super().__init__(provider, connConfig, bag)

        # Store the bag explicitly
        self.bag = bag

        # Get the node's configuration
        config = Config.getNodeConfig(provider, connConfig)
        if 'default' in config:
            config = config.get('default', {})

        self._api_key, self._model, self._region = self._resolve_credentials(config)
        debug(
            f'LandingAI ADE Parser initialized (model={self._model}, region={self._region}, '
            f'api_key={"set" if self._api_key else "not set"})'
        )

    @staticmethod
    def _resolve_credentials(config: Dict[str, Any]) -> Tuple[Optional[str], str, str]:
        """Resolve api_key/model/region from config, with env + default fallbacks."""
        api_key = (config.get('api_key') or '').strip() or os.environ.get('VISION_AGENT_API_KEY')
        model = config.get('model') or 'dpt-2-latest'
        region = config.get('region') or 'production'
        if region not in ('production', 'eu'):
            region = 'production'
        return api_key, model, region

    def read(self, file_data: bytes) -> str:
        """Read and parse document data, returning just the text (ReaderBase hook)."""
        text, _tables = self.parse(file_data)
        return text

    def parse(self, file_data: bytes, file_name: Optional[str] = None) -> Tuple[str, List[str]]:
        """Parse a document with LandingAI ADE.

        Returns (markdown_text, [table_markdown, ...]). On any failure the node
        degrades gracefully to ('', []) so it never breaks the pipeline.
        """
        if not self._api_key:
            debug('LandingAI ADE Parser: no API key configured; skipping parse')
            return '', []
        if not file_data:
            debug('LandingAI ADE Parser: empty document data; nothing to parse')
            return '', []

        # ADE infers the document type from the filename; sniff one if absent.
        if not file_name:
            file_name = self._detect_file_type_from_bytes(file_data)

        try:
            # Imported here (not at module top) so the vendor SDK is only required
            # at runtime, after requirements.txt has been installed.
            from landingai_ade import LandingAIADE

            # A fresh client per parse keeps concurrent instances independent.
            client = LandingAIADE(apikey=self._api_key, environment=self._region)
            response = client.parse(document=(file_name, file_data), model=self._model)
        except Exception as e:
            debug(f'LandingAI ADE Parser: parse failed: {type(e).__name__}: {str(e)}')
            return '', []

        return self.extract_content(response)

    def extract_content(self, response: Any) -> Tuple[str, List[str]]:
        """Shape an ADE ParseResponse into (full markdown text, [table markdown, ...])."""
        text = getattr(response, 'markdown', '') or ''

        tables: List[str] = []
        for chunk in getattr(response, 'chunks', None) or []:
            chunk_type = (getattr(chunk, 'type', '') or '').lower()
            if chunk_type == 'table':
                markdown = (getattr(chunk, 'markdown', '') or '').strip()
                if markdown:
                    tables.append(markdown)

        debug(f'LandingAI ADE Parser: extracted {len(text)} chars of text, {len(tables)} table(s)')
        return text, tables

    def _detect_file_type_from_bytes(self, file_data: bytes) -> str:
        """Best-effort filename (with extension) from magic bytes.

        ADE infers the document type from the filename, so when an upstream
        source provides bytes with no name we sniff a sensible extension.
        """
        if not file_data:
            return 'document.pdf'
        if file_data.startswith(b'%PDF'):
            return 'document.pdf'
        if file_data.startswith(b'\x50\x4b\x03\x04'):  # ZIP (DOCX/XLSX/PPTX)
            return 'document.docx'
        if file_data.startswith(b'\xd0\xcf\x11\xe0'):  # OLE (legacy DOC/XLS)
            return 'document.doc'
        if file_data.startswith(b'\xff\xd8\xff'):  # JPEG
            return 'image.jpg'
        if file_data.startswith(b'\x89PNG\r\n\x1a\n'):  # PNG
            return 'image.png'
        if file_data.startswith(b'GIF87a') or file_data.startswith(b'GIF89a'):  # GIF
            return 'image.gif'
        if file_data.startswith(b'RIFF') and b'WEBP' in file_data[:12]:  # WebP
            return 'image.webp'
        if file_data.startswith(b'II*\x00') or file_data.startswith(b'MM\x00*'):  # TIFF
            return 'image.tiff'
        # Default to PDF when the type cannot be determined.
        return 'document.pdf'
