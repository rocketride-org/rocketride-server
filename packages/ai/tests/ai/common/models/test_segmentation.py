"""Unit tests for the segmentation loader + facade (no transformers/weights needed;
the sam3 fakes run the real filtering math on small torch tensors).
"""

import ai.common.models.vision.segmentation as segmod
from ai.common.models.vision.segmentation import SegmenterLoader, Segmenter, Sam3ConceptLoader

INSTANCE_MODEL = 'facebook/mask2former-swin-tiny-coco-instance'
SEMANTIC_MODEL = 'facebook/mask2former-swin-tiny-ade-semantic'
SAM3_MODEL = 'facebook/sam3'


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


# ---------------------------------------------------------------------------
# SAM 3 concept backend (mocked model/processor — no weight downloads)
# ---------------------------------------------------------------------------


class _FakeTensor:
    """Minimal stand-in for processor-batch tensors (pixel_values/input_ids)."""

    def __init__(self, data):
        self._data = data

    def to(self, *_args, **_kwargs):
        return self


class _FakeBatch(dict):
    def to(self, device):
        return self


class _FakeVision:
    """Stand-in for Sam3VisionEncoderOutput (rebuilt via type(vision)(...) when batching)."""

    def __init__(self, fpn_hidden_states=(), fpn_position_encoding=()):
        self.fpn_hidden_states = fpn_hidden_states
        self.fpn_position_encoding = fpn_position_encoding


class _FakeSam3Outputs:
    """Raw-output stand-in carrying real torch tensors for the GPU-side filter path."""

    def __init__(self, pred_logits, pred_masks, pred_boxes, presence_logits=None):
        self.pred_logits = pred_logits
        self.pred_masks = pred_masks
        self.pred_boxes = pred_boxes
        self.presence_logits = presence_logits


class _FakeModel:
    """Model stand-in for the cached-vision batched forward path."""

    def __init__(self, outputs=None):
        self._outputs = outputs

    def get_vision_features(self, pixel_values=None):
        return _FakeVision()

    def __call__(self, vision_embeds=None, input_ids=None, attention_mask=None, **kwargs):
        return self._outputs


def _sam3_outputs(scores, mask_logits, boxes):
    """Build fake raw outputs from per-query scores (as probabilities -> logits),
    mask logits, and NORMALIZED xyxy boxes — all batch-major lists.
    """
    import math

    from ai.common.torch import torch

    logits = [[math.log(s / (1.0 - s)) for s in row] for row in scores]
    return _FakeSam3Outputs(
        pred_logits=torch.tensor(logits, dtype=torch.float32),
        pred_masks=torch.tensor(mask_logits, dtype=torch.float32),
        pred_boxes=torch.tensor(boxes, dtype=torch.float32),
    )


def _make_sam3_backend(outputs, captured, threshold=0.5):
    """Assemble a Sam3ConceptLoader without running __init__ (no weight downloads)."""
    from ai.common.torch import torch

    class FakeProcessor:
        def __call__(self, images=None, text=None, return_tensors=None):
            captured.setdefault('calls', []).append(text)
            captured['text'] = text
            return _FakeBatch(pixel_values=_FakeTensor([0]), input_ids=_FakeTensor([0]), attention_mask=None)

    backend = Sam3ConceptLoader.__new__(Sam3ConceptLoader)
    backend.model_name = SAM3_MODEL
    backend.threshold = threshold
    backend.device = 'cpu'
    backend._processor = FakeProcessor()
    backend._model = _FakeModel(outputs)
    backend._torch = torch
    backend._dtype = torch.float32
    return backend


def test_sam3_empty_prompt_returns_empty_without_inference():
    captured = {}
    backend = _make_sam3_backend(None, captured)

    from PIL import Image

    img = Image.new('RGB', (8, 8))
    assert backend.segment(img, prompt='') == []
    assert backend.segment(img, prompt='   ') == []
    assert backend.segment(img) == []
    assert 'text' not in captured  # processor never invoked


def test_sam3_output_contract(monkeypatch):
    """Output-shape contract: [{label, score, box{x1,y1,x2,y2}, mask(RLE)}], threshold-filtered."""
    import numpy as np
    from PIL import Image

    monkeypatch.setattr(segmod, '_encode_rle', lambda m: {'size': list(np.asarray(m).shape), 'counts': 'stub'})

    keep = np.zeros((8, 8))
    keep[2:5, 3:6] = 1
    kept_logits = (keep * 20.0 - 10.0).tolist()  # binarizes back to `keep` at MASK_THRESHOLD
    solid = np.full((8, 8), 10.0).tolist()  # all-ones mask but low score -> filtered
    empty = np.full((8, 8), -10.0).tolist()  # high score but empty mask -> skipped

    captured = {}
    outputs = _sam3_outputs(
        scores=[[0.91, 0.2, 0.9]],
        mask_logits=[[kept_logits, solid, empty]],
        boxes=[[[3 / 8, 2 / 8, 6 / 8, 5 / 8], [0, 0, 1, 1], [0, 0, 0, 0]]],
    )
    backend = _make_sam3_backend(outputs, captured, threshold=0.5)

    out = backend.segment(Image.new('RGB', (8, 8)), prompt='yellow school bus')

    assert captured['text'] == ['yellow school bus']

    # low-score instance filtered, all-empty mask skipped -> exactly one instance
    assert len(out) == 1
    inst = out[0]
    assert set(inst) == {'label', 'score', 'box', 'mask'}
    assert inst['label'] == 'yellow school bus'
    assert abs(inst['score'] - 0.91) < 1e-6
    assert inst['box'] == {'x1': 3.0, 'y1': 2.0, 'x2': 6.0, 'y2': 5.0}
    assert inst['mask'] == {'size': [8, 8], 'counts': 'stub'}


def test_sam3_prompt_list_splits_into_one_query_per_concept(monkeypatch):
    """' . '-separated prompts (the detect node convention) fan out to one PCS
    query per concept — batched into a single forward — each instance labelled
    with the concept it matched.
    """
    import numpy as np
    from PIL import Image

    monkeypatch.setattr(segmod, '_encode_rle', lambda m: {'size': list(np.asarray(m).shape), 'counts': 'stub'})

    solid = np.full((4, 4), 10.0).tolist()
    captured = {}
    outputs = _sam3_outputs(
        scores=[[0.9], [0.9], [0.9]],
        mask_logits=[[solid], [solid], [solid]],
        boxes=[[[0, 0, 1, 1]], [[0, 0, 1, 1]], [[0, 0, 1, 1]]],
    )
    backend = _make_sam3_backend(outputs, captured)

    out = backend.segment(Image.new('RGB', (4, 4)), prompt='grass . tree .  stairs ')
    assert captured['calls'] == [['grass', 'tree', 'stairs']]  # one batched processor call
    assert [inst['label'] for inst in out] == ['grass', 'tree', 'stairs']

    captured.clear()
    assert backend.segment(Image.new('RGB', (4, 4)), prompt=' . . ') == []
    assert 'calls' not in captured  # separators only: no inference


def test_sam3_threshold_override(monkeypatch):
    import numpy as np
    from PIL import Image

    monkeypatch.setattr(segmod, '_encode_rle', lambda m: {'size': list(np.asarray(m).shape), 'counts': 'stub'})

    solid = np.full((4, 4), 10.0).tolist()
    captured = {}
    outputs = _sam3_outputs(scores=[[0.4]], mask_logits=[[solid]], boxes=[[[0, 0, 1, 1]]])
    backend = _make_sam3_backend(outputs, captured, threshold=0.5)

    assert backend.segment(Image.new('RGB', (4, 4)), prompt='cat') == []  # 0.4 < default 0.5
    out = backend.segment(Image.new('RGB', (4, 4)), prompt='cat', threshold=0.3)
    assert len(out) == 1 and abs(out[0]['score'] - 0.4) < 1e-6


def test_sam3_model_id_mode_is_identity():
    sam3 = SegmenterLoader.generate_model_id(SAM3_MODEL, mode='sam3')
    assert sam3 == SegmenterLoader.generate_model_id(SAM3_MODEL, mode='sam3')
    assert sam3 != SegmenterLoader.generate_model_id(INSTANCE_MODEL, mode='instance')


def test_loader_inference_passes_prompt():
    calls = []

    class FakeBackend:
        def segment(self, img, prompt=None, threshold=None):
            calls.append((img, prompt, threshold))
            return []

    bundle = {'segmenter': FakeBackend(), 'mode': 'sam3'}
    out = SegmenterLoader.inference(bundle, {'images': ['img1']}, prompt='cat', threshold=0.4)
    assert calls == [('img1', 'cat', 0.4)]
    assert out == [[]]


def test_facade_sam3_prompt_is_per_request_not_identity(monkeypatch):
    from PIL import Image

    captured = {'masks': []}
    monkeypatch.setattr(segmod, 'get_model_server_address', lambda: 'localhost:5590')
    monkeypatch.setattr(segmod, 'ModelClient', _fake_client_factory(captured))

    seg = Segmenter(mode='sam3', prompt='yellow school bus', threshold=0.5)
    opts = captured['loads'][0][2] or {}
    assert opts.get('mode') == 'sam3'
    assert 'prompt' not in opts  # per-request, not part of model identity

    out = seg.segment(Image.new('RGB', (8, 8)))
    assert captured['cmd'] == 'rrext_ms_inference'
    assert captured['args']['prompt'] == 'yellow school bus'
    assert out == []

    # Per-call override wins over the constructor default.
    seg.segment(Image.new('RGB', (8, 8)), prompt='red kayak')
    assert captured['args']['prompt'] == 'red kayak'
