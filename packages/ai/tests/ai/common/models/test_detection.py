"""Unit tests for the detection loader + facade (no torch/transformers needed)."""

import contextlib
import sys
import types

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
    assert DetectorLoader.generate_model_id('PekingU/rtdetr_r50vd', backend='rfdetr', dtype='float32') != rfdetr
    # Different checkpoint -> different model identity (llmdet tiny vs large).
    assert DetectorLoader.generate_model_id('iSEE-Laboratory/llmdet_tiny', backend='llmdet') != (
        DetectorLoader.generate_model_id('iSEE-Laboratory/llmdet_large', backend='llmdet')
    )


def test_llmdet_backend_registered():
    """The llmdet backend is open-vocab (prompt required by the node) and defaults to the tiny checkpoint."""
    assert 'llmdet' in detmod.BACKENDS
    assert detmod.BACKENDS['llmdet'].open_vocab is True
    assert detmod.BACKENDS['llmdet'].model == 'iSEE-Laboratory/llmdet_tiny'
    assert 'llmdet' in detmod.OPEN_VOCAB_BACKENDS


def test_build_backend_llmdet_uses_mmgdino_loader(monkeypatch):
    """The llmdet backend routes to MmGDinoLoader (LLMDet is architecturally MM-Grounding-DINO)."""
    captured = {}

    def fake_init(self, model_name=None, threshold=0.3, text_threshold=0.25, device=None, revision=None):
        captured['model'], captured['device'] = model_name, device

    monkeypatch.setattr(detmod.MmGDinoLoader, '__init__', fake_init)

    det = detmod._build_backend('llmdet', 'iSEE-Laboratory/llmdet_large', 'cpu')
    assert isinstance(det, detmod.MmGDinoLoader)
    assert captured['model'] == 'iSEE-Laboratory/llmdet_large'
    assert captured['device'] == 'cpu'


def test_build_backend_default_model_follows_backend(monkeypatch):
    """load(backend='mmgdino') without model_name must resolve the mmgdino model,
    not the rfdetr default (which crashes AutoModelForZeroShotObjectDetection).
    """
    from ai.common.models.vision.detection import BACKENDS

    built = {}

    def fake_build(backend, model_name, device, revision=None):
        built['backend'], built['model'] = backend, model_name
        return object()

    monkeypatch.setattr(detmod, '_build_backend', fake_build)
    monkeypatch.setattr(DetectorLoader, '_ensure_dependencies', staticmethod(lambda: None))

    DetectorLoader.load(backend='mmgdino', device='cpu')
    assert built['backend'] == 'mmgdino'
    assert built['model'] == BACKENDS['mmgdino'].model


def test_untie_mm_gdino_bbox_heads_strips_only_bbox_ties_within_scope():
    original = {
        'bbox_embed.(?![0])\\d+': 'bbox_embed.0',
        'class_embed.(?![0])\\d+': '^class_embed.0',
        'model.decoder.bbox_embed': 'bbox_embed',
        'model.decoder.class_embed': 'class_embed',
    }

    class FakeModelCls:
        _tied_weights_keys = dict(original)

    with detmod._untie_mm_gdino_bbox_heads(FakeModelCls):
        # Inside the scope: bbox_embed ties gone, class_embed ties intact.
        assert FakeModelCls._tied_weights_keys == {
            'class_embed.(?![0])\\d+': '^class_embed.0',
            'model.decoder.class_embed': 'class_embed',
        }

    # After the scope the original ties are fully restored, so a later
    # decoder_bbox_embed_share=True checkpoint in the same process still gets
    # its layer-0 head tied into layers 1..5.
    assert FakeModelCls._tied_weights_keys == original


def test_untie_mm_gdino_bbox_heads_restores_on_error():
    original = {
        'bbox_embed.(?![0])\\d+': 'bbox_embed.0',
        'model.decoder.class_embed': 'class_embed',
    }

    class FakeModelCls:
        _tied_weights_keys = dict(original)

    with pytest.raises(RuntimeError):
        with detmod._untie_mm_gdino_bbox_heads(FakeModelCls):
            raise RuntimeError('load failed')
    assert FakeModelCls._tied_weights_keys == original


def test_untie_mm_gdino_bbox_heads_noop_without_bbox_ties():
    # Fixed-upstream fallback: no bbox_embed entries -> nothing changes,
    # inside or after the scope.
    only_class = {
        'class_embed.(?![0])\\d+': '^class_embed.0',
        'model.decoder.class_embed': 'class_embed',
    }

    class FakeModelCls:
        _tied_weights_keys = dict(only_class)

    with detmod._untie_mm_gdino_bbox_heads(FakeModelCls):
        assert FakeModelCls._tied_weights_keys == only_class
    assert FakeModelCls._tied_weights_keys == only_class


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


# ---------------------------------------------------------------------------
# GPU safety: transformers post-processing converts tensors with .numpy(),
# which raises c10 TypeError for CUDA tensors and killed the model server on
# GPU boxes. These tests simulate that with fake tensors that raise on
# .numpy() unless on 'cpu', so the crash is caught without a GPU.
# ---------------------------------------------------------------------------


class _FakeTensor:
    """Minimal tensor stand-in: .numpy() raises off-CPU, exactly like torch."""

    def __init__(self, values, device='cuda:1'):
        self.values = list(values)
        self.device = device

    def detach(self):
        return self

    def cpu(self):
        return _FakeTensor(self.values, device='cpu')

    def numpy(self):
        if self.device != 'cpu':
            raise TypeError(
                f"can't convert {self.device} device type tensor to numpy. "
                'Use Tensor.cpu() to copy the tensor to host memory first.'
            )
        return list(self.values)

    def tolist(self):
        return list(self.values)


class _FakeOutputs:
    """ModelOutput-like container: dict-style items() + attribute access."""

    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)

    def items(self):
        return self.__dict__.items()


class _FakeBatch(dict):
    """BatchEncoding stand-in: mapping (for **inputs) with .input_ids and .to()."""

    def __init__(self, device='cpu'):
        super().__init__(input_ids=_FakeTensor([101, 102], device=device))

    @property
    def input_ids(self):
        return self['input_ids']

    def to(self, device):
        return _FakeBatch(device=device)


def _install_fake_torch(monkeypatch):
    """Provide ai.common.torch (inference_mode only) without importing real torch."""
    mod = types.ModuleType('ai.common.torch')
    mod.torch = types.SimpleNamespace(inference_mode=contextlib.nullcontext)
    monkeypatch.setitem(sys.modules, 'ai.common.torch', mod)


def test_outputs_to_cpu_moves_all_tensors():
    out = _FakeOutputs(
        logits=_FakeTensor([0.4], device='cuda:1'),
        pred_boxes=_FakeTensor([0.1, 0.2, 0.3, 0.4], device='cuda:1'),
        loss=None,
    )
    moved = detmod._outputs_to_cpu(out)
    assert isinstance(moved, _FakeOutputs)
    assert moved.logits.device == 'cpu' and moved.pred_boxes.device == 'cpu'
    assert moved.logits.numpy() == [0.4]  # raises unless actually on CPU
    assert moved.loss is None  # non-tensor fields pass through
    assert out.logits.device == 'cuda:1'  # original untouched


def test_mmgdino_postprocess_receives_host_tensors(monkeypatch):
    """detect() must hand transformers CPU tensors and plain (h, w) sizes even
    when the model runs on CUDA — the fake processor replicates transformers'
    internal .numpy() calls, which crash on any CUDA tensor.
    """
    _install_fake_torch(monkeypatch)
    captured = {}

    class _FakeGDinoProcessor:
        def __call__(self, images=None, text=None, return_tensors=None):
            return _FakeBatch()

        def post_process_grounded_object_detection(
            self, outputs, input_ids, threshold=None, text_threshold=None, target_sizes=None
        ):
            # v5 signature: `box_threshold` was renamed to `threshold`.
            outputs.logits.numpy()  # what transformers does internally
            outputs.pred_boxes.numpy()
            input_ids.numpy()
            if hasattr(target_sizes, 'numpy'):
                target_sizes.numpy()
            captured['target_sizes'] = target_sizes
            captured['threshold'] = threshold
            return [
                {
                    'scores': [0.9],
                    'labels': ['cat'],
                    'boxes': [_FakeTensor([1.0, 2.0, 3.0, 4.0], device='cpu')],
                }
            ]

    det = detmod.MmGDinoLoader.__new__(detmod.MmGDinoLoader)
    det.device = 'cuda:1'
    det.threshold = 0.3
    det.text_threshold = 0.25
    det._processor = _FakeGDinoProcessor()
    det._model = lambda **inputs: _FakeOutputs(
        logits=_FakeTensor([0.4], device='cuda:1'),
        pred_boxes=_FakeTensor([0.1, 0.2, 0.3, 0.4], device='cuda:1'),
    )

    out = det.detect(Image.new('RGB', (8, 8)), prompt='cat')

    assert out == [detmod._to_detection('cat', 0.9, 1.0, 2.0, 3.0, 4.0)]
    assert captured['target_sizes'] == [(8, 8)]  # plain python, never a CUDA tensor
    assert captured['threshold'] == 0.3


def test_rtdetr_postprocess_receives_host_tensors():
    """Same guarantee for the RT-DETR fallback path."""
    captured = {}

    class _FakeRtProcessor:
        def __call__(self, images=None, return_tensors=None):
            return _FakeBatch()

        def post_process_object_detection(self, outputs, target_sizes=None, threshold=None):
            outputs.logits.numpy()  # what transformers does internally
            outputs.pred_boxes.numpy()
            if hasattr(target_sizes, 'numpy'):
                target_sizes.numpy()
            captured['target_sizes'] = target_sizes
            return [
                {
                    'scores': [0.8],
                    'labels': [3],
                    'boxes': [_FakeTensor([1.0, 2.0, 3.0, 4.0], device='cpu')],
                }
            ]

    det = detmod.RFDetrLoader.__new__(detmod.RFDetrLoader)
    det.device = 'cuda:1'
    det.threshold = 0.3
    det._impl = 'rtdetr'
    det._labels = {3: 'dog'}
    det._torch = types.SimpleNamespace(inference_mode=contextlib.nullcontext)
    det._processor = _FakeRtProcessor()
    det._model = lambda **inputs: _FakeOutputs(
        logits=_FakeTensor([0.4], device='cuda:1'),
        pred_boxes=_FakeTensor([0.1, 0.2, 0.3, 0.4], device='cuda:1'),
    )

    out = det.detect(Image.new('RGB', (8, 8)))

    assert out == [detmod._to_detection('dog', 0.8, 1.0, 2.0, 3.0, 4.0)]
    assert captured['target_sizes'] == [(8, 8)]
