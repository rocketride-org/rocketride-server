"""Unit tests for ImageProcessor.get_bytes encoding (PNG default, opt-in JPEG)."""

import io

import pytest
from PIL import Image

from ai.common.image.image import ImageProcessor


def test_get_bytes_defaults_to_png():
    data = ImageProcessor.get_bytes(Image.new('RGB', (4, 4)))
    assert data[:4] == b'\x89PNG'


def test_get_bytes_jpeg_for_rgb():
    data = ImageProcessor.get_bytes(Image.new('RGB', (4, 4)), fmt='JPEG')
    assert data[:3] == b'\xff\xd8\xff'  # JPEG magic


def test_get_bytes_jpeg_coerces_rgba():
    # RGBA carries alpha; JPEG has none -> coerced to RGB, must not raise.
    data = ImageProcessor.get_bytes(Image.new('RGBA', (4, 4)), fmt='JPEG')
    assert data[:3] == b'\xff\xd8\xff'


def test_get_bytes_png_preserves_rgba():
    data = ImageProcessor.get_bytes(Image.new('RGBA', (4, 4)))
    assert data[:4] == b'\x89PNG'
    assert Image.open(io.BytesIO(data)).mode == 'RGBA'


def test_load_image_from_bytes_decodes_jpeg_at_original_size():
    # JPEG in -> fully-loaded image at original size/mode (no PNG round-trip).
    buf = io.BytesIO()
    Image.new('RGB', (6, 4), (10, 20, 30)).save(buf, format='JPEG')
    img = ImageProcessor.load_image_from_bytes(buf.getvalue())
    assert img is not None
    assert img.size == (6, 4)
    assert img.mode == 'RGB'
    assert isinstance(img.getpixel((0, 0)), tuple)  # fully decoded -> pixel access works


def test_load_image_from_bytes_survives_source_buffer_close():
    # load() must fully read the image so it stays usable after the source is gone.
    src = io.BytesIO()
    Image.new('L', (3, 3)).save(src, format='PNG')
    img = ImageProcessor.load_image_from_bytes(src.getvalue())
    src.close()
    assert img.getpixel((1, 1)) == 0


def test_load_image_from_bytes_empty_raises():
    with pytest.raises(ValueError):
        ImageProcessor.load_image_from_bytes(b'')
