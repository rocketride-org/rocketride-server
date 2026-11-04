"""Unit tests for the EasyOCR loader (no torch/easyocr needed)."""

import sys
import types

import pytest

from ai.common.models.ocr.easyocr import EasyOCRLoader
from ai.common.models.ocr.utils import group_words_into_lines


class _Reader:
    """``detect`` returns the given boxes; ``recognize`` records each call and reads a box as ``w<x>``."""

    def __init__(self, horizontal, free=()):
        self.horizontal, self.free = list(horizontal), list(free)
        self.calls = []

    def detect(self, img, reformat=True):
        return [self.horizontal], [self.free]

    def recognize(self, grey, horizontal_list, free_list, batch_size=1, reformat=True):
        self.calls.append((list(horizontal_list), list(free_list), batch_size))
        out = [([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], f'w{x0}', 0.9) for x0, x1, y0, y1 in horizontal_list]
        return out + [(box, 'rotated', 0.9) for box in free_list]


@pytest.fixture(autouse=True)
def _no_libraries(monkeypatch):
    torch_shim = types.ModuleType('ai.common.torch')
    torch_shim.torch = None
    package = types.ModuleType('easyocr')
    package.__path__ = []
    utils = types.ModuleType('easyocr.utils')
    utils.reformat_input = lambda image: (image, types.SimpleNamespace(shape=(1000, 2000)))

    def calculate_ratio(width, height):  # easyocr 1.7.2
        ratio = width / height
        if ratio < 1.0:
            ratio = 1.0 / ratio
        return ratio

    utils.calculate_ratio = calculate_ratio
    monkeypatch.setitem(sys.modules, 'ai.common.torch', torch_shim)
    monkeypatch.setitem(sys.modules, 'easyocr', package)
    monkeypatch.setitem(sys.modules, 'easyocr.utils', utils)


def _box(x0, width, y0=0, height=20):
    return [x0, x0 + width, y0, y0 + height]


def test_crops_of_one_padded_width_share_a_call():
    """Widths 30, 35 and 40 at height 20 all pad to 2 model heights; 100 pads to 5."""
    reader = _Reader([_box(0, 30), _box(100, 100), _box(300, 35), _box(400, 40)])

    EasyOCRLoader._readtext(reader, object())

    assert [[b[0] for b in h] for h, _, _ in reader.calls] == [[0, 300, 400], [100]]
    assert {batch for _, _, batch in reader.calls} == {16}


def test_a_width_group_is_cut_into_batches_of_16():
    reader = _Reader([_box(x, 30) for x in range(0, 2000, 100)])

    EasyOCRLoader._readtext(reader, object())

    assert [len(h) for h, _, _ in reader.calls] == [16, 4]


def test_wide_crops_share_a_call_up_to_256_model_heights():
    """Width 400 at height 10 pads to 40 model heights: 6 crops per call; 1500 pads to 150: one per call."""
    reader = _Reader(
        [_box(0, 400, y0=y, height=10) for y in range(0, 160, 20)]
        + [_box(0, 1500, y0=y, height=10) for y in (200, 300)]
    )

    EasyOCRLoader._readtext(reader, object())

    assert [(len(h), batch) for h, _, batch in reader.calls] == [(6, 6), (2, 6), (1, 1), (1, 1)]


def test_tall_crops_are_keyed_as_easyocr_pads_them():
    """EasyOCR pads 10x490 to 50 model heights (1/(10/490) rounds up past 49) and 10x489 to 49."""
    reader = _Reader([_box(0, 10, height=490), _box(100, 10, height=489)])

    EasyOCRLoader._readtext(reader, object())

    assert [[b[0] for b in h] for h, _, _ in reader.calls] == [[100], [0]]


def test_rotated_boxes_are_read_one_per_call():
    quad = [[0, 0], [30, 5], [28, 25], [-2, 20]]
    reader = _Reader([_box(0, 30)], free=[quad, quad])

    EasyOCRLoader._readtext(reader, object())

    assert [(len(h), len(f)) for h, f, _ in reader.calls] == [(1, 0), (0, 1), (0, 1)]


def test_inference_keeps_reading_order():
    """Width groups come back out of order; the line text is still left to right."""
    reader = _Reader([_box(0, 30), _box(100, 100), _box(300, 35)])

    out = EasyOCRLoader.inference(
        {'reader': reader, 'device': 'cpu'}, {'images': [object()], 'dimensions': [(1000, 2000)]}
    )

    assert out[0]['text'] == 'w0 w100 w300'


def test_boxes_sharing_a_left_edge_read_in_one_order():
    """_readtext returns boxes in width order, readtext in detection order; the line follows neither."""
    wide = {'text': 'wide', 'bbox': [0, 0, 100, 20], 'confidence': 0.9}
    square = {'text': 'square', 'bbox': [0, 0, 20, 20], 'confidence': 0.9}

    assert group_words_into_lines([wide, square])[0] == group_words_into_lines([square, wide])[0] == 'square wide'
