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

from .binary import binary_image
from .deskew import deskew_image
from .morphology import morph_image
from .png import ensure_png


def process_image(mimeType: str, input_bytes: bytes) -> bytes:
    """
    Accept raw bytes of a an image, preprocesses for OCR using three stages.

    1. Grayscale conversion and binarization
    2. Deskewing to correct text alignment
    3. Morphological cleanup to enhance OCR clarity

    Returns:
        bytes: Preprocessed JPEG image in bytes, ready for OCR.
    """
    image = input_bytes

    # Step 1: Convert to png if needed
    mimeType, image = ensure_png(mimeType, input_bytes)

    # Step 2: Convert image to binary grayscale png
    image = binary_image(image)

    # Step 3: Deskew the binary image to align text
    image = deskew_image(image)

    # Step 4: Clean up image using morphological operations
    image = morph_image(image)

    return mimeType, image
