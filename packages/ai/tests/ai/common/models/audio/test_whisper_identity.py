"""Unit tests for Whisper model identity and per-request language (no torch/faster-whisper)."""

from ai.common.models.audio.whisper import WhisperLoader, Whisper
import ai.common.models.audio.whisper as whispermod


def test_model_id_is_stable():
    a = WhisperLoader.generate_model_id('tiny')
    assert a == WhisperLoader.generate_model_id('tiny')  # same identity -> shared server copy


def test_language_is_no_longer_a_load_identity_default():
    """`language` is a decode hint, so it is not folded into identity as a load default.

    This is the narrow fix the issue asks for: the facade stops *sending* it (see
    test_facade_proxy_does_not_send_language). A caller that passes `language` straight
    to the loader still splits identity, which is intentional — unlike Surya's dead
    `languages`, this parameter is functional, so an explicit load-time value is a
    deliberate act rather than something to silently ignore.
    """
    assert WhisperLoader._DEFAULTS == {'compute_type': 'float16'}


def test_model_id_still_splits_on_compute_type():
    """compute_type genuinely changes the loaded weights, so it must remain identity."""
    fp16 = WhisperLoader.generate_model_id('tiny', compute_type='float16')
    int8 = WhisperLoader.generate_model_id('tiny', compute_type='int8')

    assert fp16 != int8


def test_model_id_still_splits_on_model_name():
    assert WhisperLoader.generate_model_id('tiny') != WhisperLoader.generate_model_id('large-v3')


class _FakeClient:
    """Captures what the facade sends to the model server."""

    captured: dict = {}

    def __init__(self, addr):
        self.metadata = {}

    def load_model(self, model_name, model_type, loader_options=None):
        _FakeClient.captured['load'] = (model_name, model_type, loader_options)

    def send_command(self, command, args):
        _FakeClient.captured['infer'] = (command, args)
        return {'result': [{'text': 'hallo welt'}]}

    def disconnect(self):
        pass


def _proxy_whisper(monkeypatch, **kwargs) -> Whisper:
    _FakeClient.captured = {}
    monkeypatch.setattr(whispermod, 'get_model_server_address', lambda: 'localhost:5590')
    monkeypatch.setattr(whispermod, 'ModelClient', _FakeClient)
    return Whisper('tiny', **kwargs)


def test_facade_proxy_does_not_send_language(monkeypatch):
    model = _proxy_whisper(monkeypatch, language='de')

    assert model._proxy_mode is True
    model_name, model_type, loader_options = _FakeClient.captured['load']
    assert model_name == 'tiny' and model_type == 'whisper'
    assert 'language' not in loader_options
    assert loader_options['compute_type'] == 'float16'  # real load param still sent


def test_differing_languages_send_identical_load_payloads(monkeypatch):
    """Acceptance criterion: Whisper('tiny', language='en'/'de') share one model_id."""
    _proxy_whisper(monkeypatch, language='en')
    en = _FakeClient.captured['load'][2]

    _proxy_whisper(monkeypatch, language='de')
    de = _FakeClient.captured['load'][2]

    # Identical loader_options -> identical identity by construction.
    assert en == de


def test_language_travels_with_the_request(monkeypatch):
    """Removing it from load must not lose it — it belongs on the transcribe call."""
    model = _proxy_whisper(monkeypatch, language='de')
    model.transcribe(b'\x00\x01' * 2000)

    _, args = _FakeClient.captured['infer']
    assert args['language'] == 'de'


def test_per_call_language_overrides_the_instance_default(monkeypatch):
    model = _proxy_whisper(monkeypatch, language='de')
    model.transcribe(b'\x00\x01' * 2000, language='fr')

    _, args = _FakeClient.captured['infer']
    assert args['language'] == 'fr'


class _FakeWhisperModel:
    """Records the decode kwargs faster-whisper would have received."""

    def __init__(self):
        self.captured = {}

    def transcribe(self, audio, **kw):
        self.captured.update(kw)
        return iter(()), type('Info', (), {'language': kw.get('language')})()


def _run_inference(bundle_language=None, preprocessed_language=None, language=None):
    model = _FakeWhisperModel()
    bundle = {'model': model}
    if bundle_language is not None:
        bundle['language'] = bundle_language

    preprocessed = {'audios': [[0.0] * 2000], 'batch_size': 1}
    if preprocessed_language is not None:
        preprocessed['language'] = preprocessed_language

    WhisperLoader.inference(bundle, preprocessed, language=language)
    return model.captured


def test_inference_falls_back_to_bundle_language():
    """Back-compat: with nothing on preprocessed, the loaded bundle value is used."""
    assert _run_inference(bundle_language='ja')['language'] == 'ja'


def test_inference_falls_back_to_preprocessed_language():
    """preprocess() carries the loaded language forward; it beats the bundle value."""
    assert _run_inference(bundle_language='ja', preprocessed_language='ko')['language'] == 'ko'


def test_inference_prefers_the_per_request_language():
    """An explicit per-request language wins over both fallbacks."""
    captured = _run_inference(bundle_language='ja', preprocessed_language='ko', language='fr')
    assert captured['language'] == 'fr'


def test_postprocess_does_not_clobber_the_request_language():
    """Regression: decoding in `fr` must not be reported as the loaded `de`."""
    bundle = {'model': _FakeWhisperModel(), 'language': 'de'}
    raw_output = [{'segments': [], 'text': 'bonjour', 'language': 'fr'}]

    results = WhisperLoader.postprocess(bundle, raw_output, 1, ['$text', 'language'], language='fr')

    assert results[0]['language'] == 'fr'


def test_postprocess_still_falls_back_to_loaded_language():
    """Callers that don't resolve a language keep the previous metadata-derived value."""
    bundle = {'model': _FakeWhisperModel(), 'language': 'de'}
    raw_output = [{'segments': [], 'text': 'hallo'}]

    results = WhisperLoader.postprocess(bundle, raw_output, 1, ['$text', 'language'])

    assert results[0]['language'] == 'de'
