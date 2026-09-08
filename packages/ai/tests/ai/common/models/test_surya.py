"""Unit tests for the Surya loader + facade (no torch/surya needed)."""

from ai.common.models.base import BaseLoader
from ai.common.models.ocr.surya import SuryaLoader, Surya
import ai.common.models.ocr.surya as suryamod


def test_model_id_is_stable():
    a = SuryaLoader.generate_model_id('surya')
    assert a == SuryaLoader.generate_model_id('surya')  # same identity -> shared server copy


def test_model_id_ignores_languages():
    """Surya 0.17+ auto-detects language, so `languages` must not split model identity."""
    base = SuryaLoader.generate_model_id('surya')
    en = SuryaLoader.generate_model_id('surya', languages=['en'])
    multi = SuryaLoader.generate_model_id('surya', languages=['en', 'de', 'fr'])

    # All three resolve to one server-side copy of the ~3GB weights.
    assert base == en == multi


def test_identity_exclusion_is_not_widened():
    """Guard against over-broad filtering: `languages` is the only addition to the base set.

    Asserting on a sample loader kwarg instead would be misleading here — `SuryaLoader.load()`
    ignores `**kwargs` entirely, so no extra kwarg actually changes the loaded predictors.
    """
    assert SuryaLoader._SERVER_PARAMS == BaseLoader._SERVER_PARAMS | {'languages'}


class _FakeClient:
    """Captures what the facade sends to the model server."""

    captured: dict = {}

    def __init__(self, addr):
        self.metadata = {}

    def load_model(self, model_name, model_type, loader_options=None):
        _FakeClient.captured['load'] = (model_name, model_type, loader_options)

    def disconnect(self):
        pass


def _proxy_surya(monkeypatch, **kwargs) -> Surya:
    _FakeClient.captured = {}
    monkeypatch.setattr(suryamod, 'get_model_server_address', lambda: 'localhost:5590')
    monkeypatch.setattr(suryamod, 'ModelClient', _FakeClient)
    return Surya(**kwargs)


def test_facade_proxy_does_not_send_languages(monkeypatch):
    ocr = _proxy_surya(monkeypatch, languages=['en', 'de'])

    assert ocr._proxy_mode is True
    model_name, model_type, loader_options = _FakeClient.captured['load']
    assert model_name == 'surya' and model_type == 'surya'
    assert 'languages' not in loader_options


def test_facade_still_accepts_languages_and_forwards_other_kwargs(monkeypatch):
    """`languages` stays on the public signature (no-op) and is the only key dropped.

    `revision` here is a stand-in for "any other kwarg" — it verifies the facade
    still forwards what it is given rather than swallowing everything. It is not
    a load parameter in any meaningful sense: `SuryaLoader.load()` accepts
    `**kwargs` and never reads them, so nothing a caller passes changes the
    loaded predictors, while it does still split model identity. That is the
    same class of waste this PR removes for `languages`, reachable through a
    different door, and it wants its own fix rather than a wider exclusion here.
    """
    ocr = _proxy_surya(monkeypatch, languages=['ja'], revision='abc')

    assert ocr.languages == ['ja']  # preserved on the facade for backwards compatibility
    _, _, loader_options = _FakeClient.captured['load']
    assert loader_options == {'revision': 'abc'}


def test_identity_stable_if_an_older_client_still_sends_languages():
    """The facade no longer sends `languages`, but an older client on a newer server may."""
    base = SuryaLoader.generate_model_id('surya')
    assert SuryaLoader.generate_model_id('surya', languages=['en', 'de']) == base
