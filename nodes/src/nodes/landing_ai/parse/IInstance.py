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
    """Landing.ai Parse processor — buffers a document from the tag lane and
    extracts Markdown text and tables via ADE.
    """

    def __init__(self):
        """Declare instance attributes; document processing happens in writeTag/close."""
        super().__init__()
        self.current_object = None
        self.current_metadata = None
        self.document_data = b''

    def open(self, obj: Entry):
        """Call from engLib, process object startup."""
        debug(f'Landing.ai Parse: opening object {obj.fileName if hasattr(obj, "fileName") else "unknown"}')
        self.current_object = obj
        self.current_metadata = None
        self.document_data = b''

    def close(self):
        """Call from engLib, process object complete."""
        debug('Landing.ai Parse: closing object')
        try:
            if self.current_object and not getattr(self.current_object, 'objectFailed', False) and self.document_data:
                self._process_document(self.document_data)
            else:
                debug('Landing.ai Parse: no unprocessed data to handle')
        except Exception as e:
            debug(f'Landing.ai Parse: error in close: {str(e)}')
            if self.current_object:
                self.current_object.completionCode(str(e))
        finally:
            self.current_object = None
            self.current_metadata = None
            self.document_data = b''

    def writeTag(self, tag):
        """Process data tags from the tag lane."""
        tag_id_str = str(tag.tagId)

        # Metadata tag - contains JSON metadata about the object
        if tag_id_str.endswith('OMET'):
            try:
                if hasattr(tag, 'value'):
                    metadata_str = tag.value
                    if isinstance(metadata_str, bytes):
                        try:
                            metadata_str = metadata_str.decode('utf-8')
                        except UnicodeDecodeError:
                            metadata_str = metadata_str.decode('latin-1', errors='ignore')
                    self.current_metadata = json.loads(metadata_str)
            except (json.JSONDecodeError, UnicodeDecodeError) as e:
                debug(f'Landing.ai Parse: failed to parse metadata: {e}')
                self.current_metadata = None

        # Begin tag - start of a data stream
        elif tag_id_str.endswith('SBGN'):
            self.document_data = b''
            debug('Landing.ai Parse: starting new document stream')

        # Data tag - binary data chunks
        elif tag_id_str.endswith('SDAT'):
            try:
                raw_tag_bytes = tag.asBytes
                tag_size = tag.size
                header_size = len(raw_tag_bytes) - tag_size
                if header_size > 0 and len(raw_tag_bytes) >= header_size:
                    self.document_data += raw_tag_bytes[header_size:]
                else:
                    debug(
                        f'Landing.ai Parse: invalid SDAT tag structure: total={len(raw_tag_bytes)}, data_size={tag_size}'
                    )
            except Exception as e:
                debug(f'Landing.ai Parse: error processing SDAT tag: {e}')
                if self.current_object:
                    self.current_object.completionCode(str(e))

        # End tag - end of data stream, process the accumulated data
        elif tag_id_str.endswith('SEND'):
            try:
                if self.document_data:
                    self._process_document(self.document_data)
                else:
                    debug('Landing.ai Parse: no document data to process')
                self.document_data = b''
            except Exception as e:
                debug(f'Landing.ai Parse: error processing document data: {e}')
                if self.current_object:
                    self.current_object.completionCode(str(e))

        # Object begin/end tags - no action needed
        elif tag_id_str.endswith('OBEG') or tag_id_str.endswith('OEND'):
            pass

        else:
            debug(f'Landing.ai Parse: unexpected tag type: {tag_id_str}')

    def _process_document(self, document_data: bytes):
        """Parse the accumulated document and write text/tables to their lanes."""
        file_name = self.current_object.fileName if hasattr(self.current_object, 'fileName') else None
        debug(f'Landing.ai Parse: processing document ({len(document_data)} bytes, file={file_name})')

        has_text_listener = self.instance.hasListener('text')
        has_table_listener = self.instance.hasListener('table')

        # Nothing consumes the output → skip the remote call.
        if not has_text_listener and not has_table_listener:
            debug('Landing.ai Parse: no text/table listeners connected; skipping parse')
            self.document_data = b''
            return

        text, tables = self.IGlobal.parser.parse(document_data, file_name)

        if has_text_listener:
            if text:
                self.instance.writeText(text)
            else:
                debug('Landing.ai Parse: no text content found')

        if has_table_listener:
            if tables:
                for i, table in enumerate(tables):
                    debug(f'Landing.ai Parse: writing table {i + 1} of {len(tables)}')
                    self.instance.writeTable(table)
            else:
                debug('Landing.ai Parse: no tables found')

        self.document_data = b''
