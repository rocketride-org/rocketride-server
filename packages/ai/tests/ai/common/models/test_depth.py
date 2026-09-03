"""Unit tests for the depth loader + facade (no torch/transformers needed)."""

import numpy as np

from ai.common.models.vision.depth import DepthEstimatorLoader, DepthEstimator
from ai.common.utils.image_utils import decode_ndarray, encode_ndarray
import ai.common.models.vision.depth as depthmod


def test_postprocess_encodes_quantized_grid_with_scale():
    q = np.arange(12, dtype=np.uint16).reshape(3, 4)
    out = DepthEstimatorLoader.postprocess(None, [{'q': q, 'lo': 1.5, 'step': 0.25}], 1, ['depth'])
    assert len(out) == 1
    enc = out[0]['depth']
    assert enc['shape'] == [3, 4] and enc['dtype'] == 'uint16' and enc['encoding'] == 'zlib+base64'
    assert out[0]['depth_min'] == 1.5 and out[0]['depth_step'] == 0.25
    np.testing.assert_array_equal(decode_ndarray(enc), q)


def test_model_id_is_stable_and_revision_changes_identity():
    a = DepthEstimatorLoader.generate_model_id('depth-anything/X')
    b = DepthEstimatorLoader.generate_model_id('depth-anything/X')
    assert a == b  # same identity -> shared server copy (load-once)
    assert DepthEstimatorLoader.generate_model_id('depth-anything/X', revision='abc') != a
    assert DepthEstimatorLoader.generate_model_id('depth-anything/X', dtype='float32') != a


def test_inference_cpu_downsamples_to_source_and_quantizes():
    from ai.common.torch import torch
    from PIL import Image

    grid = torch.linspace(0.0, 4.0, 8 * 10).view(1, 8, 10)

    class FakeOutput:
        predicted_depth = grid

    class FakeModel:
        def __call__(self, pixel_values):
            return FakeOutput()

    class FakeProcessor:
        def __call__(self, images=None, return_tensors=None):
            return {'pixel_values': torch.zeros(1, 3, 8, 10)}

    bundle = {'model': FakeModel(), 'processor': FakeProcessor(), 'device': 'cpu', 'tf32': False}
    image = Image.new('RGB', (5, 4))  # smaller than the 10x8 grid -> downsample to source
    pre = DepthEstimatorLoader.preprocess(bundle, [image])
    out = DepthEstimatorLoader.inference(bundle, pre)

    assert len(out) == 1
    item = out[0]
    assert item['q'].shape == (4, 5) and item['q'].dtype == np.uint16
    # Dequantized values must match the bilinear-downsampled grid within one step.
    ref = (
        torch.nn.functional.interpolate(grid.unsqueeze(1), size=(4, 5), mode='bilinear', align_corners=False)
        .squeeze()
        .numpy()
    )
    recon = item['lo'] + item['q'].astype(np.float32) * item['step']
    assert np.abs(recon - ref).max() <= item['step'] + 1e-6


def test_inference_cpu_keeps_native_grid_for_larger_sources():
    from ai.common.torch import torch
    from PIL import Image

    class FakeOutput:
        predicted_depth = torch.zeros(1, 8, 10)

    class FakeModel:
        def __call__(self, pixel_values):
            return FakeOutput()

    class FakeProcessor:
        def __call__(self, images=None, return_tensors=None):
            return {'pixel_values': torch.zeros(1, 3, 8, 10)}

    bundle = {'model': FakeModel(), 'processor': FakeProcessor(), 'device': 'cpu', 'tf32': False}
    image = Image.new('RGB', (40, 30))  # larger than the grid -> keep native resolution
    out = DepthEstimatorLoader.inference(bundle, DepthEstimatorLoader.preprocess(bundle, [image]))
    assert out[0]['q'].shape == (8, 10)


def test_facade_proxy_sends_image_and_decodes(monkeypatch):
    captured = {}

    class FakeClient:
        def __init__(self, addr):
            self.metadata = {}

        def load_model(self, model_name, model_type, loader_options=None):
            captured['load'] = (model_name, model_type, loader_options)

        def send_command(self, command, args):
            captured['infer'] = (command, args)
            return {'result': [{'depth': encode_ndarray(np.ones((2, 3), dtype=np.float32))}]}

        def disconnect(self):
            captured['disconnected'] = True

    monkeypatch.setattr(depthmod, 'get_model_server_address', lambda: 'localhost:5590')
    monkeypatch.setattr(depthmod, 'ModelClient', FakeClient)

    est = DepthEstimator('depth-anything/X')
    assert est._proxy_mode is True
    assert captured['load'][1] == 'depth'  # registered under the 'depth' model_type

    out = est.estimate(b'fake-image-bytes')
    cmd, args = captured['infer']
    assert cmd == 'rrext_ms_inference'
    assert args['data'] == b'fake-image-bytes' and args['output_fields'] == ['depth']
    np.testing.assert_array_equal(out, np.ones((2, 3), dtype=np.float32))

    est.disconnect()
    assert captured.get('disconnected') is True


def test_facade_dequantizes_and_restores_resolution(monkeypatch):
    """New wire format: uint16 + scale factors, restored to the input image's size."""
    from PIL import Image

    q = np.array([[0, 65535], [65535, 0]], dtype=np.uint16)

    class FakeClient:
        def __init__(self, addr):
            self.metadata = {}

        def load_model(self, model_name, model_type, loader_options=None):
            pass

        def send_command(self, command, args):
            return {'result': [{'depth': encode_ndarray(q), 'depth_min': 2.0, 'depth_step': 1.0 / 65535}]}

        def disconnect(self):
            pass

    monkeypatch.setattr(depthmod, 'get_model_server_address', lambda: 'localhost:5590')
    monkeypatch.setattr(depthmod, 'ModelClient', FakeClient)

    est = DepthEstimator('depth-anything/X')
    out = est.estimate(Image.new('RGB', (4, 6)))
    assert out.shape == (6, 4) and out.dtype == np.float32
    # Dequantized range: min..max maps back to 2.0..3.0.
    assert abs(float(out.min()) - 2.0) < 1e-3 and abs(float(out.max()) - 3.0) < 1e-3
