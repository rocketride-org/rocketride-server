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
