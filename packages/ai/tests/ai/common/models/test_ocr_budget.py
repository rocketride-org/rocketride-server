"""In-process OCR reads wait in the device budget with their loader's cost (no torch/OCR libraries needed)."""

import contextlib
import types

import pytest

from ai.common.models.ocr import doctr, easyocr, surya, trocr
from ai.common.models.ocr.easyocr import EasyOCRLoader

_A4_200DPI = (2200, 1700)  # height, width


def test_easyocr_cost_follows_the_detector_input():
    assert EasyOCRLoader.inference_cost_mb({'dimensions': [_A4_200DPI]}) == pytest.approx(1.25 * (32 + 600 * 3.74))
    # the detector caps the long side at 2560 px, so larger scans cost the same
    capped = EasyOCRLoader.inference_cost_mb({'dimensions': [(6000, 4000)]})
    assert capped == pytest.approx(EasyOCRLoader.inference_cost_mb({'dimensions': [(12000, 8000)]}))
    # images of one call are read one after another: the largest sets the peak
    both = EasyOCRLoader.inference_cost_mb({'dimensions': [(100, 100), _A4_200DPI]})
    assert both == EasyOCRLoader.inference_cost_mb({'dimensions': [_A4_200DPI]})


class _Recorder:
    """Stands in for ``device_budget``: records each call's device and cost, admits everything."""

    def __init__(self):
        self.calls = []

    def __call__(self, device):
        def reserve(cost):
            self.calls.append((device, cost))
            return contextlib.nullcontext()

        return types.SimpleNamespace(reserve=reserve)


@pytest.mark.parametrize(
    'mod, cls, loader, cost',
    [
        pytest.param(easyocr, easyocr.EasyOCR, easyocr.EasyOCRLoader, 1.25 * (32 + 600 * 3.74), id='easyocr'),
        pytest.param(doctr, doctr.DocTR, doctr.DocTRLoader, 900.0, id='doctr'),
        pytest.param(surya, surya.Surya, surya.SuryaLoader, None, id='surya'),
        pytest.param(trocr, trocr.TrOCR, trocr.TrOCRLoader, None, id='trocr'),
    ],
)
def test_local_read_waits_for_its_device(monkeypatch, mod, cls, loader, cost):
    recorder = _Recorder()
    monkeypatch.setattr(mod, 'device_budget', recorder)
    monkeypatch.setattr(mod, 'get_model_server_address', lambda: None)
    monkeypatch.setattr(loader, 'load', staticmethod(lambda **kw: ({'device': 'cuda:1'}, {}, None)))
    monkeypatch.setattr(
        loader,
        'preprocess',
        staticmethod(lambda model, images, metadata=None: {'images': images, 'dimensions': [_A4_200DPI]}),
    )
    monkeypatch.setattr(
        loader, 'inference', staticmethod(lambda model, pre, metadata=None: [{'text': 'x', 'boxes': []}])
    )

    assert cls().read(b'png') == {'text': 'x', 'boxes': []}
    assert recorder.calls == [('cuda:1', pytest.approx(cost) if cost else None)]
