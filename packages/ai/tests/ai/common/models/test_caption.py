"""Unit tests for the caption loader + facade (no torch/transformers needed)."""

import ai.common.models.vision.caption as capmod
from ai.common.models.vision.caption import CaptionerLoader, Captioner


def test_postprocess_wraps_captions():
    out = CaptionerLoader.postprocess(None, ['a cat', 'a dog'], 2, ['caption'])
    assert out == [{'caption': 'a cat'}, {'caption': 'a dog'}]


def test_model_id_is_stable_and_revision_changes_identity():
    a = CaptionerLoader.generate_model_id('microsoft/Florence-2-base')
    assert a == CaptionerLoader.generate_model_id('microsoft/Florence-2-base')
    assert CaptionerLoader.generate_model_id('microsoft/Florence-2-base', revision='abc') != a


def _fake_client_factory(captured):
    class FakeClient:
        def __init__(self, addr):
            self.metadata = {}

        def load_model(self, model_name=None, model_type=None, loader_options=None):
            captured.setdefault('loads', []).append((model_name, model_type, loader_options))

        def send_command(self, command, args):
            captured['cmd'] = command
            captured['args'] = args
            return {'result': [{'caption': captured.get('caption', '')}]}

        def disconnect(self):
            captured['disconnected'] = True

    return FakeClient


def test_facade_load_once_ignores_task(monkeypatch):
    captured = {}
    monkeypatch.setattr(capmod, 'get_model_server_address', lambda: 'localhost:5590')
    monkeypatch.setattr(capmod, 'ModelClient', _fake_client_factory(captured))

    Captioner(task='caption')
    Captioner(task='more_detailed_caption')

    loads = captured['loads']
    assert loads[0] == loads[1]  # same identity regardless of per-request task
    assert loads[0][1] == 'caption'
    assert 'task' not in (loads[0][2] or {})


def test_facade_proxy_sends_task_and_decodes(monkeypatch):
    captured = {'caption': 'a person standing'}
    monkeypatch.setattr(capmod, 'get_model_server_address', lambda: 'localhost:5590')
    monkeypatch.setattr(capmod, 'ModelClient', _fake_client_factory(captured))

    cap = Captioner(task='detailed_caption')
    assert cap._proxy_mode is True

    out = cap.caption(b'fake-image-bytes')
    assert captured['cmd'] == 'rrext_ms_inference'
    args = captured['args']
    assert args['data'] == b'fake-image-bytes'
    assert args['output_fields'] == ['caption']
    assert args['task'] == 'detailed_caption'
    assert out == 'a person standing'

    cap.disconnect()
    assert captured.get('disconnected') is True
