"""Unit tests for Whisper model identity and per-request decode parameters.

Covers `language` (#1751) plus `beam_size` / `vad_filter` / `vad_parameters` (#1809).
No torch, no faster-whisper, no model download.
"""

import sys
import types

import pytest

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
    """Records the decode kwargs faster-whisper would have received, one entry per call."""

    def __init__(self):
        self.calls = []

    @property
    def captured(self):
        """Kwargs of the most recent call, for the single-audio tests."""
        return self.calls[-1] if self.calls else {}

    def transcribe(self, audio, **kw):
        self.calls.append(dict(kw))
        return iter(()), type('Info', (), {'language': kw.get('language')})()


def _run_inference(bundle_language=None, preprocessed_language=None, audios=None, **decode_kwargs):
    """Run inference() against a fake model and return it.

    Returns the model, not its kwargs, so batch tests can reach `.calls`.
    """
    model = _FakeWhisperModel()
    bundle = {'model': model}
    if bundle_language is not None:
        bundle['language'] = bundle_language

    if audios is None:
        audios = [[0.0] * 2000]
    preprocessed = {'audios': audios, 'batch_size': len(audios)}
    if preprocessed_language is not None:
        preprocessed['language'] = preprocessed_language

    WhisperLoader.inference(bundle, preprocessed, **decode_kwargs)
    return model


def test_inference_falls_back_to_bundle_language():
    """Back-compat: with nothing on preprocessed, the loaded bundle value is used."""
    assert _run_inference(bundle_language='ja').captured['language'] == 'ja'


def test_inference_falls_back_to_preprocessed_language():
    """preprocess() carries the loaded language forward; it beats the bundle value."""
    assert _run_inference(bundle_language='ja', preprocessed_language='ko').captured['language'] == 'ko'


def test_inference_prefers_the_per_request_language():
    """An explicit per-request language wins over both fallbacks."""
    captured = _run_inference(bundle_language='ja', preprocessed_language='ko', language='fr').captured
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


# -----------------------------------------------------------------------------
# beam_size (#1809)
# -----------------------------------------------------------------------------


def test_beam_size_defaults_to_five():
    assert _run_inference().captured['beam_size'] == 5


def test_beam_size_is_forwarded():
    """1 is the value #1809's acceptance criterion names; 10 is the other end."""
    assert _run_inference(beam_size=1).captured['beam_size'] == 1
    assert _run_inference(beam_size=10).captured['beam_size'] == 10


# -----------------------------------------------------------------------------
# vad_filter (#1809)
# -----------------------------------------------------------------------------


def test_vad_filter_defaults_to_true():
    """Deliberate divergence: WhisperModel.transcribe defaults it to False upstream."""
    assert _run_inference().captured['vad_filter'] is True


def test_vad_filter_is_forwarded_both_ways():
    assert _run_inference(vad_filter=False).captured['vad_filter'] is False
    assert _run_inference(vad_filter=True).captured['vad_filter'] is True


def test_vad_parameters_are_still_sent_when_the_filter_is_off():
    """faster-whisper ignores them, but skipping the merge would be a silent change."""
    assert _run_inference(vad_filter=False).captured['vad_parameters'] == WhisperLoader._VAD_DEFAULTS


# -----------------------------------------------------------------------------
# vad_parameters (#1809)
# -----------------------------------------------------------------------------


def test_vad_parameters_unset_uses_the_defaults():
    assert _run_inference().captured['vad_parameters'] == WhisperLoader._VAD_DEFAULTS
    assert _run_inference(vad_parameters=None).captured['vad_parameters'] == WhisperLoader._VAD_DEFAULTS


def test_vad_parameters_empty_dict_agrees_with_none():
    """`{}` is a distinct input a JSON caller can send; it must not mean something else."""
    assert _run_inference(vad_parameters={}).captured['vad_parameters'] == WhisperLoader._VAD_DEFAULTS


@pytest.mark.parametrize(
    'key,value',
    [('threshold', 0.3), ('min_silence_duration_ms', 250), ('speech_pad_ms', 100)],
)
def test_vad_parameters_override_is_per_key(key, value):
    """Overriding one key must leave every other default intact."""
    merged = _run_inference(vad_parameters={key: value}).captured['vad_parameters']

    assert merged[key] == value
    for other, default in WhisperLoader._VAD_DEFAULTS.items():
        if other != key:
            assert merged[other] == default


def test_vad_parameters_can_replace_every_default():
    override = {'threshold': 0.9, 'min_silence_duration_ms': 10, 'speech_pad_ms': 0}

    assert _run_inference(vad_parameters=override).captured['vad_parameters'] == override


def test_vad_parameters_adds_keys_we_do_not_default():
    """The audio_transcribe node relies on this — max_speech_duration_s is not ours."""
    merged = _run_inference(vad_parameters={'max_speech_duration_s': 2}).captured['vad_parameters']

    assert merged['max_speech_duration_s'] == 2
    assert merged['threshold'] == WhisperLoader._VAD_DEFAULTS['threshold']


def test_vad_parameters_drops_a_nested_none():
    merged = _run_inference(vad_parameters={'threshold': None}).captured['vad_parameters']

    assert merged['threshold'] == WhisperLoader._VAD_DEFAULTS['threshold']


def test_vad_parameters_keeps_a_nested_zero():
    """Filter on `is None`, not truthiness — 0 is meaningful for both of these."""
    merged = _run_inference(vad_parameters={'threshold': 0, 'speech_pad_ms': 0}).captured['vad_parameters']

    assert merged['threshold'] == 0
    assert merged['speech_pad_ms'] == 0


def test_vad_defaults_are_never_mutated():
    original = dict(WhisperLoader._VAD_DEFAULTS)

    first = _run_inference(vad_parameters={'max_speech_duration_s': 2}).captured['vad_parameters']
    second = _run_inference(vad_parameters={'threshold': 0.1}).captured['vad_parameters']

    assert first['max_speech_duration_s'] == 2
    assert 'max_speech_duration_s' not in second  # no leak between calls
    assert WhisperLoader._VAD_DEFAULTS == original


# -----------------------------------------------------------------------------
# word_timestamps (#1809)
# -----------------------------------------------------------------------------


def test_word_timestamps_defaults_to_false():
    """Matches upstream; turning it on costs an alignment pass and moves boundaries."""
    assert _run_inference().captured['word_timestamps'] is False


def test_word_timestamps_is_forwarded():
    assert _run_inference(word_timestamps=True).captured['word_timestamps'] is True


class _WordyWhisperModel:
    """Yields a segment carrying word timings, as faster-whisper does when asked."""

    def transcribe(self, audio, **kw):
        word = type('W', (), {'word': ' hi', 'start': 0.1, 'end': 0.4, 'probability': 0.9})()
        segment = type('S', (), {'start': 0.0, 'end': 0.5, 'text': ' hi', 'words': [word]})()
        return iter((segment,)), type('Info', (), {'language': 'en'})()


def test_words_reach_the_result():
    """seg_dict['words'] was unreachable before #1809 — nothing ever passed the flag."""
    preprocessed = {'audios': [[0.0] * 2000], 'batch_size': 1}

    results = WhisperLoader.inference({'model': _WordyWhisperModel()}, preprocessed, word_timestamps=True)

    assert results[0]['segments'][0]['words'] == [{'word': ' hi', 'start': 0.1, 'end': 0.4, 'probability': 0.9}]


# -----------------------------------------------------------------------------
# Cross-cutting (#1809)
# -----------------------------------------------------------------------------


def test_all_decode_parameters_travel_together():
    """Resolution differs per parameter — `language` has fallbacks, the others do not."""
    captured = _run_inference(language='fr', beam_size=3, vad_filter=False, vad_parameters={'threshold': 0.2}).captured

    assert captured['language'] == 'fr'
    assert captured['beam_size'] == 3
    assert captured['vad_filter'] is False
    assert captured['vad_parameters']['threshold'] == 0.2


def test_every_item_in_a_batch_gets_the_same_decode_kwargs():
    model = _run_inference(audios=[[0.0] * 2000, [0.0] * 3000], beam_size=7)

    assert len(model.calls) == 2
    assert model.calls[0] == model.calls[1]
    assert model.calls[0]['beam_size'] == 7


def test_a_too_short_clip_is_skipped_without_losing_the_parameters():
    """Under the 1600-sample floor the loop `continue`s; the long clip still decodes."""
    model = _run_inference(audios=[[0.0] * 100, [0.0] * 2000], beam_size=9)

    assert len(model.calls) == 1
    assert model.calls[0]['beam_size'] == 9


class _RaisingWhisperModel:
    """Stands in for faster-whisper rejecting an unknown VadOptions key."""

    def transcribe(self, audio, **kw):
        raise TypeError("__init__() got an unexpected keyword argument 'nonsense'")


def test_a_bad_vad_key_degrades_one_item_instead_of_killing_the_batch():
    """New in #1809: the dict now reaches the decoder, so a typo can fail."""
    bundle = {'model': _RaisingWhisperModel()}
    preprocessed = {'audios': [[0.0] * 2000, [0.0] * 2000], 'batch_size': 2}

    results = WhisperLoader.inference(bundle, preprocessed, vad_parameters={'nonsense': 1})

    assert len(results) == 2
    for item in results:
        assert item['error']
        assert item['segments'] == []
        assert item['text'] == ''


# -----------------------------------------------------------------------------
# Identity and facade (#1809)
# -----------------------------------------------------------------------------


def test_decode_parameters_never_reach_loader_options(monkeypatch):
    """#1809 acceptance: the names never reach generate_model_id(), which hashes
    whatever it is handed — it does not ignore them.
    """
    model = _proxy_whisper(monkeypatch)
    model.transcribe(
        b'\x00\x01' * 2000, beam_size=10, vad_filter=False, vad_parameters={'threshold': 0.1}, word_timestamps=True
    )

    _, _, loader_options = _FakeClient.captured['load']
    assert loader_options == {'compute_type': 'float16'}


@pytest.mark.parametrize(
    'param,value',
    [
        ('language', 'de'),
        ('beam_size', 10),
        ('vad_filter', False),
        ('vad_parameters', {'threshold': 0.1}),
        ('word_timestamps', True),
    ],
)
def test_decode_params_in_loader_options_do_not_split_identity(param, value):
    """An old client may still send these at load; they must not duplicate the weights.

    Enforced by _SERVER_PARAMS, so it holds even though the facade no longer sends them.
    """
    assert WhisperLoader.generate_model_id('tiny', **{param: value}) == WhisperLoader.generate_model_id('tiny')


def test_genuine_loader_options_still_split_identity():
    """The other half: revision changes the weights, so it must change the id."""
    assert WhisperLoader.generate_model_id('tiny', revision='abc') != WhisperLoader.generate_model_id('tiny')


class _RecordingWhisperModel:
    """Captures what load() hands the faster-whisper constructor."""

    captured = {}

    def __init__(self, model_name, **kw):
        _RecordingWhisperModel.captured = {'model_name': model_name, **kw}


def _load_with(monkeypatch, **loader_options):
    fake = types.ModuleType('faster_whisper')
    fake.WhisperModel = _RecordingWhisperModel
    monkeypatch.setitem(sys.modules, 'faster_whisper', fake)
    monkeypatch.setattr(WhisperLoader, 'model_gpu_gb', staticmethod(lambda *a, **k: 0.0), raising=False)

    WhisperLoader.load('tiny', device='cpu', **loader_options)
    return _RecordingWhisperModel.captured


def test_load_absorbs_decode_params_instead_of_forwarding_them(monkeypatch):
    """WhisperModel() does not accept them — forwarding blindly would raise."""
    captured = _load_with(monkeypatch, beam_size=10, vad_filter=False, word_timestamps=True)

    for name in ('beam_size', 'vad_filter', 'vad_parameters', 'word_timestamps'):
        assert name not in captured


def test_load_forwards_genuine_loader_options(monkeypatch):
    """Before this, revision changed the model id but never reached the constructor."""
    captured = _load_with(monkeypatch, revision='abc123')

    assert captured['revision'] == 'abc123'


def test_facade_puts_all_four_on_the_wire(monkeypatch):
    model = _proxy_whisper(monkeypatch)
    model.transcribe(
        b'\x00\x01' * 2000, beam_size=10, vad_filter=False, vad_parameters={'threshold': 0.1}, word_timestamps=True
    )

    _, args = _FakeClient.captured['infer']
    assert args['beam_size'] == 10
    assert args['vad_filter'] is False
    assert args['vad_parameters'] == {'threshold': 0.1}
    assert args['word_timestamps'] is True


def _local_whisper(monkeypatch, recorder):
    """A local-mode Whisper with no faster-whisper and no model download.

    Without the address patch it silently takes the proxy path and asserts nothing.
    """
    monkeypatch.setattr(whispermod, 'get_model_server_address', lambda: None)
    monkeypatch.setattr(WhisperLoader, 'load', staticmethod(lambda *a, **k: ({'model': _FakeWhisperModel()}, {}, -1)))
    monkeypatch.setattr(WhisperLoader, 'inference', staticmethod(recorder))
    return Whisper('tiny', output_fields=['$text'])


def _recording_inference(calls):
    """inference() stand-in returning a real result list — postprocess() runs on it."""

    def _inference(model, preprocessed, metadata=None, stream=None, **kw):
        calls.append(kw)
        return [{'segments': [], 'text': '', 'language': 'en'}]

    return _inference


def test_local_mode_forwards_all_four(monkeypatch):
    """The half no acceptance criterion covers: local mode ignored these too."""
    calls = []
    model = _local_whisper(monkeypatch, _recording_inference(calls))
    model.transcribe(
        b'\x00\x01' * 2000, beam_size=4, vad_filter=False, vad_parameters={'threshold': 0.2}, word_timestamps=True
    )

    assert calls[0]['beam_size'] == 4
    assert calls[0]['vad_filter'] is False
    assert calls[0]['vad_parameters'] == {'threshold': 0.2}
    assert calls[0]['word_timestamps'] is True


def test_local_and_remote_hand_the_loader_the_same_vad_parameters(monkeypatch):
    """Parity for the facade's vad_parameters=None default.

    Remote's None-drop happens in saas extract_infer_kwargs — not assertable here.
    """
    calls = []
    local = _local_whisper(monkeypatch, _recording_inference(calls))
    local.transcribe(b'\x00\x01' * 2000)

    remote = _proxy_whisper(monkeypatch)
    remote.transcribe(b'\x00\x01' * 2000)
    _, args = _FakeClient.captured['infer']

    assert calls[0]['vad_parameters'] is None
    assert args['vad_parameters'] is None
