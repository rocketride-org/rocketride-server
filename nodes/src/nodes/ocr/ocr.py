# =============================================================================
# MIT License
# Copyright (c) 2024 RocketRide Inc.
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

"""
OCR Reader Module.

Uses ai.common.models OCR wrappers for model server compatibility.
Supports EasyOCR, DocTR, Surya, and TrOCR engines.
"""

import io
from typing import Any, Dict, List

import numpy as np
from PIL import Image

from ai.common.reader import ReaderBase
from ai.common.config import Config
from ai.common.models import EasyOCR, DocTR, Surya, TrOCR
from rocketlib import debug


# Script families with EasyOCR-supported languages
# Reference: https://www.jaided.ai/easyocr/
SCRIPT_FAMILIES = {
    'latin': ['en'],  # Default: English only for reliability
    'latin-extended': [
        'en', 'fr', 'de', 'es', 'it', 'pt', 'nl', 'pl', 'ro', 'cs', 'sk',
        'hu', 'hr', 'sl', 'sq', 'lt', 'lv', 'da', 'no', 'sv', 'id', 'ms',
        'tl', 'vi', 'tr', 'az', 'uz', 'sw', 'la', 'oc',
    ],
    'cyrillic': ['ru', 'uk', 'be', 'bg', 'sr', 'mk', 'mn', 'en'],
    'arabic': ['ar', 'fa', 'ur', 'ug', 'en'],
    'devanagari': ['hi', 'mr', 'ne', 'en'],
    'bengali': ['bn', 'as', 'en'],
    'chinese-simplified': ['ch_sim', 'en'],
    'chinese-traditional': ['ch_tra', 'en'],
    'japanese': ['ja', 'en'],
    'korean': ['ko', 'en'],
    'thai': ['th', 'en'],
    'tamil': ['ta', 'en'],
    'telugu': ['te', 'en'],
}

# Map engine names to model server wrapper classes
OCR_ENGINES = {
    'easyocr': EasyOCR,
    'doctr': DocTR,
    'surya': Surya,
    'trocr': TrOCR,
}


class Reader(ReaderBase):
    """
    OCR Reader using model server wrappers.
    
    Supports multiple OCR engines via ai.common.models:
    - EasyOCR: Multi-language support, good general purpose
    - DocTR: Document-focused, good for structured documents
    - Surya: Multilingual, 90+ languages
    - TrOCR: Transformer-based, Microsoft model
    
    The model server wrappers auto-detect whether to use remote model server
    or fall back to local inference.
    """
    
    def __init__(self, provider: str, connConfig: Dict[str, Any], bag: Dict[str, Any]):
        """
        Initialize the OCR reader.
        
        Args:
            provider: Node provider name
            connConfig: Connection configuration
            bag: Shared bag dictionary
        """
        super().__init__(provider, connConfig, bag)
        
        # Get node configuration
        config = Config.getNodeConfig(provider, connConfig)
        
        # Get OCR settings
        engine = config.get('engine', 'easyocr').lower()
        script_family = config.get('script_family', 'latin')
        
        # Get languages for this script family (used by EasyOCR)
        languages = SCRIPT_FAMILIES.get(script_family, ['en'])
        
        # Initialize the OCR engine via model server wrapper
        self._engine_name = engine
        self._ocr = self._init_ocr_engine(engine, languages, config)
        
        debug(f'OCR Reader initialized: engine={engine}, script_family={script_family}, languages={languages}')
    
    def _init_ocr_engine(self, engine: str, languages: List[str], config: Dict[str, Any]):
        """
        Initialize the specified OCR engine.
        
        Args:
            engine: Engine name ('easyocr', 'doctr', 'surya', 'trocr')
            languages: List of language codes for EasyOCR
            config: Node configuration dictionary
            
        Returns:
            Initialized OCR engine instance
        """
        OCRClass = OCR_ENGINES.get(engine)
        
        if OCRClass is None:
            debug(f"Unknown OCR engine '{engine}', falling back to EasyOCR")
            return EasyOCR(languages=languages)
        
        if engine == 'easyocr':
            return OCRClass(languages=languages)
        
        elif engine == 'doctr':
            # DocTR supports detection and recognition architecture options
            det_arch = config.get('det_arch', 'db_resnet50')
            reco_arch = config.get('reco_arch', 'crnn_vgg16_bn')
            return OCRClass(detection_model=det_arch, recognition_model=reco_arch)
        
        elif engine == 'surya':
            return OCRClass()
        
        elif engine == 'trocr':
            # TrOCR supports different model variants
            model = config.get('trocr_model', 'microsoft/trocr-base-printed')
            return OCRClass(recognition_model=model)
        
        else:
            return EasyOCR(languages=languages)
    
    def read(self, image_data) -> str:
        """
        Read text from an image.
        
        Args:
            image_data: Image as bytes, numpy array, or PIL Image
            
        Returns:
            Extracted text as string
        """
        # Convert to bytes for model server
        image_bytes = self._to_bytes(image_data)
        
        # Call OCR engine
        result = self._ocr.read(image_bytes)
        
        # Extract text from result
        return self._extract_text(result)
    
    def _to_bytes(self, image_data) -> bytes:
        """
        Convert various image formats to PNG bytes.
        
        Args:
            image_data: Image as bytes, numpy array, or PIL Image
            
        Returns:
            Image as PNG bytes
        """
        if isinstance(image_data, bytes):
            return image_data
        
        if isinstance(image_data, np.ndarray):
            # Handle grayscale images
            if len(image_data.shape) == 2:
                pil_image = Image.fromarray(image_data, mode='L')
            else:
                pil_image = Image.fromarray(image_data)
            buffer = io.BytesIO()
            pil_image.save(buffer, format='PNG')
            return buffer.getvalue()
        
        if isinstance(image_data, Image.Image):
            buffer = io.BytesIO()
            image_data.save(buffer, format='PNG')
            return buffer.getvalue()
        
        # Fallback: try to convert to string then encode
        return str(image_data).encode('utf-8')
    
    def _extract_text(self, result) -> str:
        """
        Extract text from OCR result.
        
        Different engines return different formats:
        - EasyOCR: {'text': '...', 'boxes': [...]}
        - DocTR: {'text': '...', 'boxes': [...]}
        - Surya: {'text': '...', ...}
        - TrOCR: {'text': '...', ...}
        
        Args:
            result: OCR result from engine
            
        Returns:
            Extracted text as string
        """
        if isinstance(result, dict):
            return result.get('text', '')
        
        if isinstance(result, str):
            return result
        
        if isinstance(result, list):
            # List of results - join text from each
            texts = []
            for item in result:
                if isinstance(item, dict):
                    texts.append(item.get('text', ''))
                elif isinstance(item, str):
                    texts.append(item)
            return '\n'.join(texts)
        
        return str(result)
