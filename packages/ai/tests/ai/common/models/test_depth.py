"""Unit tests for the depth loader + facade (no torch/transformers needed)."""

import numpy as np

from ai.common.models.vision.depth import DepthEstimatorLoader, DepthEstimator
from ai.common.utils.image_utils import decode_ndarray, encode_ndarray
import ai.common.models.vision.depth as depthmod


class _FakeTensor:
    """Stand-in for a torch tensor's .squeeze().detach().cpu().float().numpy() chain."""

    def __init__(self, arr):
        self._a = arr

    def squeeze(self):
        return self

    def detach(self):
        return self

    def cpu(self):
        return self

    def float(self):
        return self

    def numpy(self):
        return self._a


def test_postprocess_roundtrips_depth_array():
    arr = np.arange(12, dtype=np.float32).reshape(3, 4)
    out = DepthEstimatorLoader.postprocess(None, [{'predicted_depth': _FakeTensor(arr)}], 1, ['depth'])
    assert len(out) == 1
    enc = out[0]['depth']
    assert enc['shape'] == [3, 4] and enc['dtype'] == 'float32' and enc['encoding'] == 'zlib+base64'
    np.testing.assert_array_equal(decode_ndarray(enc), arr)


def test_model_id_is_stable_and_revision_changes_identity():
    a = DepthEstimatorLoader.generate_model_id('depth-anything/X')
    b = DepthEstimatorLoader.generate_model_id('depth-anything/X')
    assert a == b  # same identity -> shared server copy (load-once)
    assert DepthEstimatorLoader.generate_model_id('depth-anything/X', revision='abc') != a


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
