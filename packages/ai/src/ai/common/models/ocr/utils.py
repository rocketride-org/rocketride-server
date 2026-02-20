"""
OCR Utilities - Shared preprocessing and postprocessing for OCR loaders.

Provides:
- Transparency/alpha channel handling
- Line grouping from word boxes
- Image format normalization
"""

import io
import logging
from typing import List, Dict, Any, Tuple, Optional

logger = logging.getLogger('rocketlib.models.ocr_utils')


def preprocess_image_transparency(image_bytes: bytes) -> bytes:
    """
    Preprocess image to handle transparency intelligently.

    For images with significant transparency (>1% of pixels):
    - Analyzes brightness of non-transparent content
    - Chooses appropriate background (dark for bright text, light for dark text)
    - Composites the image onto the background

    Args:
        image_bytes: Raw image bytes (PNG, JPEG, etc.)

    Returns:
        Preprocessed image bytes (always RGB PNG)
    """
    import numpy as np
    from PIL import Image

    img = Image.open(io.BytesIO(image_bytes))

    # Handle different image modes
    if img.mode in ('RGBA', 'LA'):
        # Images with alpha channel
        alpha_channel = img.split()[-1]
        alpha_array = np.array(alpha_channel)

        # Calculate transparency statistics
        transparent_pixels = np.sum(alpha_array < 255)
        total_pixels = alpha_array.size
        transparency_percentage = (transparent_pixels / total_pixels) * 100

        # Only process if more than 1% of pixels are transparent
        if transparency_percentage > 1.0:
            logger.debug(f'Processing transparency: {transparency_percentage:.1f}% transparent pixels')

            # Analyze non-transparent pixels to choose background
            non_transparent_mask = alpha_array == 255

            if np.any(non_transparent_mask):
                img_array = np.array(img.convert('RGBA'))

                # Get RGB values of non-transparent pixels
                non_transparent_pixels = img_array[non_transparent_mask]

                # Calculate average brightness
                avg_brightness = np.mean(non_transparent_pixels[:, :3])

                # Check for bright/white content
                bright_pixels = np.sum(np.mean(non_transparent_pixels[:, :3], axis=1) > 200)
                total_non_transparent = len(non_transparent_pixels)
                white_ratio = bright_pixels / total_non_transparent if total_non_transparent > 0 else 0

                # Choose background based on content
                if white_ratio > 0.3 or avg_brightness > 200:
                    bg_color = (32, 32, 32)  # Dark gray for bright/white text
                    logger.debug('Using dark background for bright content')
                else:
                    bg_color = (255, 255, 255)  # White for dark text
                    logger.debug('Using white background for dark content')
            else:
                bg_color = (128, 128, 128)  # Gray fallback

            # Composite onto background
            background = Image.new('RGB', img.size, bg_color)
            if img.mode == 'LA':
                img = img.convert('RGBA')
            background.paste(img, mask=img.split()[-1])
            img = background
        else:
            # Minimal transparency, just convert to RGB
            img = img.convert('RGB')

    elif img.mode == 'P' and 'transparency' in img.info:
        # Palette image with transparency
        img_rgba = img.convert('RGBA')
        alpha_channel = img_rgba.split()[-1]
        alpha_array = np.array(alpha_channel)

        transparent_pixels = np.sum(alpha_array < 255)
        total_pixels = alpha_array.size
        transparency_percentage = (transparent_pixels / total_pixels) * 100

        if transparency_percentage > 1.0:
            non_transparent_mask = alpha_array == 255
            if np.any(non_transparent_mask):
                img_array = np.array(img_rgba)
                non_transparent_pixels = img_array[non_transparent_mask]
                avg_brightness = np.mean(non_transparent_pixels[:, :3])
                bright_pixels = np.sum(np.mean(non_transparent_pixels[:, :3], axis=1) > 200)
                total_non_transparent = len(non_transparent_pixels)
                white_ratio = bright_pixels / total_non_transparent if total_non_transparent > 0 else 0

                if white_ratio > 0.3 or avg_brightness > 200:
                    bg_color = (32, 32, 32)
                else:
                    bg_color = (255, 255, 255)
            else:
                bg_color = (128, 128, 128)

            background = Image.new('RGB', img_rgba.size, bg_color)
            background.paste(img_rgba, mask=alpha_channel)
            img = background
        else:
            img = img_rgba.convert('RGB')

    elif img.mode in ('L', '1'):
        # Grayscale or black & white
        img = img.convert('RGB')

    elif img.mode != 'RGB':
        # Any other mode - check for transparency info
        if 'transparency' in img.info:
            try:
                img_rgba = img.convert('RGBA')
                alpha_channel = img_rgba.split()[-1]
                alpha_array = np.array(alpha_channel)

                transparent_pixels = np.sum(alpha_array < 255)
                total_pixels = alpha_array.size
                transparency_percentage = (transparent_pixels / total_pixels) * 100

                if transparency_percentage > 1.0:
                    non_transparent_mask = alpha_array == 255
                    if np.any(non_transparent_mask):
                        img_array = np.array(img_rgba)
                        non_transparent_pixels = img_array[non_transparent_mask]
                        avg_brightness = np.mean(non_transparent_pixels[:, :3])

                        if avg_brightness > 200:
                            bg_color = (32, 32, 32)
                        else:
                            bg_color = (255, 255, 255)
                    else:
                        bg_color = (128, 128, 128)

                    background = Image.new('RGB', img_rgba.size, bg_color)
                    background.paste(img_rgba, mask=alpha_channel)
                    img = background
                else:
                    img = img_rgba.convert('RGB')
            except Exception:
                img = img.convert('RGB')
        else:
            img = img.convert('RGB')

    # Convert back to bytes
    img_bytes = io.BytesIO()
    img.save(img_bytes, format='PNG')
    return img_bytes.getvalue()


def group_words_into_lines(
    boxes: List[Dict[str, Any]],
    image_height: Optional[int] = None,
    max_lines: int = 75,
) -> Tuple[str, List[Dict[str, Any]]]:
    """
    Group word-level OCR results into lines based on y-coordinates.

    Words on the same line are sorted left-to-right and joined.
    Lines are separated by newlines.

    Args:
        boxes: List of box dicts with 'text', 'bbox' [x1, y1, x2, y2], 'confidence'
        image_height: Image height for calculating line threshold (optional)
        max_lines: Maximum expected lines for threshold calculation

    Returns:
        Tuple of (full_text_with_newlines, updated_boxes_with_line_info)
    """
    if not boxes:
        return '', []

    # Filter out empty boxes
    valid_boxes = [b for b in boxes if b.get('text') and b.get('bbox')]
    if not valid_boxes:
        return '', []

    # Sort by y-coordinate (top of box)
    valid_boxes.sort(key=lambda b: b['bbox'][1])

    # Calculate line height threshold
    if image_height:
        line_threshold = image_height / max_lines
    else:
        # Estimate from box heights
        heights = [b['bbox'][3] - b['bbox'][1] for b in valid_boxes]
        avg_height = sum(heights) / len(heights) if heights else 20
        line_threshold = avg_height * 0.7

    # Group into lines
    lines: List[List[Dict]] = []
    current_line: List[Dict] = [valid_boxes[0]]
    current_y = valid_boxes[0]['bbox'][1]

    for box in valid_boxes[1:]:
        box_y = box['bbox'][1]

        if box_y - current_y > line_threshold:
            # New line
            lines.append(current_line)
            current_line = [box]
            current_y = box_y
        else:
            # Same line
            current_line.append(box)

    # Don't forget the last line
    if current_line:
        lines.append(current_line)

    # Sort each line by x-coordinate and build text
    text_lines = []
    updated_boxes = []

    for line_idx, line in enumerate(lines):
        # Sort by x-coordinate (left edge)
        line.sort(key=lambda b: b['bbox'][0])

        # Build line text
        line_text = ' '.join(b['text'] for b in line)
        text_lines.append(line_text)

        # Update boxes with line info
        for box in line:
            updated_box = box.copy()
            updated_box['line'] = line_idx
            updated_boxes.append(updated_box)

    full_text = '\n'.join(text_lines)
    return full_text, updated_boxes
