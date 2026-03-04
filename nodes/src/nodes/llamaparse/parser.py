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
from depends import depends  # type: ignore

# Load the requirements
requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
depends(requirements)

from typing import Any, Dict, Optional
from ai.common.reader import ReaderBase
from ai.common.config import Config
from ai.web.metrics import metrics
from rocketlib import debug


class Parser(ReaderBase):
    # Configuration variables
    _parse_mode: Optional[str] = None
    _lvm_model: Optional[str] = None
    _system_prompt_append: Optional[str] = None
    _spreadsheet_extract_sub_tables: bool = False

    # Instance variables
    bag: Dict[str, Any]

    def __init__(self, provider: str, connConfig: Dict[str, Any], bag: Dict[str, Any]):
        """
        Initialize the LlamaParse parser with the given provider, connection configuration, and bag.
        """
        # Init the base
        super().__init__(provider, connConfig, bag)

        # Store the bag explicitly
        self.bag = bag

        debug(f'LlamaParse Parser: Provider: {provider}')
        debug(f'LlamaParse Parser: Raw connConfig: {connConfig}')

        # Get the nodes configuration
        config = Config.getNodeConfig(provider, connConfig)
        debug(f'LlamaParse Parser: Processed config: {config}')

        # Check if config has nested structure
        if 'default' in config:
            debug('LlamaParse Parser: Found nested config structure, extracting from default profile')
            config = config.get('default', {})
            debug(f'LlamaParse Parser: Extracted config: {config}')

        # Get the other configuration values
        self._parse_mode = config.get('parse_mode', None)
        self._lvm_model = config.get('lvm_model', None)

        # Handle system prompt append with checkbox logic
        use_system_prompt_append = config.get('use_system_prompt_append', False)
        if use_system_prompt_append:
            self._system_prompt_append = config.get('system_prompt_append', None)
        else:
            self._system_prompt_append = None

        self._spreadsheet_extract_sub_tables = config.get('spreadsheet_extract_sub_tables', False)

        debug('LlamaParse Parser initialized with:')
        debug(f'    parse_mode:                     {self._parse_mode}')
        debug(f'    lvm_model:                      {self._lvm_model}')
        debug(f'    system_prompt_append:           {self._system_prompt_append}')
        debug(f'    spreadsheet_extract_sub_tables: {self._spreadsheet_extract_sub_tables}')

    def read(self, file) -> str:
        """
        Read and parse document data using LlamaParse.

        This method is required by ReaderBase.

        Args:
            file: Document data in bytes

        Returns:
            str: Parsed text content
        """
        debug(f'LlamaParse read method called with file size: {len(file)} bytes')
        result = self.parse(file)
        if isinstance(result, dict):
            return result.get('text', '')
        return result

    def parse(self, pipe_id: int, file_data: bytes, file_name: Optional[str] = None) -> dict[str, Any]:
        """
        Parse document data using LlamaParse.

        Args:
            file_data: Document data in bytes
            file_name: Optional file name for better parsing

        Returns:
            str: Parsed text content
        """
        debug(f'Starting LlamaParse parsing for file: {file_name or "unknown"}')

        # Validate file_data
        if file_data is None:
            debug('Error: file_data is None, cannot proceed with parsing')
            return {'text': '', 'structured_data': [], 'page_count': 0, 'project_id': None, 'file_id': None, 'parsing_metadata': {}}

        debug(f'File size: {len(file_data)} bytes')

        try:
            # Use the global LlamaParse instance from IGlobal
            debug('Using global LlamaParse instance...')

            # Get the global instance from the bag
            global_instance = self.bag.get('llama_parse')

            parser = global_instance
            debug('Using existing global LlamaParse instance')

            # Parse the document directly from bytes
            debug('Calling LlamaParse to parse document from bytes...')
            try:
                # Pass file_data (bytes) directly to LlamaParse
                # Include file_name in extra_info for proper file type detection
                # LlamaParse requires file_name when processing bytes
                if not file_name:
                    # Try to determine file type from bytes and provide a default name
                    file_name = self._detect_file_type_from_bytes(file_data)
                    debug(f'No file_name provided, using detected type: {file_name}')

                extra_info = {'file_name': file_name}

                # Use safe load data with proper async handling
                # LlamaParse uses asyncio internally and can cause "Event loop is closed" errors
                # when called from main thread - _safe_load_data isolates it in its own thread
                debug(f'Using safe_load_data for file_data: {len(file_data)} bytes, extra_info: {extra_info}')
                parsed_document = self._safe_load_data(parser, file_data, extra_info)
                debug('LlamaParse load_data completed successfully')
            except Exception as e:
                debug(f'LlamaParse load_data error: {str(e)}')
                # Try to get more info about the error
                if hasattr(e, 'response'):
                    debug(f'Error response: {e.response}')
                raise

            # Check if parser has any project-related attributes
            debug(f'Parser attributes: {[attr for attr in dir(parser) if not attr.startswith("_")]}')
            if hasattr(parser, 'project_id'):
                debug(f'Parser project_id: {parser.project_id}')
            if hasattr(parser, 'file_id'):
                debug(f'Parser file_id: {parser.file_id}')
            debug(f'LlamaParse returned {len(parsed_document) if parsed_document else 0} document(s)')

            # Debug the parsed document structure
            if parsed_document:
                debug(f'First document type: {type(parsed_document[0])}')
                debug(f'First document attributes: {dir(parsed_document[0])}')
                if hasattr(parsed_document[0], 'metadata'):
                    debug(f'First document metadata: {parsed_document[0].metadata}')
                if hasattr(parsed_document[0], 'text'):
                    debug(f'First document text length: {len(parsed_document[0].text)}')

            # Extract text content and structured data
            text_content = ''
            structured_data = []
            page_count = 0
            project_id = None
            file_id = None
            parsing_metadata = {}

            if parsed_document and len(parsed_document) > 0:
                # monitorStatus(f'parsed_document: {parsed_document}')
                for doc in parsed_document:
                    # monitorStatus(f'doc: {doc}')
                    text_content += doc.text

                    # Extract structured data if available
                    if hasattr(doc, 'metadata') and doc.metadata:
                        debug(f'Document metadata keys: {list(doc.metadata.keys())}')
                        debug(f'Full document metadata: {doc.metadata}')

                        # Check if there's structured data in metadata
                        if 'structured_data' in doc.metadata:
                            structured_data.extend(doc.metadata['structured_data'])
                        elif 'items' in doc.metadata:
                            structured_data.extend(doc.metadata['items'])

                        # Try to get page count from metadata
                        if 'page_number' in doc.metadata:
                            page_count = max(page_count, doc.metadata['page_number'])
                        elif 'pages' in doc.metadata:
                            page_count = doc.metadata['pages']

                        # Track page count with metrics if we found it
                        if page_count > 0:
                            try:
                                metrics.event(
                                    pipe_id,
                                    {
                                        'llamaparse_pages': int(page_count),
                                        'llamaparse_mode': (self._parse_mode),
                                        'llamaparse_model': (self._lvm_model),
                                    },
                                )
                            except Exception as e:
                                debug(f'Could not record metrics from metadata: \n \n {str(e)}')

                            debug(f'counter llamaparse pages: {page_count}, mode: {self._parse_mode}, model: {self._lvm_model}')

                        # Extract project and file IDs
                        if 'project_id' in doc.metadata:
                            project_id = doc.metadata['project_id']
                            debug(f'Found project_id: {project_id}')

                        if 'file_id' in doc.metadata:
                            file_id = doc.metadata['file_id']
                            debug(f'Found file_id: {file_id}')

                        # Store all metadata for potential use
                        parsing_metadata.update(doc.metadata)
                    else:
                        debug('No metadata found on document')

                # If we couldn't determine page count from metadata, estimate from document count
                if page_count == 0:
                    page_count = len(parsed_document)
                    debug(f'Estimated page count from document count: {page_count}')
                    # Track estimated page count with metrics
                    if page_count > 0:
                        try:
                            metrics.event(
                                pipe_id,
                                {
                                    'llamaparse_pages': int(page_count),
                                    'llamaparse_mode': (self._parse_mode),
                                    'llamaparse_model': (self._lvm_model),
                                },
                            )
                        except Exception as e:
                            debug(f'Could not record metrics from parsing output: \n \n {str(e)}')

                        debug(f'counter llamaparse pages: {page_count}, mode: {self._parse_mode}, model: {self._lvm_model}')

                # text_content = parsed_document[0].text
                debug(f'Extracted text length: {len(text_content)} characters')
                debug(f'Text preview: {text_content[:200]}{"..." if len(text_content) > 200 else ""}')
                debug(f'Extracted {len(structured_data)} structured items')
                debug(f'Parsed {page_count} pages')
                if project_id:
                    debug(f'Project ID: {project_id}')
                if file_id:
                    debug(f'File ID: {file_id}')

                debug(f'parsing_metadata: {parsing_metadata}, structured_data: {structured_data}')

                # Return text, structured data, page count, and metadata
                return {'text': text_content, 'structured_data': structured_data, 'page_count': page_count, 'project_id': project_id, 'file_id': file_id, 'parsing_metadata': parsing_metadata}
            else:
                debug('No text content extracted from document')
                return {'text': '', 'structured_data': [], 'page_count': 0, 'project_id': None, 'file_id': None, 'parsing_metadata': {}}

        except ImportError as e:
            debug(f'Import error: {str(e)}')
            debug('Please install llama-parse: pip install llama-parse==0.3.4')
            return {'text': '', 'structured_data': [], 'page_count': 0, 'project_id': None, 'file_id': None, 'parsing_metadata': {}}
        except Exception as e:
            debug(f'Error parsing document with LlamaParse: {str(e)}')
            return {'text': '', 'structured_data': [], 'page_count': 0, 'project_id': None, 'file_id': None, 'parsing_metadata': {}}

    def _safe_load_data(self, parser, file_data: bytes, extra_info: dict):
        """

        Safely call LlamaParse load_data with proper event loop management.

        Uses a completely isolated thread to avoid event loop conflicts.

        Args:
            parser: LlamaParse parser instance
            file_data: File data in bytes
            extra_info: Extra info dict with file_name.

        Returns:
            Parsed document result.
        """
        import asyncio
        import threading
        import queue

        debug(f'Starting safe load_data for file size: {len(file_data)} bytes')

        # Use a completely isolated thread to run LlamaParse
        # This prevents any event loop conflicts
        result_queue = queue.Queue()
        error_queue = queue.Queue()

        def isolated_llamaparse_call():
            """
            Run LlamaParse in complete isolation.
            """
            try:
                debug('Running LlamaParse in isolated thread')

                # Create a completely new event loop in this thread
                # This ensures no conflicts with existing loops
                loop = asyncio.new_event_loop()
                asyncio.set_event_loop(loop)

                try:
                    # Debug parser configuration
                    debug(f'Parser configuration: parse_mode={getattr(parser, "parse_mode", "default")}, max_pages={getattr(parser, "max_pages", "unlimited")}')
                    debug(f'File data type: {type(file_data)}, size: {len(file_data)} bytes')
                    debug(f'Extra info: {extra_info}')

                    # Configure parser for large files if needed
                    file_size_mb = len(file_data) / (1024 * 1024)
                    if file_size_mb > 50:  # For files larger than 50MB
                        debug(f'Large file detected ({file_size_mb:.1f}MB), adjusting parser settings')
                        # Increase timeout for large files
                        if hasattr(parser, 'job_timeout_in_seconds'):
                            parser.job_timeout_in_seconds = max(600, parser.job_timeout_in_seconds)  # At least 10 minutes
                        if hasattr(parser, 'max_timeout'):
                            parser.max_timeout = max(600, parser.max_timeout)

                    # Run the LlamaParse call
                    result = parser.load_data(file_data, extra_info=extra_info)
                    debug(f'LlamaParse returned: {type(result)}, length: {len(result) if hasattr(result, "__len__") else "N/A"}')

                    if hasattr(result, '__len__') and len(result) == 0:
                        debug('Warning: LlamaParse returned empty result - trying alternative approach')
                        # Try with different configuration
                        try:
                            debug('Attempting alternative parsing with different settings')
                            # Reset some settings that might be causing issues
                            if hasattr(parser, 'max_pages') and parser.max_pages is not None:
                                debug(f'Removing max_pages limit (was {parser.max_pages})')
                                parser.max_pages = None

                            # Try parsing again
                            result = parser.load_data(file_data, extra_info=extra_info)
                            debug(f'Alternative parsing returned: {type(result)}, length: {len(result) if hasattr(result, "__len__") else "N/A"}')
                        except Exception as alt_e:
                            debug(f'Alternative parsing also failed: {str(alt_e)}')

                    result_queue.put(result)
                    debug('LlamaParse completed successfully in isolated thread')
                except RuntimeError as e:
                    if 'Event loop is closed' in str(e):
                        debug(f'Event loop closed error in isolated thread: {str(e)}')
                        debug('This error is expected and can be ignored if processing succeeded')
                        # Don't put this specific error in the error queue
                        # Check if we can still get a result
                        try:
                            # Try to get result again in case it was produced despite the error
                            if not result_queue.empty():
                                debug('Result available despite event loop error')
                            else:
                                debug('No result available, will handle in main thread')
                        except Exception as e:
                            pass
                    else:
                        # Re-raise other RuntimeErrors
                        raise
                finally:
                    # Clean up the event loop
                    loop.close()
                    debug('Cleaned up isolated event loop')

            except Exception as e:
                error_queue.put(e)
                debug(f'Error in isolated LlamaParse call: {str(e)}')

        # Run in a separate thread with timeout
        thread = threading.Thread(target=isolated_llamaparse_call)
        thread.daemon = True
        thread.start()

        # Calculate timeout based on file size
        file_size_mb = len(file_data) / (1024 * 1024)
        if file_size_mb > 500:  # Very large files (>500MB)
            timeout_seconds = 900  # 15 minutes
        elif file_size_mb > 100:  # Medium-large files (>100MB)
            timeout_seconds = 600  # 10 minutes
        else:
            timeout_seconds = 300  # 5 minutes for smaller files

        debug(f'Starting thread with timeout: {timeout_seconds} seconds for {file_size_mb:.1f}MB file')

        # Wait for completion with timeout
        thread.join(timeout=timeout_seconds)

        if thread.is_alive():
            debug(f'LlamaParse call timed out after {timeout_seconds} seconds for {file_size_mb:.1f}MB file')
            debug('Thread is still alive - this may indicate LlamaParse is stuck or processing very slowly')

            # Note: We can't force-kill the thread safely in Python, but we can log the issue
            # The daemon=True ensures the thread won't prevent program exit
            debug('Thread marked as daemon - will not prevent program exit')

            return {'text': '', 'structured_data': [], 'page_count': 0, 'project_id': None, 'file_id': None, 'parsing_metadata': {'error': f'Processing timeout after {timeout_seconds} seconds for {file_size_mb:.1f}MB file'}}

        # Check for errors first
        if not error_queue.empty():
            error = error_queue.get()
            debug(f'LlamaParse error in isolated thread: {str(error)}')
            raise error

        # Get the result
        if not result_queue.empty():
            result = result_queue.get()
            debug('Successfully retrieved result from isolated thread')
            return result
        else:
            debug('No result available from isolated thread')
            return {'text': '', 'structured_data': [], 'page_count': 0, 'project_id': None, 'file_id': None, 'parsing_metadata': {'error': 'No result from isolated processing'}}

    def _detect_file_type_from_bytes(self, file_data: bytes) -> str:
        """
        Detect file type from bytes and return an appropriate filename.

        Args:
            file_data: File data in bytes

        Returns:
            str: Filename with appropriate extension
        """
        if not file_data:
            return 'unknown.pdf'

        # Check file signatures (magic numbers)
        if file_data.startswith(b'%PDF'):
            return 'document.pdf'
        elif file_data.startswith(b'\x50\x4b\x03\x04'):  # ZIP signature (DOCX, XLSX, etc.)
            return 'document.docx'
        elif file_data.startswith(b'\xd0\xcf\x11\xe0'):  # OLE signature (DOC, XLS, etc.)
            return 'document.doc'
        elif file_data.startswith(b'\xff\xd8\xff'):  # JPEG signature
            return 'image.jpg'
        elif file_data.startswith(b'\x89PNG\r\n\x1a\n'):  # PNG signature
            return 'image.png'
        elif file_data.startswith(b'GIF87a') or file_data.startswith(b'GIF89a'):  # GIF signature
            return 'image.gif'
        elif file_data.startswith(b'RIFF') and b'WEBP' in file_data[:12]:  # WebP signature
            return 'image.webp'
        elif file_data.startswith(b'<html') or file_data.startswith(b'<!DOCTYPE html'):
            return 'document.html'
        elif file_data.startswith(b'<?xml'):
            return 'document.xml'
        else:
            # Default to PDF if we can't determine the type
            debug('Could not determine file type from bytes, defaulting to PDF')
            return 'document.pdf'
