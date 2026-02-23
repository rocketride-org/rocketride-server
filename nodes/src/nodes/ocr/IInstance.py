# =============================================================================
# MIT License
# Copyright (c) 2026 RocketRide, Inc.
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
import io
import numpy as np
from PIL import Image
from typing import List
from rocketlib import IInstanceBase, AVI_ACTION, Entry, debug
from ai.common.schema import Doc
from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    def open(self, object: Entry):
        self.image_data = b''  # Reset image data when a new object is opened

    def extract_tables_from_image(self, image_data: bytes, table_callback=None):
        """
        Extract tables from image bytes using img2table and invoke a callback for each table.

        :param image_data: Image in bytes
        :param table_callback: Function to call with each extracted Markdown table
        """
        # Write diagnostics to a file since print() goes to DAP
        def _diag(msg):
            pass
        
        _diag(f'[DIAG] extract_tables_from_image called, image size: {len(image_data)} bytes')
        
        if not hasattr(self.IGlobal, 'table_ocr'):
            _diag('[DIAG] Table OCR not initialized - SKIPPING')
            return

        try:
            _diag(f'[DIAG] table_ocr type: {type(self.IGlobal.table_ocr)}')
            image_stream = self.IGlobal.io.BytesIO(image_data)
            img_doc = self.IGlobal.Img2TableImage(image_stream)
            _diag('[DIAG] Created Img2TableImage, calling extract_tables...')
            tables = img_doc.extract_tables(ocr=self.IGlobal.table_ocr)
            _diag(f'[DIAG] extract_tables returned {len(tables)} tables')

            for idx, table in enumerate(tables):
                _diag(f'[DIAG] Table {idx}: content={table.content is not None}, has_content={bool(table.content)}')
                if not table.content:
                    _diag(f'[DIAG] Table {idx} has no content, skipping')
                    continue

                table_rows = []
                max_columns = 0

                for row_idx in sorted(table.content.keys()):
                    cells = table.content[row_idx]

                    unique_cells = []
                    seen = set()
                    for cell in cells:
                        cell_id = (cell.value, cell.bbox.x1, cell.bbox.y1, cell.bbox.x2, cell.bbox.y2)
                        if cell_id not in seen:
                            seen.add(cell_id)
                            unique_cells.append(cell)

                    sorted_cells = sorted(unique_cells, key=lambda c: c.bbox.x1)
                    widths = [c.bbox.x2 - c.bbox.x1 for c in sorted_cells]
                    avg_width = sum(widths) / len(widths) if widths else 1

                    row = []
                    for cell in sorted_cells:
                        value = str(cell.value).replace('\n', ' ').strip() if cell.value else ''
                        width = cell.bbox.x2 - cell.bbox.x1
                        colspan = max(1, round(width / avg_width))
                        row.extend([value] * colspan)

                    max_columns = max(max_columns, len(row))
                    table_rows.append(row)

                for row in table_rows:
                    if len(row) < max_columns:
                        row.extend([''] * (max_columns - len(row)))

                # Convert to Markdown
                markdown = []
                for i, row in enumerate(table_rows):
                    markdown.append('| ' + ' | '.join(row) + ' |')
                    if i == 0:
                        markdown.append('| ' + ' | '.join(['---'] * len(row)) + ' |')

                markdown_str = '\n'.join(markdown)
                _diag(f'[DIAG] Table {idx} markdown generated ({len(markdown_str)} chars)')

                if table_callback:
                    _diag(f'[DIAG] Calling table_callback with markdown')
                    table_callback(markdown_str)
                else:
                    _diag('[DIAG] No table_callback provided!')

        except Exception as e:
            import traceback
            _diag(f'[DIAG] Table extraction EXCEPTION: {str(e)}')
            _diag(f'[DIAG] Traceback: {traceback.format_exc()}')

    def writeImage(self, action: int, mimeType: str, buffer: bytes):
        # Handle AVI_BEGIN action
        if action == AVI_ACTION.BEGIN:
            self.image_data = buffer  # Initialize the image data with the first chunk

        # Handle AVI_WRITE action (appending chunks of the image)
        elif action == AVI_ACTION.WRITE:
            self.image_data += buffer  # Append the chunk to the existing image data

        # Handle AVI_END action (finalizing the image processing)
        elif action == AVI_ACTION.END:
            if not self.image_data:
                return

            # If the image is a GIF, iterate through the frames and
            # convert each frame to a format readable by OpenCV (e.g., PNG)
            # Text grabbed from each frame will be concatenated into a single string
            # separated by newlines and sent to the text lane
            if mimeType == 'image/gif':
                gif = Image.open(io.BytesIO(self.image_data))
                text_list = []
                try:
                    while True:
                        frame = gif.convert('RGB')
                        frame_np = np.array(frame)
                        with self.IGlobal.readerLock:
                            frame_text = self.IGlobal.reader.read(frame_np)
                        if isinstance(frame_text, list):
                            frame_text = ' '.join(frame_text)
                        text_list.append(frame_text)
                        gif.seek(gif.tell() + 1)
                except EOFError:
                    pass  # End of frames

                text = '\n'.join(text_list)
            else:
                # Acquire the lock before starting the OCR process
                with self.IGlobal.readerLock:
                    text = self.IGlobal.reader.read(self.image_data)

            # Read the tables by OCR model , invoke writeTable
            self.extract_tables_from_image(self.image_data, self.instance.writeTable)

            if isinstance(text, list):
                text = ' '.join(text)

            self.image_data = b''  # Reset image data after the image is processed

            # Write text to text lane
            self.instance.writeText(text)

    def writeDocuments(self, documents: List[Doc]):
        txtdocs: List[Doc] = []

        # Iterate through the documents
        for doc in documents:
            # Ensure the document is an image type
            if doc.type != 'Image':
                raise ValueError('Document type must be "image"')

            # Decode the base64 image
            image_data = base64.b64decode(doc.page_content)

            # Read the text by OCR model
            text = self.IGlobal.reader(image_data)

            # Read the tables by OCR model , invoke writeTable
            self.extract_tables_from_image(image_data, self.instance.writeTable)

            # If we have a listener on our text lane, write the text to it
            if self.instance.hasListener('text'):
                self.writeText(text)

            # If we have a listener on our documents lane, create a new
            # text document and add it to the list
            if self.instance.hasListener('documents'):
                # Create a copy of the document to avoid modifying the original
                txtdoc = doc.model_copy()

                # document is now regular document type instead of image
                txtdoc.type = 'Document'

                # Add the text to the document
                txtdoc.page_content = text

                # Append it
                txtdocs.append(txtdoc)

        # Emit the documents with the read text
        if self.instance.hasListener('documents'):
            self.instance.writeDocuments(txtdocs)

        # Prevent default behavior of writing the image document which
        # is to call the next driver with the document images. If the
        # pipe really wanted the original image documents, it should be
        # connected to the source driver
        return self.preventDefault()
