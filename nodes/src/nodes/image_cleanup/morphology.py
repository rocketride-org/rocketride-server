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

from ai.common.opencv import cv2
import numpy as np


def morph_image(png_bytes: bytes) -> bytes:
    """
    Perform morphological closing to remove small holes and noise in the binary JPEG image (in bytes).

    Args:
        png_bytes (bytes): The input binary png image as bytes.

    Returns:
        bytes: The cleaned image encoded as png bytes.
    """
    # Decode the JPEG bytes into a grayscale image
    image = cv2.imdecode(np.frombuffer(png_bytes, np.uint8), cv2.IMREAD_GRAYSCALE)

    # Create a small 2x2 square kernel for morphological operation
    kernel = np.ones((2, 2), np.uint8)

    # Apply morphological closing:
    # This operation dilates and then erodes the image.
    # It helps close small holes (e.g., in text characters like 'o') and remove noise.
    cleaned = cv2.morphologyEx(image, cv2.MORPH_CLOSE, kernel)

    # Encode the cleaned image back to png
    success, output_bytes = cv2.imencode('.png', cleaned)
    if not success:
        raise ValueError('Failed to encode morph image to PNG.')

    return output_bytes.tobytes()
