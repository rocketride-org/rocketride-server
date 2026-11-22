# =============================================================================
# MIT License
#
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================


"""
One control, two calls: the per-call parameters of the remaining nodes (C.26).

Each test builds a node's control once (its IGlobal begun once, or, for a node
that keeps nothing on its control, the control's resolved config alone) and
binds two or more fresh instances to it with different params, the way the
engine binds one call after another. Each call must behave by its own values
and the control must not be rebuilt. The schemas themselves (which leaves are
params, which are caller-only, and that ``IGlobal.config`` refuses them) are
checked in ``test_c26_tools_params.py``. No test reaches a provider.
"""

from __future__ import annotations

import importlib
import json
import sys
import threading
import time
from types import ModuleType, SimpleNamespace

import pytest
from ai.common.schema import Question

from .framework.controls import bind_call, control_config, resolved_config

# ==== Helpers ====================================================================


def _control(node: str, logical_type: str, stored=None):
    """
    One control's IGlobal over the engine-resolved config, begun once.

    Args:
        node: The node package (``nodes.<dir>``).
        logical_type: The service's logical type.
        stored: The node's stored config.

    Returns:
        The IGlobal after ``beginGlobal``.
    """
    glb = importlib.import_module(f'{node}.IGlobal').IGlobal()
    glb._config_restricted = control_config(logical_type, stored)
    glb.beginGlobal()
    return glb


def _call(node: str, glb, params=None):
    """A fresh instance of the node bound to one call of the control."""
    return bind_call(importlib.import_module(f'{node}.IInstance').IInstance(), glb, params)


class _JsonAnswer:
    """Stand-in for an incoming JSON ``Answer``: what the answer-lane nodes read of it."""

    def __init__(self, payload):
        self._payload = payload

    def isJson(self):  # noqa: N802 (engine method name)
        return True

    def getJson(self):  # noqa: N802 (engine method name)
        return self._payload

    def getText(self):  # noqa: N802 (engine method name)
        return json.dumps(self._payload)


def _no_prevent():
    """A preventDefault that fails the test: the call was expected to forward normally."""
    raise AssertionError('preventDefault was not expected on this call')


# ==== authoritative_overlay ======================================================


def test_authoritative_overlay_checks_each_call_against_its_own_company(monkeypatch):
    node = 'nodes.authoritative_overlay'
    asked = []

    def query_sec(concept, cik, filters, submission_cache):
        asked.append((cik, submission_cache))
        return [1.0]

    monkeypatch.setattr(importlib.import_module(f'{node}.IInstance'), 'query_sec', query_sec)
    glb = _control(node, 'authoritative-overlay')
    fact = {'concept': 'AccountsPayableCurrent', 'value': '$1', 'form': '10-K', 'fy': 2025}
    for params in ({}, {'cik': '789019'}, {}):
        instance = _call(node, glb, params)
        instance.preventDefault = _no_prevent
        instance.writeAnswers(_JsonAnswer(fact))

    (first, first_cache), (second, second_cache), (third, third_cache) = asked
    assert (first, second, third) == ('0000320193', '0000789019', '0000320193')
    # One control: the same company's submissions are reused, another company has its own
    assert first_cache is third_cache
    assert first_cache is not second_cache


# ==== normalize_facts ============================================================


def test_normalize_facts_applies_each_calls_rules():
    # The node keeps nothing on its control: the control is its config
    control = control_config('normalize_facts')
    fact = {'label': 'Weird Line XYZ', 'value': '42'}
    emitted = []
    for params in ({}, {'default_currency': 'eur', 'label_to_metric': {'Weird Line XYZ': 'widgets'}}):
        instance = _call('nodes.normalize_facts', control, params)
        instance.instance = SimpleNamespace(writeAnswers=emitted.append)
        instance.preventDefault = lambda: None
        instance.open(None)
        instance.writeAnswers(_JsonAnswer(dict(fact)))
        instance.closing()

    first, second = (answer.getJson()['normalized'] for answer in emitted)
    assert (first['currency'], first['metric']) == ('', 'weird line xyz')
    assert (second['currency'], second['metric']) == ('EUR', 'widgets')


# ==== schema_validate ============================================================


def test_schema_validate_checks_each_call_by_its_own_rules():
    control = control_config('schema_validate')
    fact = {'total': 5, 'currency': 'USD'}
    flagged = []
    for params in ({}, {'amount_field': 'total', 'require_provenance': 'off'}):
        instance = _call('nodes.schema_validate', control, params)
        instance.beginInstance()
        emitted = []
        instance.instance = SimpleNamespace(writeAnswers=emitted.append)
        instance.preventDefault = lambda: None
        instance.open(None)
        instance.writeAnswers(_JsonAnswer(dict(fact)))
        instance.closing()
        flagged.append({flag['code'] for flag in emitted[0].getJson()['validation']['flags']})

    assert {'missing_amount', 'missing_provenance'} <= flagged[0]
    assert not flagged[1] & {'missing_amount', 'missing_provenance'}


def test_schema_validate_refuses_a_blank_field_name_per_call():
    instance = _call('nodes.schema_validate', control_config('schema_validate'), {'amount_field': '  '})
    with pytest.raises(ValueError, match='amount_field must name a fact field'):
        instance.beginInstance()


# ==== preprocessor_code ==========================================================


def test_preprocessor_code_splits_each_call_in_its_own_language():
    seen = []
    splitter = SimpleNamespace(process=lambda text, language: seen.append(language) or [])
    glb = SimpleNamespace(config=control_config('preprocessor_code'), preprocessor=splitter)
    for params in ({}, {'language': 'python'}):
        instance = _call('nodes.preprocessor_code', glb, params)
        current = SimpleNamespace(objectId='o1', path='/a.py', permissionId=0, componentId='c1')
        instance.instance = SimpleNamespace(currentObject=current)
        instance.IEndpoint = SimpleNamespace(endpoint=SimpleNamespace(jobConfig={'nodeId': 'n1'}))
        instance._writeTableOrText('def f():\n    return 1\n')
    # One splitter (the control's parser cache) served both calls
    assert seen == ['auto', 'python']


# ==== preprocessor_langchain =====================================================


def test_preprocessor_langchain_keeps_one_splitter_per_distinct_setting():
    node = 'nodes.preprocessor_langchain'
    glb = _control(node, 'preprocessor_langchain')
    calls = [
        _call(node, glb),
        _call(node, glb, {'splitter': 'CharacterTextSplitter', 'strlen': 12, 'CharacterTextSplitter.separator': "' '"}),
        _call(node, glb),
    ]
    splitters = [glb.preprocessor_for(instance.settings) for instance in calls]

    # The same settings share one splitter; another call's settings build their own
    assert splitters[0] is splitters[2]
    assert splitters[0] is not splitters[1]
    assert (type(splitters[0]._preprocessor).__name__, splitters[0]._splitSize) == (
        'RecursiveCharacterTextSplitter',
        512,
    )
    assert (type(splitters[1]._preprocessor).__name__, splitters[1]._splitSize) == ('CharacterTextSplitter', 12)
    assert splitters[1]._preprocessor._separator == ' '
    glb.endGlobal()


def test_preprocessor_langchain_bounds_its_splitters():
    node = 'nodes.preprocessor_langchain'
    module = importlib.import_module(f'{node}.IGlobal')
    glb = _control(node, 'preprocessor_langchain')
    for size in range(1, module.MAX_SPLITTERS + 3):
        glb.preprocessor_for(_call(node, glb, {'strlen': size}).settings)
    assert len(glb._splitters) == module.MAX_SPLITTERS
    glb.endGlobal()


# ==== scan_cropper ===============================================================


def test_scan_cropper_binds_each_call_to_its_own_tunables(monkeypatch):
    bound = []
    process = importlib.import_module('nodes.scan_cropper.process')
    monkeypatch.setattr(
        process, 'build_split_scan', lambda settings: bound.append(settings) or (lambda image, want: None)
    )
    control = control_config('scan_cropper')
    for params in ({}, {'profile': 'loose', 'deskew': False, 'loose.detectSize': 900}):
        _call('nodes.scan_cropper', control, params).beginInstance()

    defaults = resolved_config('scan_cropper')
    first, second = bound
    assert (first.profile, first.deskew, first.detectSize) == (defaults.profile, defaults.deskew, defaults.detectSize)
    assert (second.profile, second.deskew, second.detectSize) == ('loose', False, 900)


# ==== guardrails =================================================================


def test_guardrails_applies_each_calls_policy():
    control = control_config('guardrails')
    blocking = {'profile': 'custom', 'custom.policy_mode': 'block', 'custom.blocked_topics': ['weapons']}
    outcomes = []
    for params in ({}, blocking):
        instance = _call('nodes.guardrails', control, params)
        instance.beginInstance()
        forwarded = []
        instance.instance = SimpleNamespace(writeQuestions=forwarded.append)
        instance.preventDefault = lambda: None
        question = Question()
        question.addQuestion('Where can I buy weapons?')
        instance.writeQuestions(question)
        outcomes.append(len(forwarded))

    # The basic policy has no topic list and forwards; the custom call blocks the topic
    assert outcomes == [1, 0]


# ==== anonymize ==================================================================


class _RecordingRecognizer:
    """Stands in for the GLiNER recognizer: records each call's labels and redaction."""

    def __init__(self):
        self.calls = []

    def process(self, text, labels, existing_matches=None, *, redaction_style, anonymize_char):
        self.calls.append((labels, redaction_style, anonymize_char))
        return text


def test_anonymize_redacts_each_call_by_its_own_settings():
    recognizer = _RecordingRecognizer()
    glb = SimpleNamespace(config=control_config('anonymize_text'), recognizer=recognizer)
    for params in ({}, {'redactionStyle': 'token', 'anonymizeChar': '*', 'entityTypes': ['email', ' ']}):
        instance = _call('nodes.anonymize', glb, params)
        instance.instance = SimpleNamespace(writeText=lambda text: None)
        instance.preventDefault = lambda: None
        instance.open(None)
        instance.writeText('Mail ann@example.com')
        instance.closing()

    (default_labels, default_style, default_char), second = recognizer.calls
    assert (default_style, default_char) == ('mask', '\u2588')
    assert 'email' in default_labels and 'person' in default_labels
    # A blank entry is dropped; the call's list is used as given otherwise
    assert second == (['email'], 'token', '*')


# ==== ner ========================================================================


def test_ner_filters_each_call_by_its_own_threshold():
    thresholds = []
    recognizer = SimpleNamespace(extract_entities=lambda text, min_confidence: thresholds.append(min_confidence) or [])
    glb = SimpleNamespace(config=control_config('ner'), recognizer=recognizer)
    for params in ({}, {'bertLarge.min_confidence': 0.5}):
        instance = _call('nodes.ner', glb, params)
        instance.beginInstance()
        instance.instance = SimpleNamespace(writeText=lambda text: None)
        instance.preventDefault = lambda: None
        instance.writeText('Barack Obama')
    assert thresholds == [0.9, 0.5]


# ==== audio_transcribe ===========================================================


class _RecordingWhisper:
    """Stands in for ai.common.models.Whisper: counts loads, records each request's decode values."""

    built = 0

    def __init__(self, model_name, output_fields=None, compute_type=None, **kwargs):
        type(self).built += 1
        self.requests = []

    def transcribe(self, audio, **kwargs):
        self.requests.append(kwargs)
        return {'$segments': []}


def test_audio_transcribe_decodes_each_call_by_its_own_settings(monkeypatch):
    node = 'nodes.audio_transcribe'
    monkeypatch.setattr(importlib.import_module(f'{node}.IGlobal'), 'Whisper', _RecordingWhisper)
    _RecordingWhisper.built = 0
    glb = _control(node, 'audio_transcribe')
    for params in ({}, {'language': 'de', 'beam_size': 1, 'vad_max_speech_duration_s': 30}):
        glb.transcribe(b'\x00\x01' * 800, _call(node, glb, params).settings)

    first, second = glb._whisper.requests
    assert _RecordingWhisper.built == 1
    assert (first['language'], first['beam_size'], 'max_speech_duration_s' in first['vad_parameters']) == (
        'en',
        5,
        False,
    )
    assert (second['language'], second['beam_size'], second['vad_parameters']['max_speech_duration_s']) == (
        'de',
        1,
        30,
    )


# ==== audio_tts ==================================================================


class _RecordingModelClient:
    """Stands in for the model-server client: one per loaded language, records the voices it speaks."""

    loaded = []

    def __init__(self, address):
        self.voices = []

    def load_model(self, repo, loader, options):
        type(self).loaded.append(options['lang_code'])

    def send_command(self, command, arguments):
        self.voices.append(arguments['inputs'][0]['voice'])
        return {'result': [{'wav_base64': 'UklGRg=='}]}

    def disconnect(self):
        pass


def test_audio_tts_keeps_one_engine_per_language(monkeypatch, tmp_path):
    import os

    module = importlib.import_module('nodes.audio_tts.IGlobal')
    monkeypatch.setattr(module, 'get_model_server_address', lambda: 'ms:5590')
    monkeypatch.setattr(module, 'ModelClient', _RecordingModelClient)
    _RecordingModelClient.loaded = []
    glb = _control('nodes.audio_tts', 'audio_tts')
    for params in ({}, {'kokoro_voice': 'bf_emma'}, {'kokoro_voice': 'af_bella'}):
        result = glb.synthesize('hello', _call('nodes.audio_tts', glb, params).settings.kokoro_voice)
        os.remove(result['path'])

    # Two languages, two loaders; the second American voice reuses the first loader
    assert _RecordingModelClient.loaded == ['a', 'b']
    assert glb._clients['a'].voices == ['af_heart', 'af_bella']
    assert glb._clients['b'].voices == ['bf_emma']
    glb.endGlobal()


class _UnloadableModelClient:
    """Stands in for a model-server client that connects but cannot load its model, nor close cleanly."""

    built = []

    def __init__(self, address):
        self.disconnected = False
        type(self).built.append(self)

    def load_model(self, repo, loader, options):
        raise ConnectionError('Model load failed: no kokoro loader')

    def disconnect(self):
        self.disconnected = True
        raise RuntimeError('the socket is already gone')


def test_audio_tts_closes_a_client_whose_model_fails_to_load(monkeypatch):
    module = importlib.import_module('nodes.audio_tts.IGlobal')
    monkeypatch.setattr(module, 'get_model_server_address', lambda: 'ms:5590')
    monkeypatch.setattr(module, 'ModelClient', _UnloadableModelClient)
    _UnloadableModelClient.built = []
    glb = _control('nodes.audio_tts', 'audio_tts')
    for _ in range(2):
        with pytest.raises(ConnectionError, match='no kokoro loader'):
            glb.synthesize('hello', 'af_heart')

    # Each failed load closed its own connection, a failing close did not mask the load error, nothing was cached
    assert [client.disconnected for client in _UnloadableModelClient.built] == [True, True]
    assert glb._clients == {}
    glb.endGlobal()


class _SlowBritishModelClient(_RecordingModelClient):
    """A model-server client whose British loader blocks until released."""

    release = None
    entered = None

    def load_model(self, repo, loader, options):
        if options['lang_code'] == 'b':
            type(self).entered.set()
            type(self).release.wait(5)
        super().load_model(repo, loader, options)


def test_audio_tts_a_slow_language_load_never_blocks_a_loaded_language(monkeypatch, tmp_path):
    import os
    from concurrent.futures import ThreadPoolExecutor

    module = importlib.import_module('nodes.audio_tts.IGlobal')
    monkeypatch.setattr(module, 'get_model_server_address', lambda: 'ms:5590')
    monkeypatch.setattr(module, 'ModelClient', _SlowBritishModelClient)
    _SlowBritishModelClient.loaded = []
    _SlowBritishModelClient.release = threading.Event()
    _SlowBritishModelClient.entered = threading.Event()
    glb = _control('nodes.audio_tts', 'audio_tts')
    os.remove(glb.synthesize('hello', 'af_heart')['path'])

    # A British call stalls on its first load; an American call on the loaded
    # language is served meanwhile, and two British calls load it once. Futures
    # carry each worker's result or exception back to this thread
    with ThreadPoolExecutor(max_workers=2) as pool:
        stalled = [pool.submit(glb.synthesize, 'hello', 'bf_emma') for _ in range(2)]
        assert _SlowBritishModelClient.entered.wait(5), 'the British load never started'
        started = time.monotonic()
        os.remove(glb.synthesize('hello', 'af_bella')['path'])
        assert time.monotonic() - started < 1
        _SlowBritishModelClient.release.set()
        for future in stalled:
            os.remove(future.result(5)['path'])
    assert _SlowBritishModelClient.loaded == ['a', 'b']
    glb.endGlobal()


# ==== embedding_openai ===========================================================


class _RecordingEmbeddings:
    """Stands in for langchain_openai.OpenAIEmbeddings: one per model, records what it embeds."""

    built = []

    def __init__(self, openai_api_key, model):
        type(self).built.append(model)
        self.model = model
        self.embedding_ctx_length = 8191

    def embed_query(self, text):
        return [0.0, 1.0, 2.0]

    def embed_documents(self, texts):
        return [[0.0, 1.0, 2.0] for _ in texts]


def test_embedding_openai_embeds_each_call_with_its_own_model(monkeypatch):
    from ai.common.schema import Question

    module = importlib.import_module('nodes.embedding_openai.OpenAIEmbeddingWrapper')
    monkeypatch.setattr(module, 'OpenAIEmbeddings', _RecordingEmbeddings)
    _RecordingEmbeddings.built = []
    config = control_config('embedding_openai', {'apikey': 'k1'})
    glb = SimpleNamespace(config=config, embedding=module.OpenAIEmbeddingWrapper('embedding_openai', config, {}))
    models = []
    for params in ({}, {'model': 'text-embedding-3-large'}, {}):
        question = Question()
        question.addQuestion('what is it?')
        _call('nodes.embedding_openai', glb, params).writeQuestions(question)
        models.append(question.questions[0].embedding_model)

    assert models == ['text-embedding-3-small', 'text-embedding-3-large', 'text-embedding-3-small']
    # One embedder per model, built on first use (no rebuild for the repeated model)
    assert _RecordingEmbeddings.built == ['text-embedding-3-small', 'text-embedding-3-large']


class _GatedEmbeddings(_RecordingEmbeddings):
    """A recording embedder whose large model's probe waits on a gate the test opens."""

    probing = None  #: Set when the large model's probe starts.
    gate = None  #: The probe returns once this is set.

    def embed_query(self, text):
        if text == 'dummy' and self.model == 'text-embedding-3-large':
            type(self).probing.set()
            type(self).gate.wait(5)
        return super().embed_query(text)


def test_embedding_openai_probes_a_cold_model_without_holding_up_a_built_one(monkeypatch):
    import threading
    from concurrent.futures import ThreadPoolExecutor

    module = importlib.import_module('nodes.embedding_openai.OpenAIEmbeddingWrapper')
    monkeypatch.setattr(module, 'OpenAIEmbeddings', _GatedEmbeddings)
    _GatedEmbeddings.built, _GatedEmbeddings.probing, _GatedEmbeddings.gate = [], threading.Event(), threading.Event()
    wrapper = module.OpenAIEmbeddingWrapper('embedding_openai', {'apikey': 'k1'}, {})
    wrapper.getVectorSize('text-embedding-3-small')

    # Two first calls of the large model; the first one's probe is held at the gate.
    # Futures carry each worker's result or exception back to this thread
    with ThreadPoolExecutor(max_workers=3) as pool:
        cold = [pool.submit(wrapper.getVectorSize, 'text-embedding-3-large') for _ in range(2)]
        assert _GatedEmbeddings.probing.wait(5)
        warm = pool.submit(wrapper.getVectorSize, 'text-embedding-3-small')
        # The built model answers while the large model's probe is held
        assert warm.result(2) == 3
        _GatedEmbeddings.gate.set()
        assert [future.result(5) for future in cold] == [3, 3]

    # The large model was built once for both callers
    assert _GatedEmbeddings.built == ['text-embedding-3-small', 'text-embedding-3-large']


# ==== embedding_transformer ======================================================


def test_embedding_transformer_encodes_each_call_with_its_own_knobs():
    from ai.common.schema import Question

    encoded = []
    embedding = SimpleNamespace(
        encodeQuestion=lambda question, prefix, truncate_dim: encoded.append((prefix, truncate_dim))
    )
    stored = {'profile': 'custom', 'custom': {'model': 'sentence-transformers/all-MiniLM-L6-v2'}}
    glb = SimpleNamespace(config=control_config('embedding_transformer', stored), embedding=embedding)
    for params in ({}, {'custom.truncate_dim': 64, 'custom.query_prefix': 'query: '}):
        instance = _call('nodes.embedding_transformer', glb, params)
        instance.beginInstance()
        question = Question()
        question.addQuestion('what is it?')
        instance.writeQuestions(question)
    assert encoded == [('', 0), ('query: ', 64)]


def test_embedding_transformer_truncates_the_leading_dimensions():
    import numpy as np

    module = importlib.import_module('nodes.embedding_transformer.sentenceTransformer')
    vectors = np.arange(12, dtype=np.float32).reshape(2, 6)
    assert module.Embedding._truncate(vectors, 4).tolist() == [[0, 1, 2, 3], [6, 7, 8, 9]]
    assert module.Embedding._truncate(vectors, 0) is vectors


# ==== embedding_video ============================================================


def test_embedding_video_caps_each_call_at_its_own_size():
    from rocketlib import AVI_ACTION

    glb = SimpleNamespace(config=control_config('embedding_video'))
    accepted = []
    for params in ({}, {'extraction.maxVideoSizeMB': 1}):
        instance = _call('nodes.embedding_video', glb, params)
        instance._video_data = bytearray()
        instance.writeVideo(AVI_ACTION.WRITE, 'video/mp4', b'\x00' * (2 * 1024 * 1024))
        accepted.append(instance._video_data is not None)
    # The default 500 MB cap takes the 2 MB clip; the call capped at 1 MB rejects it
    assert accepted == [True, False]


# ==== rerank_cohere ==============================================================


def test_rerank_cohere_reranks_each_call_with_its_own_model_and_bounds():
    from ai.common.schema import Doc

    calls = []
    reranker = SimpleNamespace(rerank_with_threshold=lambda **kwargs: calls.append(kwargs) or [])
    glb = SimpleNamespace(config=control_config('rerank_cohere', {'apikey': 'k1'}), _reranker=reranker)
    custom = {'profile': 'custom', 'custom.model': 'my-reranker', 'top_n': 2, 'min_score': 0.4}
    for params in ({}, custom):
        instance = _call('nodes.rerank_cohere', glb, params)
        instance.instance = SimpleNamespace(writeDocuments=lambda docs: None, writeAnswers=lambda answer: None)
        question = Question()
        question.addQuestion('what is it?')
        question.documents.append(Doc(page_content='a document'))
        instance.writeQuestions(question)

    assert [(c['model'], c['top_n'], c['min_score']) for c in calls] == [
        ('rerank-english-v3.0', 5, 0.0),
        ('my-reranker', 2, 0.4),
    ]


# ==== accessibility_describe =====================================================


def test_accessibility_describe_prompts_each_call_by_its_own_settings():
    from rocketlib import AVI_ACTION

    asked = []
    chat = SimpleNamespace(
        chat=lambda question, system_prompt: (
            asked.append((question.questions[0].text, system_prompt))
            or SimpleNamespace(getText=lambda: 'a description')
        )
    )
    glb = SimpleNamespace(config=control_config('accessibility_describe', {'apikey': 'k1'}), chat=chat)
    for params in ({}, {'prompt': 'Read the sign.', 'spatialFormat': 'relative', 'prioritizeHazards': 'low'}):
        instance = _call('nodes.accessibility_describe', glb, params)
        instance.instance = SimpleNamespace(writeText=lambda text: None)
        instance.preventDefault = lambda: None
        for action, buffer in ((AVI_ACTION.BEGIN, b''), (AVI_ACTION.WRITE, b'\x89PNG'), (AVI_ACTION.END, b'')):
            instance.writeImage(action, 'image/png', buffer)

    (first_prompt, first_system), (second_prompt, second_system) = asked
    assert first_prompt.startswith('Describe this image for a blind person.')
    assert 'clock positions' in first_system and 'MUST lead with hazards' in first_system
    assert second_prompt == 'Read the sign.'
    assert 'relative directions' in second_system and 'MUST lead with hazards' not in second_system


# ==== search_exa =================================================================


def test_search_exa_sends_each_call_its_own_search_knobs(monkeypatch):
    module = importlib.import_module('nodes.search_exa.exa_search')
    sent = []

    def post(url, headers, json, timeout):
        sent.append(json)
        return SimpleNamespace(status_code=200, json=lambda: {'results': []})

    monkeypatch.setattr(module.requests, 'post', post)
    config = control_config('search_exa', {'apikey': 'k1'})
    glb = SimpleNamespace(config=config, search=module.ExaSearch('search_exa', config, {}))
    for params in ({}, {'type': 'neural', 'numResults': 2, 'includeHighlights': False}):
        instance = _call('nodes.search_exa', glb, params)
        instance.instance = SimpleNamespace(hasListener=lambda lane: lane == 'answers', writeAnswers=lambda a: None)
        instance.preventDefault = lambda: None
        question = Question()
        question.addQuestion('rocket engines')
        instance.writeQuestions(question)

    assert sent[0] == {
        'query': 'rocket engines',
        'type': 'auto',
        'numResults': 5,
        'contents': {'highlights': {'maxCharacters': 600}},
    }
    assert sent[1] == {'query': 'rocket engines', 'type': 'neural', 'numResults': 2}


# ==== llamaparse =================================================================


class _RecordingLlamaParse:
    """Stands in for llama_parse.LlamaParse: records the constructor arguments of each client."""

    built = []

    def __init__(self, **kwargs):
        type(self).built.append(kwargs)


def _stub_module(name: str, **attributes) -> ModuleType:
    """A stand-in module carrying the given attributes."""
    module = ModuleType(name)
    for key, value in attributes.items():
        setattr(module, key, value)
    return module


@pytest.fixture
def llamaparse_node(monkeypatch):
    """The llamaparse node imported over a stand-in SDK and install (no package is fetched)."""
    monkeypatch.setitem(sys.modules, 'depends', _stub_module('depends', depends=lambda *args, **kwargs: None))
    monkeypatch.setitem(sys.modules, 'llama_parse', _stub_module('llama_parse', LlamaParse=_RecordingLlamaParse))
    for name in ('nodes.llamaparse.IGlobal', 'nodes.llamaparse.parser'):
        monkeypatch.delitem(sys.modules, name, raising=False)
    _RecordingLlamaParse.built = []
    glb = _control('nodes.llamaparse', 'llamaparse', {'api_key': 'k1'})
    yield glb
    glb.endGlobal()


def test_llamaparse_builds_one_client_per_parse_configuration(llamaparse_node):
    glb = llamaparse_node
    calls = [{}, {'simple.parse_mode': 'cost_effective'}, {}]
    parsers = [_call('nodes.llamaparse', glb, params)._parser() for params in calls]

    assert parsers[0] is parsers[2] and parsers[0] is not parsers[1]
    first, second = _RecordingLlamaParse.built
    assert (first['parse_mode'], first['page_error_tolerance'], first['api_key']) == ('parse_page_with_lvm', 0.05, 'k1')
    assert second == {'verbose': False, 'api_key': 'k1', 'parse_mode': 'parse_page_with_llm'}


def test_llamaparse_refuses_a_call_whose_advanced_block_is_not_an_object(llamaparse_node):
    instance = _call('nodes.llamaparse', llamaparse_node, {'configMode': 'advanced', 'advanced.advanced_config': '[1]'})
    with pytest.raises(RuntimeError, match='must be a JSON object'):
        instance._parser()


class _TextLane:
    """The instance's output lanes with only ``text`` listened to: records what the node writes there."""

    def __init__(self):
        self.text = []

    def hasListener(self, lane):  # noqa: N802 (engine method name)
        return lane == 'text'

    def writeText(self, text):  # noqa: N802 (engine method name)
        self.text.append(text)


def _parse_on_the_tag_lane(glb, params, codes):
    """
    One call streaming a three-byte document through the tag lane, then closing its object.

    Args:
        glb: The llamaparse control.
        params: The call's params.
        codes: Collects every ``completionCode`` the object is failed with.

    Returns:
        What the call wrote to its text lane.
    """
    instance = _call('nodes.llamaparse', glb, params)
    instance.instance = _TextLane()
    instance.open(SimpleNamespace(fileName='scan.pdf', size=3, objectFailed=False, completionCode=codes.append))
    for tag in (
        SimpleNamespace(tagId='SBGN'),
        SimpleNamespace(tagId='SDAT', asBytes=b'hdr' + b'pdf', size=3),
        SimpleNamespace(tagId='SEND'),
    ):
        instance.writeTag(tag)
    instance.close()
    return instance.instance.text


def test_llamaparse_fails_a_tag_lane_call_whose_advanced_block_is_not_json(llamaparse_node):
    codes = []
    params = {'configMode': 'advanced', 'advanced.advanced_config': '{not json'}

    # The object fails with the configuration error; no error report goes out as parsed text
    assert _parse_on_the_tag_lane(llamaparse_node, params, codes) == []
    assert len(codes) == 1 and 'advanced configuration is not valid JSON' in codes[0]


def test_llamaparse_parses_a_tag_lane_call_whose_configuration_is_valid(llamaparse_node, monkeypatch):
    parser = importlib.import_module('nodes.llamaparse.parser')
    monkeypatch.setattr(parser.Parser, 'parse', lambda self, file_data, file_name=None: {'text': f'{file_name} parsed'})
    codes = []

    assert _parse_on_the_tag_lane(llamaparse_node, {}, codes) == ['scan.pdf parsed']
    assert codes == []


# ==== reducto ====================================================================


class _RecordingReducto:
    """Stands in for reducto.Reducto: records the enhance options of each parse."""

    runs = []

    def __init__(self, api_key):
        self.parse = SimpleNamespace(run=lambda **kwargs: type(self).runs.append(kwargs) or SimpleNamespace())

    def upload(self, file):
        return SimpleNamespace(file_id='f1')


def test_reducto_parses_each_call_by_its_own_mode(monkeypatch):
    monkeypatch.setitem(sys.modules, 'reducto', _stub_module('reducto', Reducto=_RecordingReducto))
    _RecordingReducto.runs = []
    config = control_config('reducto', {'api_key': 'k1'})
    parser = importlib.import_module('nodes.reducto.parser').Parser('reducto', config, {})
    glb = SimpleNamespace(config=config, parser=parser)
    calls = (
        {},
        {'Contains_Handwritten_Text': True, 'Summarize_Text': True},
        {'parse_mode': True, 'options': "{'table_summary': {'enabled': True}}"},
    )
    for params in calls:
        instance = _call('nodes.reducto', glb, params)
        instance.beginInstance()
        parser.parse(b'%PDF', instance.settings, 'a.pdf')

    assert [run.get('enhance') for run in _RecordingReducto.runs] == [
        {'summarize_figures': False, 'summarize_tables': False},
        {'ocr_mode': 'agentic', 'summarize_figures': True, 'summarize_tables': False},
        {'table_summary': {'enabled': True}},
    ]


def test_reducto_refuses_a_call_whose_option_is_not_a_dictionary():
    glb = SimpleNamespace(config=control_config('reducto', {'api_key': 'k1'}))
    instance = _call('nodes.reducto', glb, {'parse_mode': True, 'options': '[1]'})
    with pytest.raises(ValueError, match='options must be a Python dictionary'):
        instance.beginInstance()


# ==== tool_bland_ai ==============================================================


def test_bland_ai_places_each_call_with_its_own_defaults(monkeypatch):
    placed = []
    client = importlib.import_module('nodes.tool_bland_ai.bland_client')
    monkeypatch.setattr(client, 'make_call', lambda api_key, **kwargs: placed.append(kwargs) or {'call_id': 'c1'})
    glb = SimpleNamespace(config=control_config('tool_bland_ai', {'apikey': 'k1'}), api_key='k1', server_name='bland')
    for params in ({}, {'voice': 'Josh', 'maxDuration': 2, 'record': False, 'language': 'de'}):
        driver = _call('nodes.tool_bland_ai', glb, params)._driver()
        driver._tool_invoke(tool_name='make_call', input_obj={'phone_number': '+15550001', 'task': 'say hi'})

    first, second = placed
    assert (first['voice'], first['max_duration'], first['record'], first['language']) == ('June', 5, True, 'en')
    assert (second['voice'], second['max_duration'], second['record'], second['language']) == ('Josh', 2, False, 'de')


# ==== tool_filesystem ============================================================


def test_filesystem_gates_each_call_by_its_own_policy():
    # The node keeps nothing on its control: the control is its config
    control = control_config('tool_filesystem')
    default = _call('nodes.tool_filesystem', control)
    deleting = _call(
        'nodes.tool_filesystem', control, {'allowDelete': True, 'pathWhitelist': [{'whitelistPattern': '^docs/'}]}
    )

    assert not default._is_method_allowed('delete_file')
    assert deleting._is_method_allowed('delete_file')
    default._check_path('anywhere/file.txt')
    with pytest.raises(ValueError, match='does not match any allowed path pattern'):
        deleting._check_path('anywhere/file.txt')
    deleting._check_path('docs/file.txt')


def test_filestore_sinks_each_call_by_its_own_settings():
    control = control_config('filestore')
    default = _call('nodes.tool_filesystem', control)._policy()
    custom = _call(
        'nodes.tool_filesystem', control, {'targetDir': 'exports/', 'onConflict': 'overwrite', 'emitUrl': True}
    )._policy()

    assert (default.target_dir, default.on_conflict.name, default.emit_url) == ('output/', 'UNIQUE', False)
    assert (custom.target_dir, custom.on_conflict.name, custom.emit_url) == ('exports/', 'OVERWRITE', True)
