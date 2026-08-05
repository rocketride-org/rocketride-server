"""Unit tests for the detection loader + facade (no torch/transformers needed)."""

import pytest
from PIL import Image

import ai.common.models.vision.detection as detmod
from ai.common.models.vision.detection import DetectorLoader, Detector


def test_postprocess_wraps_detections():
    raw = [[{'label': 'cat', 'score': 0.9}], []]
    out = DetectorLoader.postprocess(None, raw, 2, ['detections'])
    assert out == [
        {'detections': [{'label': 'cat', 'score': 0.9}], '$detections': [{'label': 'cat', 'score': 0.9}]},
        {'detections': [], '$detections': []},
    ]


def test_model_id_backend_is_identity():
    rfdetr = DetectorLoader.generate_model_id('PekingU/rtdetr_r50vd', backend='rfdetr')
    assert rfdetr == DetectorLoader.generate_model_id('PekingU/rtdetr_r50vd', backend='rfdetr')
    # Different backend -> different model identity (separate server copies).
    assert DetectorLoader.generate_model_id('IDEA-Research/grounding-dino-tiny', backend='mmgdino') != rfdetr


def _fake_client_factory(captured):
    class FakeClient:
        def __init__(self, addr):
            self.metadata = {}

        def load_model(self, model_name=None, model_type=None, loader_options=None):
            captured.setdefault('loads', []).append((model_name, model_type, loader_options))

        def send_command(self, command, args):
            captured['cmd'] = command
            captured['args'] = args
            return {'result': [{'detections': captured.get('dets', [])}]}

        def disconnect(self):
            captured['disconnected'] = True

    return FakeClient


def test_facade_load_once_ignores_threshold_and_prompt(monkeypatch):
    captured = {}
    monkeypatch.setattr(detmod, 'get_model_server_address', lambda: 'localhost:5590')
    monkeypatch.setattr(detmod, 'ModelClient', _fake_client_factory(captured))

    Detector(backend='rfdetr', threshold=0.1, prompt='cat')
    Detector(backend='rfdetr', threshold=0.9, prompt='dog')

    loads = captured['loads']
    assert loads[0] == loads[1]  # same identity regardless of per-request threshold/prompt
    assert loads[0][1] == 'detection'
    opts = loads[0][2] or {}
    assert 'threshold' not in opts and 'prompt' not in opts
    assert opts.get('backend') == 'rfdetr'


def test_facade_proxy_sends_prompt_threshold_and_decodes(monkeypatch):
    dets = [
        {'label': 'cat', 'score': 0.9, 'box': {'x1': 0, 'y1': 0, 'x2': 1, 'y2': 1}, 'centroid': {'x': 0.5, 'y': 0.5}}
    ]
    captured = {'dets': dets}
    monkeypatch.setattr(detmod, 'get_model_server_address', lambda: 'localhost:5590')
    monkeypatch.setattr(detmod, 'ModelClient', _fake_client_factory(captured))

    det = Detector(backend='mmgdino', threshold=0.4, prompt='cat . dog')
    assert det._proxy_mode is True

    out = det.detect(Image.new('RGB', (8, 8)))  # small image -> not downscaled
    assert captured['cmd'] == 'rrext_ms_inference'
    args = captured['args']
    assert isinstance(args['data'], (bytes, bytearray)) and args['data'][:4] == b'\x89PNG'
    assert args['output_fields'] == ['detections']
    assert args['prompt'] == 'cat . dog'
    assert args['threshold'] == 0.4
    assert out == dets  # no downscale -> boxes unchanged

    det.disconnect()
    assert captured.get('disconnected') is True


def test_facade_proxy_rescales_boxes_to_original(monkeypatch):
    """Large image is downscaled for inference; returned boxes map back to original coords."""
    dets = [
        {
            'label': 'cat',
            'score': 0.9,
            'box': {'x1': 100.0, 'y1': 50.0, 'x2': 200.0, 'y2': 150.0},
            'centroid': {'x': 150.0, 'y': 100.0},
        }
    ]
    captured = {'dets': dets}
    monkeypatch.setattr(detmod, 'get_model_server_address', lambda: 'localhost:5590')
    monkeypatch.setattr(detmod, 'ModelClient', _fake_client_factory(captured))

    det = Detector(backend='mmgdino')  # infer edge = 1333
    out = det.detect(Image.new('RGB', (2000, 1000)))  # -> downscaled to (1333, 666)

    fx, fy = 2000 / 1333, 1000 / 666
    b = out[0]['box']
    assert b['x1'] == pytest.approx(100.0 * fx)
    assert b['y2'] == pytest.approx(150.0 * fy)
    assert out[0]['centroid']['x'] == pytest.approx(150.0 * fx)
