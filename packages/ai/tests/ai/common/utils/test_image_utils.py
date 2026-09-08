"""Unit tests for ai.common.utils.image_utils."""

from pathlib import Path

import numpy as np
import pytest

from ai.common.utils.image_utils import (
    LOSSLESS_INPUT_QUALITY,
    colorize_depth,
    decode_ndarray,
    encode_ndarray,
    image_to_bytes,
    matched_quality,
    source_quality,
)


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


# .../packages/ai/tests/ai/common/utils/ -> repo root
REPO_ROOT = Path(__file__).parents[6]
IMAGES = REPO_ROOT / 'testdata' / 'images'


def _read(name):
    """Raw bytes of a committed test image."""
    return (IMAGES / name).read_bytes()


class TestSourceQuality:
    """Recovering the saved quality from real committed fixtures."""

    def test_einstein_jpeg(self):
        """A quality-90 JPEG resolves exactly."""
        assert source_quality(_read('einstein.jpg')) == 90.0

    def test_ocr_jpeg(self):
        """A high-quality JPEG resolves to ~94; the table does not divide evenly, hence epsilon."""
        assert abs(source_quality(_read('ocr.jpg')) - 94.02) < 0.05

    def test_png_has_no_quality(self):
        """
        A PNG is not a failure, it is the honest answer: there was no lossy step to match.

        This path matters more than it looks — the synthetic album fixture used by the
        declarative test is also a PNG, so that test only ever exercises the fallback.
        """
        assert source_quality(_read('ocr.png')) is None

    def test_tiff_has_no_quality(self):
        """Same for TIFF: no DQT to read, so no quality to recover."""
        assert source_quality(_read('ocr.tiff')) is None


class TestSourceQualityRejectsJunk:
    """Every failure path returns None rather than raising — callers hand it arbitrary bytes."""

    def test_empty(self):
        """Empty input."""
        assert source_quality(b'') is None

    def test_not_an_image(self):
        """Bytes with no JPEG SOI marker."""
        assert source_quality(b'not an image at all') is None

    def test_soi_but_truncated(self):
        """A JPEG that starts correctly and then stops before any quantisation table."""
        assert source_quality(b'\xff\xd8\xff') is None

    def test_jpeg_header_without_dqt(self):
        """
        SOI, then a well-formed non-DQT segment, then end of data.

        Walks the segment-length arithmetic without ever finding a table, which is the loop's
        normal exit rather than an error.
        """
        payload = b'\xff\xd8' + b'\xff\xe0' + b'\x00\x04' + b'\x00\x00' + b'\xff\xd9'
        assert source_quality(payload) is None


class TestMatchedQuality:
    """Mapping a source quality to the output quality to encode crops at."""

    def test_reference_album_case(self):
        """
        The album this node was built for was scanned at quality 75.

        At the default 0.5 dB tolerance that maps to 88 — the number to look for when checking
        during the end-to-end run that `auto` is actually reading the source rather than
        silently falling back.
        """
        assert matched_quality(75, 0.5) == 88

    def test_no_source_quality_uses_the_lossless_default(self):
        """A PNG or PDF-rendered page has nothing to match, so it takes the fixed high point."""
        assert matched_quality(None) == LOSSLESS_INPUT_QUALITY == 95

    def test_tolerance_interpolates_between_calibrated_rows(self):
        """
        A tolerance between two measured steps lands between their curves.

        0.35 dB sits midway between the 0.2 dB row (94 at quality 75) and the 0.5 dB row (88),
        so it must resolve strictly between them rather than snapping to either.
        """
        assert 88 < matched_quality(75, 0.35) < 94

    def test_source_quality_interpolates_between_calibrated_columns(self):
        """72 is between the measured 70 and 75 columns, and resolves between their values."""
        assert matched_quality(72, 0.5) == 87

    def test_tolerance_clamps_at_both_ends(self):
        """
        Out-of-range tolerance clamps to the nearest calibrated row instead of extrapolating.

        This is why the pure-python interpolation had to keep numpy's end-clamping: without it
        an out-of-range value walks off the table and produces a meaningless quality.
        """
        assert matched_quality(75, 0.0) == matched_quality(75, 0.2)
        assert matched_quality(75, 99.0) == matched_quality(75, 1.5)

    def test_better_source_never_yields_a_worse_output(self):
        """The mapping is monotonic in the source quality, which is the property it exists for."""
        results = [matched_quality(q, 0.5) for q in (10, 30, 50, 70, 90, 100)]
        assert results == sorted(results)
