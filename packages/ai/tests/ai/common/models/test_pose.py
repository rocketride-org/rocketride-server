"""Unit tests for the pose loader + facade (no onnxruntime/rtmlib needed)."""

import numpy as np
import pytest
from PIL import Image

import ai.common.models.vision.pose as posemod
from ai.common.models.vision.pose import PoseEstimatorLoader, PoseEstimator


def test_postprocess_wraps_poses():
    raw = [[{'label': 'person', 'box': {}, 'keypoints': []}], []]
    out = PoseEstimatorLoader.postprocess(None, raw, 2, ['poses'])
    person = {'label': 'person', 'box': {}, 'keypoints': []}
    assert out == [
        {'poses': [person], '$poses': [person]},
        {'poses': [], '$poses': []},
    ]


def test_build_persons_thresholds_and_caps():
    kpts = np.zeros((3, 17, 2), dtype=np.float32)
    kpts[:, :, 0] = 10.0
    kpts[:, :, 1] = 20.0
    scores = np.zeros((3, 17), dtype=np.float32)
    scores[0] = 0.9
    scores[1] = 0.5
    scores[2] = 0.05  # lowest mean -> dropped first when capped

    persons = posemod._build_persons(kpts, scores, threshold=0.3, max_persons=2)
    assert len(persons) == 2  # capped from 3
    assert persons[0]['label'] == 'person'
    assert len(persons[0]['keypoints']) == 17
    assert persons[0]['keypoints'][0]['name'] == 'nose'


def test_model_id_mode_is_identity():
    bal = PoseEstimatorLoader.generate_model_id('rtmlib-body', mode='balanced')
    assert bal == PoseEstimatorLoader.generate_model_id('rtmlib-body', mode='balanced')
    # Different mode -> different model identity (separate server copies).
    assert PoseEstimatorLoader.generate_model_id('rtmlib-body', mode='performance') != bal


def _fake_client_factory(captured):
    class FakeClient:
        def __init__(self, addr):
            self.metadata = {}

        def load_model(self, model_name=None, model_type=None, loader_options=None):
            captured.setdefault('loads', []).append((model_name, model_type, loader_options))

        def send_command(self, command, args):
            captured['cmd'] = command
            captured['args'] = args
            return {'result': [{'poses': captured.get('poses', [])}]}

        def disconnect(self):
            captured['disconnected'] = True

    return FakeClient


def test_facade_load_once_ignores_threshold_and_max_persons(monkeypatch):
    captured = {}
    monkeypatch.setattr(posemod, 'get_model_server_address', lambda: 'localhost:5590')
    monkeypatch.setattr(posemod, 'ModelClient', _fake_client_factory(captured))

    PoseEstimator(mode='balanced', threshold=0.1, max_persons=5)
    PoseEstimator(mode='balanced', threshold=0.9, max_persons=50)

    loads = captured['loads']
    assert loads[0] == loads[1]  # same identity regardless of per-request filters
    assert loads[0][1] == 'pose'
    opts = loads[0][2] or {}
    assert 'threshold' not in opts and 'max_persons' not in opts
    assert opts.get('mode') == 'balanced'


def test_facade_proxy_sends_params_and_decodes(monkeypatch):
    poses = [{'label': 'person', 'box': {'x1': 0, 'y1': 0, 'x2': 1, 'y2': 1}, 'keypoints': []}]
    captured = {'poses': poses}
    monkeypatch.setattr(posemod, 'get_model_server_address', lambda: 'localhost:5590')
    monkeypatch.setattr(posemod, 'ModelClient', _fake_client_factory(captured))

    est = PoseEstimator(mode='performance', threshold=0.4, max_persons=7)
    assert est._proxy_mode is True

    out = est.estimate(Image.new('RGB', (8, 8)))  # small -> not downscaled
    assert captured['cmd'] == 'rrext_ms_inference'
    args = captured['args']
    assert isinstance(args['data'], (bytes, bytearray)) and args['data'][:4] == b'\x89PNG'
    assert args['output_fields'] == ['poses']
    assert args['threshold'] == 0.4
    assert args['max_persons'] == 7
    assert out == poses  # no downscale -> coords unchanged

    est.disconnect()
    assert captured.get('disconnected') is True


def test_facade_proxy_rescales_poses_to_original(monkeypatch):
    """Large image is downscaled for inference; box + keypoints map back to original coords."""
    poses = [
        {
            'label': 'person',
            'box': {'x1': 100.0, 'y1': 50.0, 'x2': 200.0, 'y2': 150.0},
            'keypoints': [{'name': 'nose', 'x': 150.0, 'y': 100.0, 'score': 0.9}],
        }
    ]
    captured = {'poses': poses}
    monkeypatch.setattr(posemod, 'get_model_server_address', lambda: 'localhost:5590')
    monkeypatch.setattr(posemod, 'ModelClient', _fake_client_factory(captured))

    est = PoseEstimator(mode='balanced')
    out = est.estimate(Image.new('RGB', (2000, 1000)))  # INFER_MAX_EDGE=1333 -> (1333, 666)

    fx, fy = 2000 / 1333, 1000 / 666
    b = out[0]['box']
    assert b['x1'] == pytest.approx(100.0 * fx)
    assert b['y2'] == pytest.approx(150.0 * fy)
    kp = out[0]['keypoints'][0]
    assert kp['x'] == pytest.approx(150.0 * fx)
    assert kp['y'] == pytest.approx(100.0 * fy)
