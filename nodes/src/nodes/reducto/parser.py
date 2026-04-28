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

from typing import Any, Dict, Optional, List
from ai.common.reader import ReaderBase
from ai.common.config import Config
from rocketlib import debug


class Parser(ReaderBase):
    """Parser class for Reducto document processing.

    This class handles the core interaction with Reducto's API endpoints for:
    - Document uploading
    - OCR and text extraction
    - Table detection and parsing
    """

    def __init__(self, provider: str, connConfig: Dict[str, Any], bag: Dict[str, Any]):
        """Initialize the Reducto parser with provider, connection config, and bag.

        Args:
            provider: The provider identifier
            connConfig: Connection configuration dictionary
            bag: Shared resource bag from the endpoint
        """
        # Init the base
        super().__init__(provider, connConfig, bag)

        # Store the bag explicitly
        self.bag = bag

        # Get the nodes configuration
        self.config = Config.getNodeConfig(provider, connConfig)

        # Check if config has nested structure
        if 'default' in self.config:
            debug('Reducto Parser: Found nested config structure, extracting from default profile')
            self.config = self.config.get('default', {})
            debug(f'Reducto Parser: Extracted config: {self.config}')

        # Get configuration values
        self._api_key = self.config.get('api_key')
        self._parse_mode = self.config.get('parse_mode', False)  # False = Simple, True = Advanced

        # Track whether figure summarization was requested for this parser instance
        self._summarize_text = False

        debug(
            f'Reducto Parser initialized with parse_mode: {"Advanced" if self._parse_mode else "Simple"}, api_key: {"set" if self._api_key else "not set"}'
        )

    def read(self, file_data: bytes) -> str:
        """Read and parse document data using Reducto.

        This method is required by ReaderBase.

        Args:
            file_data: Document data in bytes

        Returns:
            str: Parsed text content
        """
        debug(f'Reducto read method called with file size: {len(file_data)} bytes')
        text, _tables = self.parse(file_data)
        return text

    def parse(self, file_data: bytes, file_name: Optional[str] = None) -> tuple[str, List[str]]:
        """Parse document data using Reducto API.

        Args:
            file_data: Document data in bytes
            file_name: Optional file name for better parsing

        Returns:
            Tuple containing (text, tables)
        """
        debug(f'Reducto Parser: parse() called with file_size={len(file_data)} bytes, file_name={file_name}')
        try:
            # Create a new Reducto client per parse to enable safe concurrency
            from reducto import Reducto

            if not self._api_key:
                debug('Reducto Parser: ERROR - No API key!')
                return '', []

            reducto = Reducto(api_key=self._api_key)
            upload = reducto.upload(file=(file_name, file_data))
            debug(f'Reducto Parser: Upload successful, upload object: {type(upload)}')

            # SDK 0.13.0 API: only accepts 'input' and 'enhance' as top-level parameters.
            # All advanced behavior must be expressed via the 'enhance' dictionary.
            enhance_options = {}

            if self._parse_mode:
                debug('Reducto Parser: Using Advanced mode configuration')
                import ast

                # In Advanced mode, user provides raw Python dictionaries which we
                # merge directly into the enhance_options bag.
                if self.config.get('options'):
                    user_options = ast.literal_eval(self.config.get('options'))
                    if isinstance(user_options, dict):
                        enhance_options.update(user_options)

                if self.config.get('advanced_options'):
                    user_advanced_options = ast.literal_eval(self.config.get('advanced_options'))
                    if isinstance(user_advanced_options, dict):
                        enhance_options.update(user_advanced_options)

                if self.config.get('experimental_options'):
                    user_experimental_options = ast.literal_eval(self.config.get('experimental_options'))
                    if isinstance(user_experimental_options, dict):
                        enhance_options.update(user_experimental_options)

            else:
                debug('Reducto Parser: Using Simple mode configuration')

                # 1. OCR settings
                if self.config.get('Contains_Handwritten_Text'):
                    enhance_options['ocr_mode'] = 'agentic'
                    debug('Reducto Parser: Enabled agentic OCR mode for handwritten text')

                if self.config.get('Contains_Non_English_Text'):
                    enhance_options['ocr_system'] = 'multilingual'
                    debug('Reducto Parser: Enabled multilingual OCR system')

                # 2. AI Figure/Image summarization
                summarize_text = bool(
                    self.config.get('Summarize_Text') or self.config.get('reducto.Summarize_Text', False)
                )
                enhance_options['summarize_figures'] = summarize_text
                # SDK 0.13.0 doesn't support table summaries effectively, disable it
                enhance_options['summarize_tables'] = False

                if summarize_text:
                    debug('Reducto Parser: Enabled AI figure/image summarization')

            # Cache what we decided for use in extract_content()
            self._summarize_text = bool(enhance_options.get('summarize_figures', False))

            # Build the API call parameters
            debug('Reducto Parser: Calling reducto.parse.run() with SDK 0.13.0 API...')

            # Get file_id from upload object
            file_id = getattr(upload, 'file_id', upload) if hasattr(upload, 'file_id') else upload

            # Build parse_kwargs with only 'input' and 'enhance' (if enabled)
            parse_kwargs = {
                'input': file_id,
            }

            # Add enhance parameter if we have any options
            if enhance_options:
                parse_kwargs['enhance'] = enhance_options
                debug(f'Reducto Parser: Including enhance parameter: {enhance_options}')

            debug(
                f'Reducto Parser: API call parameters: input={file_id}, enhance={enhance_options if enhance_options else "None"}'
            )

            try:
                parse_result = reducto.parse.run(**parse_kwargs)
                debug('Reducto Parser: parse.run() completed successfully!')
            except Exception as e:
                debug(f'Reducto Parser: Error calling parse.run(): {e}')
                import traceback

                debug(f'Reducto Parser: Exception traceback: {traceback.format_exc()}')
                raise

            debug('Reducto Parser: Extracting content from API response...')
            text_content, table_content = self.extract_content(parse_result)
            debug(
                f'Reducto Parser: extract_content() completed. Text length: {len(text_content)}, Tables: {len(table_content)}'
            )
            return text_content, table_content

        except Exception as e:
            debug(f'Error parsing document with Reducto: {str(e)}')
            import traceback

            debug(f'Full traceback: {traceback.format_exc()}')
            return '', []

    def extract_content(self, parse_response: Any) -> tuple[str, List[str]]:
        """Extract text and table content from parse result.

        Args:
            parse_response: ParseResponse object from Reducto API

        Returns:
            Tuple containing:
            - str: Full markdown text including all content
            - List[str]: List of just the table blocks
        """
        debug('Extracting content from parse result')

        try:
            if hasattr(parse_response, 'result'):
                result = parse_response.result

                if hasattr(result, 'chunks'):
                    chunks = result.chunks
                    debug(f'Reducto Parser: Processing {len(chunks) if chunks else 0} chunk(s)')

                    text_parts = []  # For full text content (including summaries)
                    tables = []  # For just tables

                    for i, chunk in enumerate(chunks):
                        if hasattr(chunk, 'blocks') and chunk.blocks:
                            # Log block types for this chunk (useful for debugging)
                            block_types_in_chunk = [
                                getattr(b, 'type', 'unknown') for b in chunk.blocks if hasattr(b, 'type')
                            ]
                            debug(f'Reducto Parser: Chunk {i} block types: {block_types_in_chunk}')
                            block_texts = []

                            for j, block in enumerate(chunk.blocks):
                                # Require both type and content to be present
                                if not hasattr(block, 'type') or not hasattr(block, 'content'):
                                    continue

                                block_type_raw = getattr(block, 'type', None)
                                block_type = (block_type_raw or '').lower() if block_type_raw else ''
                                content = (getattr(block, 'content', '') or '').strip()

                                if not content:
                                    continue

                                # Handle different block types with appropriate spacing
                                if block_type == 'table':
                                    # Tables are both collected separately and included in the text stream
                                    tables.append(content)
                                    block_texts.append(f'\n{content}\n')
                                # Figure / image summaries provided by Reducto's AI
                                elif block_type == 'figure' or block_type_raw == 'Figure':
                                    if self._summarize_text:
                                        block_texts.append(f'\n[DIAGRAM/IMAGE SUMMARY]: {content}\n')
                                    else:
                                        block_texts.append(f'{content}\n')
                                elif block_type == 'title':
                                    block_texts.append(f'# {content}\n')
                                elif block_type == 'section_header':
                                    block_texts.append(f'\n## {content}\n')
                                elif block_type == 'list_item':
                                    block_texts.append(f'- {content}')
                                else:
                                    block_texts.append(f'{content}\n')

                            if block_texts:
                                # Join blocks with appropriate spacing
                                text = ''.join(block_texts).strip()
                                text_parts.append(text)

                    # Combine chunks with clear separation
                    if text_parts:
                        combined = '\n\n'.join(text_parts)
                        # Clean up any excessive newlines
                        import re

                        combined = re.sub(r'\n{3,}', '\n\n', combined)
                        debug(f'Combined text: {combined}')
                    else:
                        combined = ''
                        debug('No text content found')

                    for i, table in enumerate(tables, 1):
                        debug(f'\n--- Table {i} ---\n{table}')

                    debug(f'Reducto Parser: Extracted {len(combined)} chars of text, {len(tables)} table(s)')
                    return combined, tables
                else:
                    debug('No chunks attribute found in result')
            else:
                debug('No result attribute found')
        except Exception as e:
            debug(f'Error extracting content: {str(e)}')
            import traceback

            debug(f'Full traceback: {traceback.format_exc()}')

        return '', []
