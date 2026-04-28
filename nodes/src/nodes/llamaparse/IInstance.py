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

import base64
import json
from typing import List, Optional
from rocketlib import IInstanceBase, Entry, debug
from ai.common.schema import Doc
from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    # Private instance variables for internal state
    _current_object: Optional[Entry]
    _current_metadata: Optional[dict]
    _current_text: Optional[str]
    _document_data: bytes
    _target_object_writer: Optional[object]

    def open(self, object: Entry):
        """Call from engLib, process object startup."""
        debug(f'LlamaParse Instance: Opening object {object.fileName if hasattr(object, "fileName") else "unknown"}')
        self._current_object = object
        self._current_metadata = None
        self._current_text = ''
        self._document_data = b''  # Reset document data when a new object is opened
        self._target_object_writer = None
        debug(
            f'LlamaParse Instance: Object opened, size: {object.size if hasattr(object, "size") else "unknown"} bytes'
        )

    def close(self):
        """Call from engLib, process object complete."""
        debug('LlamaParse Instance: Closing object')
        try:
            # Close the target file writer if it is still open for some reason
            if self._target_object_writer:
                self._target_object_writer.close()
                self._target_object_writer = None
                debug('LlamaParse Instance: Closed target object writer')

            if (
                hasattr(self, '_current_object')
                and self._current_object
                and not getattr(self._current_object, 'objectFailed', False)
                and self._document_data
            ):
                debug(f'LlamaParse Instance: Processing document data ({len(self._document_data)} bytes)')

                # Parse the document using LlamaParse
                with self.IGlobal._parserLock:
                    debug('LlamaParse Instance: Acquired parser lock')
                    if self.IGlobal._parser:
                        result = self.IGlobal._parser.parse(
                            pipe_id=self.instance.pipeId,
                            file_data=self._document_data,
                            file_name=self._current_object.fileName,
                        )
                        debug(
                            f'LlamaParse Instance: Parser returned result with keys: {list(result.keys()) if isinstance(result, dict) else "not a dict"}'
                        )
                    else:
                        debug('LlamaParse Instance: No parser available')
                        result = {
                            'text': '',
                            'structured_data': [],
                            'page_count': 0,
                            'project_id': None,
                            'file_id': None,
                            'parsing_metadata': {},
                        }

                        # Extract text and metadata from result
                if isinstance(result, dict):
                    text = result.get('text', '')
                    page_count = result.get('page_count', 0)
                    structured_data = result.get('structured_data', [])
                    project_id = result.get('project_id')
                    file_id = result.get('file_id')
                    parsing_metadata = result.get('parsing_metadata', {})
                    debug(
                        f'LlamaParse Instance: Extracted {len(text)} characters, {page_count} pages, {len(structured_data)} structured items'
                    )
                elif isinstance(result, list):
                    text = ' '.join(result)
                    page_count = 0
                    project_id = None
                    file_id = None
                    parsing_metadata = {}
                    debug('LlamaParse Instance: Converted list to string')
                else:
                    text = str(result) if result else ''
                    page_count = 0
                    project_id = None
                    file_id = None
                    parsing_metadata = {}
                    debug('LlamaParse Instance: Converted result to string')

                # Write text to text lane
                debug('LlamaParse Instance: Writing text to text lane')
                self.instance.writeText(text)

                # Log metadata information
                if page_count > 0:
                    debug(f'LlamaParse Instance: Successfully parsed {page_count} pages')
                if project_id:
                    debug(f'LlamaParse Instance: Project ID: {project_id}')
                if file_id:
                    debug(f'LlamaParse Instance: File ID: {file_id}')
                if parsing_metadata:
                    debug(f'LlamaParse Instance: Parsing metadata keys: {list(parsing_metadata.keys())}')
                    # You could also write this as metadata or to a separate lane if needed

            else:
                debug('LlamaParse Instance: Skipping document processing (no data or object failed)')

        except Exception as e:
            debug(f'LlamaParse Instance: Error processing document: {str(e)}')
            if hasattr(self, '_current_object') and self._current_object:
                self._current_object.completionCode(str(e))

        finally:
            # Clean up
            debug('LlamaParse Instance: Cleaning up object resources')
            self._current_object = None
            self._current_metadata = None
            self._current_text = None
            self._document_data = b''
            self._target_object_writer = None

    def writeTag(self, tag):
        """Process data tags from the tag lane."""
        try:
            # Convert tag ID to string for comparison
            tag_id_str = str(tag.tagId)
            debug(f'LlamaParse Instance: Processing tag: {tag_id_str}')

            # Metadata tag - contains JSON metadata about the object
            if tag_id_str.endswith('OMET'):
                try:
                    # Try to decode as UTF-8 first
                    if hasattr(tag, 'value'):
                        metadata_str = tag.value
                        if isinstance(metadata_str, bytes):
                            # Try UTF-8, fall back to latin-1 if that fails
                            try:
                                metadata_str = metadata_str.decode('utf-8')
                            except UnicodeDecodeError:
                                metadata_str = metadata_str.decode('latin-1', errors='ignore')

                        self._current_metadata = json.loads(metadata_str)
                        debug(
                            f'LlamaParse Instance: Received metadata tag with keys: {list(self._current_metadata.keys()) if self._current_metadata else []}'
                        )
                    else:
                        debug('LlamaParse Instance: OMET tag has no value attribute')
                except (json.JSONDecodeError, UnicodeDecodeError) as e:
                    debug(f'LlamaParse Instance: Could not parse OMET metadata: {e}')
                    self._current_metadata = None

            # Begin tag - start of a data stream
            elif tag_id_str.endswith('SBGN'):
                self._document_data = b''  # reset buffer for new stream
                debug('LlamaParse Instance: Starting new document stream from tag lane')

            # Data tag - binary data chunks
            elif tag_id_str.endswith('SDAT'):
                try:
                    debug('LlamaParse Instance: SDAT tag received - attempting alternative data access methods')

                    # Method 1: Try asBytes property (gets raw tag including header)
                    try:
                        raw_tag_bytes = tag.asBytes
                        tag_size = tag.size
                        debug(
                            f'LlamaParse Instance: Got raw tag bytes: {len(raw_tag_bytes)} total, data size: {tag_size}'
                        )

                        # Skip the TAG header (which is sizeof(TAG)) to get just the data
                        # TAG struct is typically around 16-32 bytes depending on platform
                        header_size = len(raw_tag_bytes) - tag_size
                        if header_size > 0 and len(raw_tag_bytes) >= header_size:
                            data_bytes = raw_tag_bytes[header_size:]
                            self._document_data += data_bytes
                            debug(
                                f'LlamaParse Instance: Successfully extracted {len(data_bytes)} bytes from asBytes (total: {len(self._document_data)})'
                            )
                        else:
                            debug(
                                f'LlamaParse Instance: Invalid tag structure: total={len(raw_tag_bytes)}, data_size={tag_size}'
                            )

                    except Exception as e:
                        debug(f'LlamaParse Instance: asBytes access failed: {e}')

                        # Method 2: Try to get size at least for logging
                        try:
                            tag_size = tag.size
                            debug(
                                f'LlamaParse Instance: SDAT tag with {tag_size} bytes - data access failed but size available'
                            )
                        except Exception as e2:
                            debug(f'LlamaParse Instance: Even size access failed: {e2}')

                except Exception as e:
                    debug(f'LlamaParse Instance: Complete SDAT tag processing failed: {e}')

            # End tag - end of data stream, process the accumulated data
            elif tag_id_str.endswith('SEND'):
                try:
                    if self._document_data and len(self._document_data) > 0:
                        # Try to determine MIME type from metadata or default to generic
                        mime_type = ''
                        if self._current_metadata:
                            mime_type = self._current_metadata.get('Content-Type', '')
                            if not mime_type:
                                mime_type = self._current_metadata.get('dc:format', '')

                        # Process the document data received via tags
                        debug(
                            f'LlamaParse Instance: Processing {len(self._document_data)} bytes from tag lane with MIME type: {mime_type}'
                        )
                        self._process_document(document_data=self._document_data, mime_type=mime_type)
                    else:
                        debug('LlamaParse Instance: No document data to process')

                    self._document_data = b''  # clear buffer
                    debug('LlamaParse Instance: Completed processing tag stream')
                except Exception as e:
                    debug(f'LlamaParse Instance: Error processing document data: {e}')

            # Object begin/end tags - just log them
            elif tag_id_str.endswith('OBEG'):
                debug('LlamaParse Instance: Object processing beginning')
            elif tag_id_str.endswith('OEND'):
                debug('LlamaParse Instance: Object processing ending')

            # Encrypted data tag - not supported
            elif tag_id_str.endswith('OENC'):
                debug('LlamaParse Instance: Encrypted data tags not supported, skipping')

            else:
                debug(f'LlamaParse Instance: Unknown tag type: {tag_id_str}')

        except Exception as e:
            debug(
                f'LlamaParse Instance: Error processing tag {getattr(tag, "tagId", "unknown")}: {type(e).__name__}: {e}'
            )

    def _process_document(self, document_data: bytes, mime_type: str):
        """Process document data using LlamaParse."""
        try:
            debug(f'LlamaParse Instance: Sending document to LlamaParse: {len(document_data)} bytes, MIME: {mime_type}')

            # Parse the document using LlamaParse
            with self.IGlobal._parserLock:
                debug('LlamaParse Instance: Acquired parser lock')
                if self.IGlobal._parser:
                    # For images, ensure we get markdown output
                    if mime_type.startswith('image/'):
                        debug('LlamaParse Instance: Processing image file')
                        # Parse image - result_type is configured in the parser
                        result = self.IGlobal._parser.parse(
                            pipe_id=self.instance.pipeId,
                            file_data=document_data,
                            file_name=self._current_object.fileName,
                        )
                    else:
                        # For documents, use the configured result_type
                        result = self.IGlobal._parser.parse(
                            pipe_id=self.instance.pipeId,
                            file_data=document_data,
                            file_name=self._current_object.fileName,
                        )

                    # Handle both old string format and new dict format
                    if isinstance(result, dict):
                        text = result.get('text', '')
                        structured_data = result.get('structured_data', [])
                        debug(
                            f'LlamaParse Instance: Parser returned structured data with {len(text)} characters and {len(structured_data)} structured items'
                        )
                    else:
                        text = result
                        structured_data = []
                        debug(
                            f'LlamaParse Instance: Parser returned {len(text) if text else 0} characters (legacy format)'
                        )

                    debug(f'LlamaParse Instance: Parser result type: {type(result)}')

                    if text:
                        debug(f'LlamaParse Instance: First 200 chars of result: {str(text)[:200]}')
                else:
                    debug('LlamaParse Instance: No parser available')
                    text = ''
                    structured_data = []

            if isinstance(text, list):
                text = ' '.join(text)
                debug('LlamaParse Instance: Converted list to string')

            # Ensure we have text content
            if not text or len(text.strip()) == 0:
                debug('LlamaParse Instance: No text content extracted, creating fallback message')
                if mime_type.startswith('image/'):
                    text = (
                        f'# Image Processing Result\n\n'
                        f'This image was processed by LlamaParse but no text content was extracted.\n\n'
                        f'**File Type:** {mime_type}\n**File Size:** {len(document_data)} bytes\n\n'
                        f'*Note: This may indicate that the image contains no readable text or the OCR processing was unsuccessful.*'
                    )
                else:
                    text = (
                        f'# Document Processing Result\n\n'
                        f'This document was processed by LlamaParse but no text content was extracted.\n\n'
                        f'**File Type:** {mime_type}\n**File Size:** {len(document_data)} bytes\n\n'
                        f'*Note: This may indicate that the document is empty or the parsing was unsuccessful.*'
                    )

            # Extract tables from the parsed text and structured data
            self.extract_tables_from_text(text)
            self.extract_tables_from_structured_data(structured_data)

            # Write text to text lane
            if self.instance.hasListener('text'):
                debug('LlamaParse Instance: Writing text to text lane')
                self.instance.writeText(text)

            # Create document object for documents lane
            if self.instance.hasListener('documents'):
                debug('LlamaParse Instance: Creating document object')
                from ai.common.schema import Doc, DocMetadata

                # Create metadata
                metadata = DocMetadata(
                    self,
                    chunkId=0,
                    isTable=False,
                    tableId=0,
                    isDeleted=False,
                )

                # Create document
                doc = Doc(type='Document', page_content=text, metadata=metadata)

                # Write document
                self.instance.writeDocuments([doc])
                debug('LlamaParse Instance: Sent document to documents lane')

        except Exception as e:
            debug(f'LlamaParse Instance: LlamaParse processing failed: {type(e).__name__}: {e}')
            import traceback

            debug(f'LlamaParse Instance: Full traceback: {traceback.format_exc()}')

            # Create error message as markdown
            error_text = (
                f'# LlamaParse Processing Error\n\n'
                f'**Error Type:** {type(e).__name__}\n**Error Message:** {str(e)}\n\n'
                f'**File Type:** {mime_type}\n**File Size:** {len(document_data)} bytes\n\n'
                f'*The document could not be processed due to an error in the LlamaParse service.*'
            )

            # Write error message to text lane
            if self.instance.hasListener('text'):
                self.instance.writeText(error_text)

    def extract_tables_from_text(self, text: str):
        """Extract tables from parsed text and write them to the table lane."""
        try:
            debug('LlamaParse Instance: Extracting tables from text')

            # Simple table detection - look for markdown table patterns
            lines = text.split('\n')
            tables = []
            current_table = []
            in_table = False

            for line in lines:
                line = line.strip()

                # Check if line looks like a table row (contains |)
                if '|' in line and len(line.split('|')) > 2:
                    if not in_table:
                        in_table = True
                        current_table = []
                    current_table.append(line)
                elif in_table:
                    # End of table
                    if current_table:
                        tables.append('\n'.join(current_table))
                    current_table = []
                    in_table = False

            # Don't forget the last table
            if in_table and current_table:
                tables.append('\n'.join(current_table))

            debug(f'LlamaParse Instance: Found {len(tables)} potential tables')

            # Write each table to the table lane
            if self.instance.hasListener('table'):
                for i, table in enumerate(tables):
                    debug(f'LlamaParse Instance: Writing table {i + 1} to table lane')
                    self.instance.writeTable(table)

        except Exception as e:
            debug(f'LlamaParse Instance: Error extracting tables: {str(e)}')

    def extract_tables_from_structured_data(self, structured_data: list):
        """Extract tables from structured data and write them to the table lane."""
        try:
            debug(f'LlamaParse Instance: Extracting tables from {len(structured_data)} structured items')

            if not self.instance.hasListener('table'):
                debug('LlamaParse Instance: No table lane listener, skipping table extraction')
                return

            tables_found = 0
            for item in structured_data:
                if isinstance(item, dict) and item.get('type') == 'table':
                    tables_found += 1
                    debug(f'LlamaParse Instance: Found table item {tables_found}')

                    # Convert table to markdown format
                    table_markdown = self._convert_table_to_markdown(item)
                    if table_markdown:
                        debug(f'LlamaParse Instance: Writing structured table {tables_found} to table lane')
                        self.instance.writeTable(table_markdown)

            debug(f'LlamaParse Instance: Processed {tables_found} structured tables')

        except Exception as e:
            debug(f'LlamaParse Instance: Error extracting structured tables: {str(e)}')

    def _convert_table_to_markdown(self, table_item: dict) -> str:
        """Convert a structured table item to markdown format."""
        try:
            if 'rows' not in table_item:
                debug('LlamaParse Instance: Table item missing rows')
                return ''

            rows = table_item['rows']
            if not rows:
                debug('LlamaParse Instance: Table has no rows')
                return ''

            # Convert table to markdown
            markdown_lines = []

            for i, row in enumerate(rows):
                if isinstance(row, list):
                    # Convert row to markdown format
                    row_str = '| ' + ' | '.join(str(cell) for cell in row) + ' |'
                    markdown_lines.append(row_str)

                    # Add separator after header row
                    if i == 0:
                        separator = '| ' + ' | '.join(['---'] * len(row)) + ' |'
                        markdown_lines.append(separator)

            return '\n'.join(markdown_lines)

        except Exception as e:
            debug(f'LlamaParse Instance: Error converting table to markdown: {str(e)}')
            return ''

    def writeText(self, text: str):
        """Call from engLib, process text."""
        if (
            hasattr(self, '_current_object')
            and self._current_object
            and getattr(self._current_object, 'objectFailed', False)
        ):
            debug('LlamaParse Instance: Skipping text processing (object failed)')
            return

        # Append the next text chunk to the whole text
        if text and hasattr(self, '_current_text'):
            if self._current_text is None:
                self._current_text = ''
            self._current_text += text
            debug(
                f'LlamaParse Instance: Appended {len(text)} characters to current text (total: {len(self._current_text)})'
            )

    def writeTable(self, table: str):
        """Call from engLib, process table data."""
        if (
            hasattr(self, '_current_object')
            and self._current_object
            and getattr(self._current_object, 'objectFailed', False)
        ):
            debug('LlamaParse Instance: Skipping table processing (object failed)')
            return

        debug(f'LlamaParse Instance: Processing table with {len(table)} characters')
        # Write table to table lane
        if self.instance.hasListener('table'):
            self.instance.writeTable(table)
            debug('LlamaParse Instance: Wrote table to table lane')

    def writeDocuments(self, documents: List[Doc]):
        """Call from engLib, process document objects."""
        debug(f'LlamaParse Instance: Processing {len(documents)} document objects')
        txtdocs: List[Doc] = []

        # Iterate through the documents
        for i, doc in enumerate(documents):
            debug(f'LlamaParse Instance: Processing document {i + 1}/{len(documents)} of type: {doc.type}')

            # Ensure the document is a supported type
            if doc.type not in ['Document', 'PDF', 'Image']:
                debug(f'LlamaParse Instance: Skipping document of type "{doc.type}" - not supported for parsing')
                continue

            # Decode the base64 document
            if doc.page_content:
                document_data = base64.b64decode(doc.page_content)
                debug(f'LlamaParse Instance: Decoded document data: {len(document_data)} bytes')
            else:
                debug('LlamaParse Instance: Skipping document with empty page_content')
                continue

            # Parse the document using LlamaParse
            with self.IGlobal._parserLock:
                debug('LlamaParse Instance: Acquired parser lock for document object')
                if self.IGlobal._parser:
                    debug(f'LlamaParse Instance: Calling parser for document object: {self._current_object.fileName}')
                    result = self.IGlobal._parser.parse(
                        pipe_id=self.instance.pipeId, file_data=document_data, file_name=self._current_object.fileName
                    )
                    # Handle both old string format and new dict format
                    if isinstance(result, dict):
                        text = result.get('text', '')
                    else:
                        text = result
                    debug(f'LlamaParse Instance: Parser returned {len(text)} characters for document object')
                else:
                    debug('LlamaParse Instance: No parser available for document object')
                    text = ''

            # If we have a listener on our text lane, write the text to it
            if self.instance.hasListener('text'):
                debug('LlamaParse Instance: Writing text to text lane')
                self.writeText(text)

            # If we have a listener on our documents lane, create a new
            # text document and add it to the list
            if self.instance.hasListener('documents'):
                debug('LlamaParse Instance: Creating new document object')
                # Create a copy of the document to avoid modifying the original
                txtdoc = doc.model_copy()

                # document is now regular document type instead of original type
                txtdoc.type = 'Document'

                # Add the parsed text to the document
                txtdoc.page_content = text

                # Append it
                txtdocs.append(txtdoc)
                debug(f'LlamaParse Instance: Added document to output list (total: {len(txtdocs)})')

        # Emit the documents with the parsed text
        if self.instance.hasListener('documents'):
            debug(f'LlamaParse Instance: Emitting {len(txtdocs)} documents to documents lane')
            self.instance.writeDocuments(txtdocs)

        # Prevent default behavior of writing the original documents which
        # is to call the next driver with the document files. If the
        # pipe really wanted the original documents, it should be
        # connected to the source driver
        debug('LlamaParse Instance: Preventing default document behavior')
        return self.preventDefault()
