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

import os
import io
import threading
from typing import List, Tuple, Any
from rocketlib import IGlobalBase, debug
from ai.common.config import Config

from depends import depends
requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
depends(requirements)

import numpy as np
from PIL import Image

# Import opencv BEFORE img2table to ensure correct package is installed
# img2table internally imports cv2, so this must come first
from ai.common.opencv import cv2  # noqa: F401 - ensures correct opencv

from img2table.ocr.base import OCRInstance


class ModelServerOCR(OCRInstance):
    """
    Custom OCR adapter that routes img2table OCR requests to the model server.
    
    This implements the img2table OCRInstance interface, which requires:
    - content(document: Document) -> list of OCR results per page
    - to_ocr_dataframe(content) -> OCRDataframe
    
    This keeps img2table (OpenCV table detection) on the node while
    offloading the heavy OCR inference to the model server (or local fallback).
    """
    
    def __init__(self, engine: str = 'doctr', languages: List[str] = None):
        """
        Initialize the adapter with a model server OCR engine.
        
        Args:
            engine: OCR engine to use - 'doctr', 'easyocr', or 'surya'
            languages: List of language codes (e.g., ['en', 'fr'])
        """
        self.engine = engine.lower()
        self.languages = languages or ['en']
        self._ocr = None
    
    @property
    def ocr(self):
        """Lazy-load the OCR engine from model server (or local fallback)."""
        if self._ocr is None:
            if self.engine == 'doctr':
                from ai.common.models import DocTR
                self._ocr = DocTR()
            elif self.engine == 'easyocr':
                from ai.common.models import EasyOCR
                self._ocr = EasyOCR(languages=self.languages)
            elif self.engine == 'surya':
                from ai.common.models import Surya
                self._ocr = Surya()
            else:
                raise ValueError(f'Unknown OCR engine: {self.engine}')
            debug(f'ModelServerOCR: Initialized {self.engine} engine')
        return self._ocr
    
    def content(self, document) -> List[List[Tuple]]:
        """
        Perform OCR on all images in the document.
        
        This is called by img2table's OCRInstance.of() method.
        
        Args:
            document: img2table Document object with .images property
            
        Returns:
            List of pages, each page is a list of (bbox, text, confidence) tuples
            Format matches EasyOCR: [[[x1,y1],[x2,y1],[x2,y2],[x1,y2]], text, confidence]
        """
        def _diag(msg):
            pass

        _diag(f'[DIAG] ModelServerOCR.content() called, document type: {type(document)}')
        _diag(f'[DIAG] document.images count: {len(document.images) if hasattr(document, "images") else "N/A"}')
        
        all_results = []
        
        try:
            for idx, image in enumerate(document.images):
                _diag(f'[DIAG] Processing image {idx}, shape: {image.shape}')
                
                # Convert numpy array to bytes for model server
                image_bytes = self._to_bytes(image)
                _diag(f'[DIAG] Converted to {len(image_bytes)} bytes')
                
                # Call model server OCR (or local fallback)
                _diag(f'[DIAG] Calling self.ocr.read() with engine={self.engine}')
                result = self.ocr.read(image_bytes)
                _diag(f'[DIAG] OCR result: {result}')
                
                # Convert to EasyOCR-compatible format
                page_results = self._format_to_easyocr(result, image.shape)
                _diag(f'[DIAG] Page {idx} results: {len(page_results)} items')
                all_results.append(page_results)
                
        except Exception as e:
            import traceback
            _diag(f'[DIAG] ModelServerOCR.content() EXCEPTION: {e}')
            _diag(f'[DIAG] Traceback: {traceback.format_exc()}')
        
        return all_results
    
    def to_ocr_dataframe(self, content: List[List]) -> Any:
        """
        Convert OCR content to OCRDataframe.
        
        Args:
            content: List of pages, each page has list of (bbox, text, confidence) tuples
            
        Returns:
            OCRDataframe object
        """
        from img2table.ocr.data import OCRDataframe
        import polars as pl
        
        def _diag(msg):
            pass
        
        _diag(f'[DIAG] to_ocr_dataframe called, content pages: {len(content)}')
        
        list_elements = []
        
        for page, ocr_result in enumerate(content):
            for idx, word in enumerate(ocr_result):
                # word format: [bbox_points, text, confidence]
                # bbox_points: [[x1,y1],[x2,y1],[x2,y2],[x1,y2]]
                bbox = word[0]
                text = word[1]
                confidence = word[2] if len(word) > 2 else 1.0
                
                # Extract x1, y1, x2, y2 from bbox points
                x_coords = [p[0] for p in bbox]
                y_coords = [p[1] for p in bbox]
                x1, x2 = min(x_coords), max(x_coords)
                y1, y2 = min(y_coords), max(y_coords)
                
                dict_word = {
                    "page": page,
                    "class": "ocrx_word",
                    "id": f"word_{page + 1}_{idx + 1}",
                    "parent": f"word_{page + 1}_{idx + 1}",
                    "value": text,
                    "confidence": round(100 * confidence),
                    "x1": int(x1),
                    "y1": int(y1),
                    "x2": int(x2),
                    "y2": int(y2),
                }
                list_elements.append(dict_word)
        
        _diag(f'[DIAG] Created {len(list_elements)} OCR elements')
        
        if list_elements:
            df = pl.DataFrame(list_elements, schema=self.pl_schema)
        else:
            df = pl.DataFrame(schema=self.pl_schema)
        
        return OCRDataframe(df=df)
    
    def _to_bytes(self, image: np.ndarray) -> bytes:
        """Convert numpy array to PNG bytes."""
        pil_image = Image.fromarray(image)
        buffer = io.BytesIO()
        pil_image.save(buffer, format='PNG')
        return buffer.getvalue()
    
    def _format_to_easyocr(self, result: dict, image_shape: tuple) -> List[Tuple]:
        """
        Convert model server result to EasyOCR-compatible format.
        
        EasyOCR format: [[[x1,y1],[x2,y1],[x2,y2],[x1,y2]], text, confidence]
        
        Args:
            result: OCR result from model server {'text': '...', 'boxes': [...]}
            image_shape: Shape of the input image for default bbox
            
        Returns:
            List of (bbox_points, text, confidence) tuples
        """
        formatted = []
        
        text = result.get('text', '')
        boxes = result.get('boxes', [])
        
        if boxes and isinstance(boxes, list) and len(boxes) > 0:
            for box_info in boxes:
                if isinstance(box_info, dict):
                    bbox = box_info.get('bbox', box_info.get('box', [0, 0, 10, 10]))
                    box_text = box_info.get('text', '')
                    confidence = box_info.get('confidence', 1.0)
                else:
                    continue
                
                # Convert [x1, y1, x2, y2] to [[x1,y1],[x2,y1],[x2,y2],[x1,y2]]
                x1, y1, x2, y2 = bbox[0], bbox[1], bbox[2], bbox[3]
                bbox_points = [[x1, y1], [x2, y1], [x2, y2], [x1, y2]]
                
                formatted.append([bbox_points, box_text, confidence])
        elif text:
            # No boxes but we have text - use full image as bbox
            h, w = image_shape[:2]
            bbox_points = [[0, 0], [w, 0], [w, h], [0, h]]
            formatted.append([bbox_points, text, 1.0])
        
        return formatted


class IGlobal(IGlobalBase):
    def beginGlobal(self):
        # Import what we need
        from .ocr import Reader
        from img2table.document import Image as Img2TableImage

        # Get our bag
        bag = self.IEndpoint.endpoint.bag

        # Get this node's config
        config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)

        # Set up the lock for thread safety
        self.readerLock = threading.Lock()

        # Initialize the OCR reader
        self.reader = Reader(self.glb.logicalType, config, bag)

        self.io = io
        self.Img2TableImage = Img2TableImage
        
        # Get table OCR settings
        # script_family determines languages for EasyOCR, table_engine selects OCR backend
        script_family = config.get('script_family', 'latin')
        table_engine = config.get('table_engine', 'doctr').lower()
        
        # Import script families from ocr module
        from .ocr import SCRIPT_FAMILIES
        languages = SCRIPT_FAMILIES.get(script_family, ['en'])

        # Use ModelServerOCR adapter - routes to model server or local fallback
        self.table_ocr = ModelServerOCR(engine=table_engine, languages=languages)
        debug(f'Initialized table OCR via ModelServerOCR (engine={table_engine}, script_family={script_family})')

    def endGlobal(self):
        self.reader = None
        self.table_ocr = None
