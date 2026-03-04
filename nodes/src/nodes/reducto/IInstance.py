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
from rocketlib import IInstanceBase, Entry, debug


class IInstance(IInstanceBase):
    """Reducto document processor - handles document parsing and content extraction."""

    def __init__(self):
        """Declare instance attributes; heavy work happens in open/process."""
        super().__init__()
        self.current_object = None
        self.current_metadata = None
        self.current_text = ''
        self.document_data = b''

    def open(self, object: Entry):
        """Call from engLib, process object startup."""
        debug(f'Reducto Instance: Opening object {object.fileName if hasattr(object, "fileName") else "unknown"}')
        self.current_object = object
        self.current_metadata = None
        self.current_text = ''
        self.document_data = b''

    def close(self):
        """Call from engLib, process object complete."""
        debug('Reducto Instance: Closing object')
        try:
            # Only process if we have unprocessed data (not already handled by _process_document)
            if self.current_object and not getattr(self.current_object, 'objectFailed', False) and self.document_data:
                # Process any remaining document data
                self._process_document(self.document_data)
            else:
                debug('Reducto Instance: No unprocessed data to handle')

        except Exception as e:
            debug(f'Reducto Instance: Error in close: {str(e)}')
            if self.current_object:
                self.current_object.completionCode(str(e))

        finally:
            # Clean up
            debug('Reducto Instance: Cleaning up object resources')
            self.current_object = None
            self.current_metadata = None
            self.current_text = None
            self.document_data = b''

    def writeTag(self, tag):
        """Process data tags from the tag lane."""
        # Convert tag ID to string for comparison
        tag_id_str = str(tag.tagId)

        # Metadata tag - contains JSON metadata about the object
        if tag_id_str.endswith('OMET'):
            try:
                if hasattr(tag, 'value'):
                    metadata_str = tag.value

                    if isinstance(metadata_str, bytes):
                        # Try UTF-8, fall back to latin-1 if that fails
                        try:
                            metadata_str = metadata_str.decode('utf-8')
                        except UnicodeDecodeError:
                            metadata_str = metadata_str.decode('latin-1', errors='ignore')
                    self.current_metadata = json.loads(metadata_str)
                    debug(f'Reducto Instance: Metadata loaded: {list(self.current_metadata.keys()) if self.current_metadata else []}')
            except (json.JSONDecodeError, UnicodeDecodeError) as e:
                debug(f'Reducto Instance: Failed to parse metadata: {e}')
                self.current_metadata = None

        # Begin tag - start of a data stream
        elif tag_id_str.endswith('SBGN'):
            self.document_data = b''  # reset buffer for new stream
            debug('Reducto Instance: Starting new document stream from tag lane')

        # Data tag - binary data chunks
        elif tag_id_str.endswith('SDAT'):
            try:
                # Get raw tag bytes including header
                raw_tag_bytes = tag.asBytes
                tag_size = tag.size

                # Skip the TAG header to get just the data
                header_size = len(raw_tag_bytes) - tag_size
                if header_size > 0 and len(raw_tag_bytes) >= header_size:
                    data_bytes = raw_tag_bytes[header_size:]
                    self.document_data += data_bytes
                else:
                    debug(f'Reducto Instance: Invalid SDAT tag structure: total={len(raw_tag_bytes)}, data_size={tag_size}')
            except Exception as e:
                debug(f'Reducto Instance: Error processing SDAT tag: {e}')
                if self.current_object:
                    self.current_object.completionCode(str(e))

        # End tag - end of data stream, process the accumulated data
        elif tag_id_str.endswith('SEND'):
            try:
                if self.document_data and len(self.document_data) > 0:
                    debug(f'Reducto Instance: Processing document data: {len(self.document_data)} bytes')
                    self._process_document(self.document_data)
                else:
                    debug('Reducto Instance: No document data to process')

                self.document_data = b''  # clear buffer
                debug('Reducto Instance: End of document stream')
            except Exception as e:
                debug(f'Reducto Instance: Error processing document data: {e}')
                if self.current_object:
                    self.current_object.completionCode(str(e))

        # Object begin/end tags - no action needed
        elif tag_id_str.endswith('OBEG') or tag_id_str.endswith('OEND'):
            pass

        else:
            debug(f'Reducto Instance: Unexpected tag type: {tag_id_str}')

    def _process_document(self, document_data: bytes):
        """Process document data using Reducto."""
        debug(f'Reducto Instance: Processing document: {len(document_data)} bytes')

        # Get filename from current object
        file_name = self.current_object.fileName if hasattr(self.current_object, 'fileName') else None
        debug(f'Reducto Instance: Calling parser with file: {file_name}')

        # Get active listeners
        has_text_listener = self.instance.hasListener('text')
        has_table_listener = self.instance.hasListener('table')

        # Parse document once and get both text and tables
        text, tables = self.IGlobal.parser.parse(document_data, file_name)

        # Handle text if we have a listener
        if has_text_listener:
            if text:
                self.instance.writeText(text)
            else:
                debug('Reducto Instance: No text content found')

        # Handle tables if we have a listener
        if has_table_listener:
            if tables:
                for i, table in enumerate(tables):
                    debug(f'Reducto Instance: Writing table {i + 1} of {len(tables)}')
                    self.instance.writeTable(table)
            else:
                debug('Reducto Instance: No tables found')

        # Clear document data after successful processing
        self.document_data = b''
        debug('Reducto Instance: Cleared document data after successful processing')
