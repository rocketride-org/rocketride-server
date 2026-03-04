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

from ai.common.opencv import cv2
import numpy as np


def deskew_image(png_bytes: bytes) -> bytes:
    """
    Correct skew in a binary png image (in bytes) by detecting the angle of text and rotating accordingly.

    Args:
        png_bytes (bytes): The input binary png image as bytes.

    Returns:
        bytes: The deskewed image encoded as ng bytes.
    """
    # Decode the image bytes to a grayscale image (we assume it's already binary from previous step)
    image = cv2.imdecode(np.frombuffer(png_bytes, np.uint8), cv2.IMREAD_GRAYSCALE)

    # Invert the binary image so text is white on black
    binary_inv = cv2.bitwise_not(image)

    # Find all non-zero (white) pixels — these indicate where the text is
    coords = cv2.findNonZero(binary_inv)

    angle = 0  # Default rotation angle

    if coords is not None:
        # Get a rotated rectangle that bounds the text
        rect = cv2.minAreaRect(coords)
        angle = rect[-1]  # Extract the angle

        # Convert OpenCV's angle convention to standard rotation
        if angle < -45:
            angle = -(90 + angle)
        else:
            angle = -angle

    # Get image dimensions
    (h, w) = image.shape

    # Compute the affine transform matrix for rotation
    M = cv2.getRotationMatrix2D((w // 2, h // 2), angle, 1.0)

    # Apply the rotation
    rotated = cv2.warpAffine(image, M, (w, h), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)

    # Encode the deskewed image back to png
    success, output_bytes = cv2.imencode('.png', rotated)
    if not success:
        raise ValueError('Failed to encode deskewed image to PNG.')

    return output_bytes.tobytes()
