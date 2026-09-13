"""Unit tests for the background-removal loader + facade (no torch/transformers needed)."""

import numpy as np

import ai.common.models.vision.background as bgmod
from ai.common.models.vision.background import BackgroundRemoverLoader, BackgroundRemover
from ai.common.utils.image_utils import decode_ndarray, encode_ndarray


def test_postprocess_roundtrips_alpha_array():
    alpha = (np.arange(12, dtype=np.uint8)).reshape(3, 4)
    out = BackgroundRemoverLoader.postprocess(None, [alpha], 1, ['alpha'])
    assert len(out) == 1
    enc = out[0]['alpha']
    assert enc['shape'] == [3, 4] and enc['dtype'] == 'uint8' and enc['encoding'] == 'zlib+base64'
    np.testing.assert_array_equal(decode_ndarray(enc), alpha)


def test_model_id_is_stable_and_revision_changes_identity():
    a = BackgroundRemoverLoader.generate_model_id('ZhengPeng7/BiRefNet')
    assert a == BackgroundRemoverLoader.generate_model_id('ZhengPeng7/BiRefNet')
    assert BackgroundRemoverLoader.generate_model_id('ZhengPeng7/BiRefNet', revision='abc') != a


def test_dtype_changes_model_identity():
    a = BackgroundRemoverLoader.generate_model_id('ZhengPeng7/BiRefNet')
    assert BackgroundRemoverLoader.generate_model_id('ZhengPeng7/BiRefNet', dtype='float32') != a


def test_tf32_context_sets_and_restores_flags():
    from ai.common.torch import torch

    prev_matmul = torch.backends.cuda.matmul.allow_tf32
    prev_cudnn = torch.backends.cudnn.allow_tf32
    try:
        torch.backends.cuda.matmul.allow_tf32 = False
        torch.backends.cudnn.allow_tf32 = False
        with bgmod._tf32(True):
            assert torch.backends.cuda.matmul.allow_tf32 is True
            assert torch.backends.cudnn.allow_tf32 is True
        assert torch.backends.cuda.matmul.allow_tf32 is False
        assert torch.backends.cudnn.allow_tf32 is False
    finally:
        torch.backends.cuda.matmul.allow_tf32 = prev_matmul
        torch.backends.cudnn.allow_tf32 = prev_cudnn


def test_inference_cpu_path_restores_source_resolution():
    from ai.common.torch import torch
    from PIL import Image

    input_size = 32

    class FakeBiRefNet:
        def __call__(self, tensor):
            assert tensor.shape == (1, 3, input_size, input_size)
            # Multi-scale nesting as the real model returns it; last = highest-res.
            coarse = torch.zeros(1, 1, input_size // 2, input_size // 2)
            fine = torch.linspace(-6.0, 6.0, input_size * input_size).view(1, 1, input_size, input_size)
            return [[coarse, fine]]

    bundle = {'model': FakeBiRefNet(), 'device': 'cpu', 'input_size': input_size, 'tf32': False}
    images = [Image.new('RGB', (20, 12), 'white'), Image.new('RGB', (7, 9), 'black')]
    pre = BackgroundRemoverLoader.preprocess(bundle, images)
    alphas = BackgroundRemoverLoader.inference(bundle, pre)

    assert len(alphas) == 2
    assert alphas[0].shape == (12, 20) and alphas[1].shape == (9, 7)
    for alpha in alphas:
        assert alpha.dtype == np.uint8
        # sigmoid over [-6, 6] spans (0, 1): both near-0 and near-255 must appear.
        assert alpha.min() < 16 and alpha.max() > 239


def test_facade_proxy_sends_image_and_decodes_alpha(monkeypatch):
    captured = {}
    alpha = np.full((2, 3), 200, dtype=np.uint8)

    class FakeClient:
        def __init__(self, addr):
            self.metadata = {}

        def load_model(self, model_name=None, model_type=None, loader_options=None):
            captured['load'] = (model_name, model_type, loader_options)

        def send_command(self, command, args):
            captured['cmd'] = command
            captured['args'] = args
            return {'result': [{'alpha': encode_ndarray(alpha)}]}

        def disconnect(self):
            captured['disconnected'] = True

    monkeypatch.setattr(bgmod, 'get_model_server_address', lambda: 'localhost:5590')
    monkeypatch.setattr(bgmod, 'ModelClient', FakeClient)

    rem = BackgroundRemover('ZhengPeng7/BiRefNet')
    assert rem._proxy_mode is True
    assert captured['load'][1] == 'background_removal'

    out = rem.remove(b'fake-image-bytes')
    assert captured['cmd'] == 'rrext_ms_inference'
    assert captured['args']['data'] == b'fake-image-bytes'
    assert captured['args']['output_fields'] == ['alpha']
    np.testing.assert_array_equal(out, alpha)

    rem.disconnect()
    assert captured.get('disconnected') is True
