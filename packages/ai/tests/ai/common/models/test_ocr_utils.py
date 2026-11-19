"""Unit tests for OCR utils: EXIF orientation transposition and HEIC decoding."""

import io
import pytest
from PIL import Image

from ai.common.models.ocr.utils import preprocess_image_transparency


def _create_jpeg_with_exif_orientation(orientation: int) -> bytes:
    """Helper to produce a 20x10 JPEG carrying distinct color quadrants and EXIF orientation."""
    img = Image.new('RGB', (20, 10))
    # Top-Left: Red, Top-Right: Green, Bottom-Left: Blue, Bottom-Right: Yellow
    for x in range(20):
        for y in range(10):
            if x < 10 and y < 5:
                img.putpixel((x, y), (255, 0, 0))  # TL: Red
            elif x >= 10 and y < 5:
                img.putpixel((x, y), (0, 255, 0))  # TR: Green
            elif x < 10 and y >= 5:
                img.putpixel((x, y), (0, 0, 255))  # BL: Blue
            else:
                img.putpixel((x, y), (255, 255, 0))  # BR: Yellow

    exif = img.getexif()
    exif[0x0112] = orientation
    buf = io.BytesIO()
    img.save(buf, format='JPEG', exif=exif, quality=95)
    return buf.getvalue()


@pytest.mark.parametrize(
    ('orientation', 'expected_size', 'sample_point', 'expected_color_name'),
    [
        (1, (20, 10), (2, 2), 'red'),  # Normal: TL remains Red
        (3, (20, 10), (2, 2), 'yellow'),  # 180°: TL is now Yellow (original BR)
        (6, (10, 20), (2, 2), 'blue'),  # 90° CW: TL is now Blue (original BL)
        (8, (10, 20), (2, 2), 'green'),  # 270° CW: TL is now Green (original TR)
    ],
)
def test_preprocess_transposes_exif_orientation(
    orientation: int, expected_size: tuple[int, int], sample_point: tuple[int, int], expected_color_name: str
):
    """preprocess_image_transparency must physically transpose pixels per EXIF orientation."""
    raw_jpeg = _create_jpeg_with_exif_orientation(orientation)
    out_png = preprocess_image_transparency(raw_jpeg)

    with Image.open(io.BytesIO(out_png)) as out_img:
        assert out_img.format == 'PNG'
        assert out_img.size == expected_size
        r, g, b = out_img.getpixel(sample_point)[:3]
        if expected_color_name == 'red':
            assert r > 200 and g < 50 and b < 50
        elif expected_color_name == 'yellow':
            assert r > 200 and g > 200 and b < 50
        elif expected_color_name == 'blue':
            assert r < 50 and g < 50 and b > 200
        elif expected_color_name == 'green':
            assert r < 50 and g > 200 and b < 50


def test_preprocess_preserves_unoriented_image():
    """Images without EXIF retain their original dimensions."""
    buf = io.BytesIO()
    Image.new('RGB', (80, 40), (200, 200, 200)).save(buf, format='PNG')
    out_png = preprocess_image_transparency(buf.getvalue())

    with Image.open(io.BytesIO(out_png)) as out_img:
        assert out_img.size == (80, 40)


def test_preprocess_decodes_heif_to_png():
    """preprocess_image_transparency must decode HEIF/HEIC image bytes to PNG."""
    pytest.importorskip('pillow_heif', reason='pillow-heif not installed')
    import pillow_heif

    pillow_heif.register_heif_opener()

    buf = io.BytesIO()
    Image.new('RGB', (120, 60), (30, 60, 90)).save(buf, format='HEIF')
    heif_bytes = buf.getvalue()

    out_png = preprocess_image_transparency(heif_bytes)

    with Image.open(io.BytesIO(out_png)) as out_img:
        assert out_img.format == 'PNG'
        assert out_img.size == (120, 60)
