"""Unit tests for the GLiNER loader + facade (no torch/gliner needed)."""

import sys
import types

from ai.common.models.base import BaseLoader
from ai.common.models.gliner.gliner import GLiNERLoader, GLiNER
import ai.common.models.gliner.gliner as glinermod

MODEL = 'urchade/gliner_small-v2.1'


class _FakeGLiNERModel:
    """Stand-in for the upstream gliner.GLiNER class."""

    last_from_pretrained: tuple = ()

    @classmethod
    def from_pretrained(cls, model_name, **kwargs):
        cls.last_from_pretrained = (model_name, kwargs)
        return cls()

    def to(self, device):
        return self

    def eval(self):
        return self


def _load_with_fake_upstream(monkeypatch, server_mode=False, **load_kwargs):
    """Run GLiNERLoader.load() against a fake upstream package.

    load() has two branches with their own from_pretrained() call: local (a
    device) and server (an allocate_gpu callback, CPU-first for memory
    measurement). `server_mode` picks the branch so both get covered.
    """
    _FakeGLiNERModel.last_from_pretrained = ()

    fake_pkg = types.ModuleType('gliner')
    fake_pkg.GLiNER = _FakeGLiNERModel
    monkeypatch.setitem(sys.modules, 'gliner', fake_pkg)

    monkeypatch.setattr(GLiNERLoader, '_ensure_dependencies', staticmethod(lambda: None))
    monkeypatch.setattr(GLiNERLoader, '_patch_mecab', staticmethod(lambda: None))
    monkeypatch.setattr(GLiNERLoader, '_get_memory_footprint', staticmethod(lambda model: 1.0))

    if server_mode:
        GLiNERLoader.load(MODEL, allocate_gpu=lambda memory_gb, exclude: (0, 'cpu'), **load_kwargs)
    else:
        GLiNERLoader.load(MODEL, device='cpu', **load_kwargs)
    return _FakeGLiNERModel.last_from_pretrained


def test_load_forwards_genuine_kwargs_to_from_pretrained(monkeypatch):
    """`revision` must actually reach the weights, not just the model id."""
    model_name, kwargs = _load_with_fake_upstream(monkeypatch, revision='abc')

    assert model_name == MODEL
    assert kwargs == {'revision': 'abc'}


def test_load_absorbs_inference_params_instead_of_forwarding(monkeypatch):
    """An older client may still send these in loader_options; they must not reach load."""
    _, kwargs = _load_with_fake_upstream(
        monkeypatch,
        threshold=0.3,
        flat_ner=False,
        multi_label=True,
        revision='abc',
    )

    assert kwargs == {'revision': 'abc'}


def test_server_mode_load_forwards_and_absorbs_the_same_way(monkeypatch):
    """The allocate_gpu branch has its own from_pretrained() call — cover it too."""
    model_name, kwargs = _load_with_fake_upstream(
        monkeypatch,
        server_mode=True,
        threshold=0.3,
        flat_ner=False,
        multi_label=True,
        revision='abc',
    )

    assert model_name == MODEL
    assert kwargs == {'revision': 'abc'}


def test_model_id_is_stable():
    a = GLiNERLoader.generate_model_id(MODEL)
    assert a == GLiNERLoader.generate_model_id(MODEL)  # same identity -> shared server copy


def test_model_id_ignores_inference_params():
    """Identity must not move for params load() absorbs and ignores.

    The facade no longer sends these, but an older client on a newer server
    still will. Without the exclusion each distinct threshold would hash to its
    own model_id and load another copy of identical weights — the very waste
    this change removes.
    """
    base = GLiNERLoader.generate_model_id(MODEL)

    assert GLiNERLoader.generate_model_id(MODEL, threshold=0.3) == base
    assert GLiNERLoader.generate_model_id(MODEL, threshold=0.9) == base
    assert GLiNERLoader.generate_model_id(MODEL, flat_ner=False) == base
    assert GLiNERLoader.generate_model_id(MODEL, multi_label=True) == base
    assert GLiNERLoader.generate_model_id(MODEL, threshold=0.3, flat_ner=False, multi_label=True) == base


def test_identity_exclusion_is_not_widened():
    """Guard against over-broad filtering: only the three inference params are added."""
    assert GLiNERLoader._SERVER_PARAMS == BaseLoader._SERVER_PARAMS | {'threshold', 'flat_ner', 'multi_label'}


def test_model_id_still_splits_on_genuine_load_params():
    """`revision` does reach from_pretrained(), so it must keep splitting identity."""
    assert GLiNERLoader.generate_model_id(MODEL, revision='abc') != GLiNERLoader.generate_model_id(MODEL)


def test_model_id_splits_on_model_name():
    """Sanity guard: the model itself must still drive identity."""
    assert GLiNERLoader.generate_model_id(MODEL) != GLiNERLoader.generate_model_id('urchade/gliner_large-v2.1')


class _FakeClient:
    """Captures what the facade sends to the model server."""

    captured: dict = {}

    def __init__(self, addr):
        self.metadata = {}

    def load_model(self, model_name, model_type, loader_options=None):
        _FakeClient.captured['load'] = (model_name, model_type, loader_options)

    def send_command(self, command, args):
        _FakeClient.captured['infer'] = (command, args)
        return {'result': [{'entities': [{'text': 'Google', 'label': 'organization'}]}]}

    def disconnect(self):
        pass


def _proxy_gliner(monkeypatch, **kwargs) -> GLiNER:
    _FakeClient.captured = {}
    monkeypatch.setattr(glinermod, 'get_model_server_address', lambda: 'localhost:5590')
    monkeypatch.setattr(glinermod, 'ModelClient', _FakeClient)
    return GLiNER(MODEL, **kwargs)


def test_facade_proxy_does_not_send_inference_params(monkeypatch):
    """threshold/flat_ner/multi_label are inference-time, so they must not reach loader_options."""
    model = _proxy_gliner(monkeypatch, threshold=0.3, flat_ner=False, multi_label=True)

    assert model._proxy_mode is True
    model_name, model_type, loader_options = _FakeClient.captured['load']
    assert model_name == MODEL and model_type == 'gliner'
    # load_model is called with None when there is nothing left to send.
    sent = loader_options or {}
    assert 'threshold' not in sent
    assert 'flat_ner' not in sent
    assert 'multi_label' not in sent


def test_differing_thresholds_send_identical_load_payloads(monkeypatch):
    """Acceptance criterion: GLiNER(m, threshold=0.3) and GLiNER(m, threshold=0.5) share an id.

    Asserted on the payloads rather than by hashing them: identical loader_options give an
    identical model_id by construction, whereas comparing two computed ids here would just
    compare generate_model_id(MODEL) with itself.
    """
    _proxy_gliner(monkeypatch, threshold=0.3)
    low = _FakeClient.captured['load'][2]

    _proxy_gliner(monkeypatch, threshold=0.5)
    high = _FakeClient.captured['load'][2]

    assert low == high
    assert not (low or {})  # threshold was the only difference, and it is no longer sent


def test_real_load_kwargs_still_reach_loader_options(monkeypatch):
    """Guard against over-broad filtering: genuine load kwargs must still be forwarded."""
    _proxy_gliner(monkeypatch, threshold=0.3, revision='abc')

    assert _FakeClient.captured['load'][2] == {'revision': 'abc'}


def test_inference_params_are_still_sent_per_request(monkeypatch):
    """Removing them from load must not lose them — they belong on the inference call."""
    model = _proxy_gliner(monkeypatch, threshold=0.3, flat_ner=False, multi_label=True)
    model.predict_entities('John works at Google', ['person', 'organization'])

    _, args = _FakeClient.captured['infer']
    assert args['threshold'] == 0.3
    assert args['flat_ner'] is False
    assert args['multi_label'] is True


def test_per_call_override_beats_the_instance_default(monkeypatch):
    model = _proxy_gliner(monkeypatch, threshold=0.3)
    model.predict_entities('John works at Google', ['person'], threshold=0.9)

    _, args = _FakeClient.captured['infer']
    assert args['threshold'] == 0.9
