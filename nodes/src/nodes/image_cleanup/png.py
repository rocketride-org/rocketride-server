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

from PIL import Image
from io import BytesIO


def ensure_png(mime_type: str, image_bytes: bytes) -> tuple[str, bytes]:
    """
    Ensure the image is in PNG format. If it's already PNG, return as-is.

    Otherwise, convert to PNG.

    Args:
        mime_type (str): The current MIME type of the image.
        image_bytes (bytes): The input image bytes.

    Returns:
        tuple[str, bytes]: A tuple of ('image/png', the PNG image bytes).
    """
    if mime_type.lower() == 'image/png':
        return 'image/png', image_bytes

    try:
        with Image.open(BytesIO(image_bytes)) as img:
            img = img.convert('RGBA')  # PNG supports RGBA
            output = BytesIO()
            img.save(output, format='PNG')
            return 'image/png', output.getvalue()
    except Exception as e:
        raise ValueError(f'Failed to convert image to PNG: {e}')
