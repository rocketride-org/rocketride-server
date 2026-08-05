"""Unit tests for ai.common.utils.image_utils."""

import numpy as np
import pytest

from ai.common.utils.image_utils import colorize_depth, image_to_bytes, encode_ndarray, decode_ndarray


def test_image_to_bytes_passthrough_for_bytes():
    assert image_to_bytes(b'abc') == b'abc'
    assert image_to_bytes(bytearray(b'xy')) == b'xy'


def test_image_to_bytes_rejects_other_types():
    with pytest.raises(TypeError):
        image_to_bytes(123)


def test_image_to_bytes_encodes_pil_to_png():
    Image = pytest.importorskip('PIL.Image')
    data = image_to_bytes(Image.new('RGB', (4, 3), (10, 20, 30)))
    assert data[:8] == b'\x89PNG\r\n\x1a\n'  # PNG magic


@pytest.mark.parametrize('dtype', ['float32', 'uint8', 'float64', 'int16'])
def test_encode_decode_ndarray_roundtrip(dtype):
    arr = np.arange(24).reshape(4, 6).astype(dtype)
    enc = encode_ndarray(arr)
    assert enc['shape'] == [4, 6]
    assert enc['dtype'] == dtype
    assert enc['encoding'] == 'zlib+base64'
    np.testing.assert_array_equal(decode_ndarray(enc), arr)


def test_colorize_depth_maps_extremes_and_shape():
    pytest.importorskip('PIL')
    depth = np.array([[0.0, 1.0], [2.0, 3.0]], dtype=np.float32)
    img = colorize_depth(depth)

    assert img.mode == 'RGB'
    assert img.size == (2, 2)  # PIL size is (width, height) = (cols, rows)

    px = np.asarray(img)
    # min value -> blue (low R, high B); max value -> red (high R, low B)
    assert px[0, 0, 0] == 0 and px[0, 0, 2] == 255
    assert px[1, 1, 0] == 255 and px[1, 1, 2] == 0


def test_colorize_depth_handles_constant_array():
    pytest.importorskip('PIL')
    img = colorize_depth(np.zeros((3, 4), dtype=np.float32))
    assert img.size == (4, 3)  # no div-by-zero on flat input
