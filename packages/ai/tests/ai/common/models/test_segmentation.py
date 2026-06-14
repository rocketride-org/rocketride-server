"""Unit tests for the segmentation loader + facade (no torch/transformers needed)."""

import ai.common.models.vision.segmentation as segmod
from ai.common.models.vision.segmentation import SegmenterLoader, Segmenter

INSTANCE_MODEL = 'facebook/mask2former-swin-tiny-coco-instance'
SEMANTIC_MODEL = 'facebook/mask2former-swin-tiny-ade-semantic'


def test_postprocess_wraps_masks():
    inst = [{'label': 'person', 'score': 0.9}]
    sem = {'semantic_map': {'size': [2, 2], 'counts': 'x'}, 'classes': {1: 'wall'}}
    out = SegmenterLoader.postprocess(None, [inst, sem], 2, ['masks'])
    assert out == [
        {'masks': inst, '$masks': inst},
        {'masks': sem, '$masks': sem},
    ]


def test_model_id_mode_is_identity():
    inst = SegmenterLoader.generate_model_id(INSTANCE_MODEL, mode='instance')
    assert inst == SegmenterLoader.generate_model_id(INSTANCE_MODEL, mode='instance')
    # Different mode -> different model identity (separate server copies).
    assert SegmenterLoader.generate_model_id(SEMANTIC_MODEL, mode='semantic') != inst


def _fake_client_factory(captured):
    class FakeClient:
        def __init__(self, addr):
            self.metadata = {}

        def load_model(self, model_name=None, model_type=None, loader_options=None):
            captured.setdefault('loads', []).append((model_name, model_type, loader_options))

        def send_command(self, command, args):
            captured['cmd'] = command
            captured['args'] = args
            return {'result': [{'masks': captured.get('masks', [])}]}

        def disconnect(self):
            captured['disconnected'] = True

    return FakeClient


def test_facade_load_once_ignores_threshold_and_maxedge(monkeypatch):
    captured = {}
    monkeypatch.setattr(segmod, 'get_model_server_address', lambda: 'localhost:5590')
    monkeypatch.setattr(segmod, 'ModelClient', _fake_client_factory(captured))

    Segmenter(mode='instance', threshold=0.1, max_edge=512)
    Segmenter(mode='instance', threshold=0.9, max_edge=2048)

    loads = captured['loads']
    assert loads[0] == loads[1]  # same identity regardless of per-request threshold / client-side max_edge
    assert loads[0][1] == 'segmentation'
    opts = loads[0][2] or {}
    assert 'threshold' not in opts and 'max_edge' not in opts
    assert opts.get('mode') == 'instance'
