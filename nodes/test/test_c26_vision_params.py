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
The per-call parameters of the vision nodes (plan 5.1, 5.6.4; C.26 vision family).

The weights stay on the control (the profile or model selector); the knobs a
request can change without new weights are params read from ``self.settings``.
The vision LLM drivers hold no weights: their model leaves are params too,
read through the ChatBase per-call seam. Each node's schema is checked as the
engine resolves it, and one control (one IGlobal holding a recording stand-in
for the model) serves two calls with different values. No test loads a model
or reaches a provider.
"""

from __future__ import annotations

import importlib
import importlib.util
import io
import sys
import threading
import types
from pathlib import Path
from types import SimpleNamespace

import pytest
import rocketlib
from ai.common.avi.descriptor import build_stream_descriptor, descriptor_to_payload
from ai.common.chat import ChatBase
from ai.common.schema import Question
from rocketlib import AVI_ACTION

from .framework.controls import assert_config_refuses, assert_params, bind_call, control_config

# ==== The schemas ================================================================

#: The model leaves of a vision LLM driver: per call, and never an LLM's to choose.
MODEL_LEAVES = ['model', 'custom.customModel', 'custom.modelTotalTokens', 'custom.modelOutputTokens']

#: logical type -> (every param leaf path, the tool: false ones, the param keys reachable by default)
SCHEMAS = {
    'background_removal': (['birefnet-default.maxEdge', 'birefnet-hr.maxEdge'], [], ['maxEdge']),
    'depth_estimate': (['maxEdge'], [], ['maxEdge']),
    'detect': (['threshold', 'mmgdino.prompt'], [], ['threshold', 'prompt']),
    'detect_segment': (
        ['maxEdge', 'mask2former-instance.threshold', 'mask2former-semantic.threshold'],
        [],
        ['maxEdge', 'threshold'],
    ),
    'pose_estimation': (['threshold', 'max_persons'], [], ['threshold', 'max_persons']),
    'image_orient': (
        ['margin', 'minFaces', 'confidenceWeight', 'minConfidence', 'detectSize', 'quality'],
        [],
        ['margin', 'minFaces', 'confidenceWeight', 'minConfidence', 'detectSize', 'quality'],
    ),
    'caption': (['task'], [], ['task']),
    'face_detection': (['threshold', 'emit_landmarks'], [], ['threshold', 'emit_landmarks']),
    'image_vision_openai': (
        [*MODEL_LEAVES, 'systemPrompt', 'prompt'],
        [*MODEL_LEAVES, 'systemPrompt'],
        ['model', 'systemPrompt', 'prompt'],
    ),
    'image_vision_gemini': (
        [*MODEL_LEAVES, 'systemPrompt', 'prompt'],
        MODEL_LEAVES,
        ['model', 'systemPrompt', 'prompt'],
    ),
    'image_vision_mistral': (
        [*MODEL_LEAVES, 'systemPrompt', 'prompt'],
        MODEL_LEAVES,
        ['model', 'systemPrompt', 'prompt'],
    ),
    'image_vision_ollama': (
        [*MODEL_LEAVES, 'systemPrompt', 'prompt'],
        MODEL_LEAVES,
        ['model', 'systemPrompt', 'prompt'],
    ),
}

#: The services a release engine drops (``debug`` capability): their schema is checked in a debug build only.
DEBUG_ONLY = {'caption', 'face_detection'}

#: A detect control on the open-vocabulary backend, whose branch carries the prompt.
DETECT_OPEN_VOCAB = {'profile': 'mmgdino', 'mmgdino': {'prompt': 'person'}}


def _require(logical_type: str) -> None:
    """Skip a schema check the engine cannot serve: a debug-only service in a release build."""
    if logical_type in DEBUG_ONLY and rocketlib.getServiceSchema(logical_type) is None:
        pytest.skip(f'{logical_type} is debug-only and this engine is a release build')


@pytest.mark.parametrize('logical_type', sorted(SCHEMAS))
def test_the_schema_flags_exactly_the_per_call_knobs(logical_type):
    _require(logical_type)
    params, caller_only, _reachable = SCHEMAS[logical_type]
    assert_params(logical_type, params, caller_only)


@pytest.mark.parametrize('logical_type', sorted(SCHEMAS))
def test_the_control_config_refuses_every_param(logical_type):
    _require(logical_type)
    stored = DETECT_OPEN_VOCAB if logical_type == 'detect' else {}
    if logical_type.startswith('image_vision_') and logical_type != 'image_vision_ollama':
        stored = {'apikey': 'k1'}
    assert_config_refuses(control_config(logical_type, stored), SCHEMAS[logical_type][2])


# ==== Driving one image through a model-vision node ===============================


def _png(width: int = 64, height: int = 32) -> bytes:
    """A real PNG of the given size."""
    from PIL import Image

    buffer = io.BytesIO()
    Image.new('RGB', (width, height), (120, 80, 40)).save(buffer, format='PNG')
    return buffer.getvalue()


class _Lanes:
    """Stand-in for the engine binding: no lane is connected, so nothing is emitted."""

    def hasListener(self, lane):  # noqa: N802 (engine method name)
        return False


def _drive(instance, image: bytes) -> None:
    """Send one image stream (BEGIN descriptor, WRITE bytes, END) through an instance."""
    instance.instance = _Lanes()
    instance.preventDefault = lambda: None
    descriptor = build_stream_descriptor(None, 'image', objectId='o1', parent='/in/a.png', permissionId=0, name='a.png')
    instance.writeImage(AVI_ACTION.BEGIN, 'image/png', descriptor_to_payload(descriptor))
    instance.writeImage(AVI_ACTION.WRITE, 'image/png', image)
    try:
        instance.writeImage(AVI_ACTION.END, 'image/png', b'')
    except RuntimeError as exc:
        # A recording model raises once it has the call; the node fails the frame with that cause
        if not str(exc).endswith(': recorded'):
            raise


class _Recorder:
    """A model facade that records each call's input size and keyword arguments."""

    def __init__(self):
        self.calls = []

    def _record(self, image, **kwargs):
        self.calls.append((image.size, kwargs))
        raise RuntimeError('recorded')  # the node fails the frame, which _drive expects; the call is what matters

    estimate = _record
    remove = _record
    detect = _record
    segment = _record


def _control(logical_type: str, facade_attr: str, stored=None):
    """One control: its resolved config, a recording facade and the device lock, built once."""
    recorder = _Recorder()
    glb = SimpleNamespace(config=control_config(logical_type, stored), device_lock=threading.Lock())
    setattr(glb, facade_attr, recorder)
    return glb, recorder


def _call(module: str, glb, params=None):
    """A fresh instance of the node bound to one call of the control."""
    return bind_call(importlib.import_module(module).IInstance(), glb, params)


def test_depth_estimate_resizes_each_call_to_its_own_edge():
    glb, model = _control('depth_estimate', 'estimator')
    _drive(_call('nodes.depth_estimate.IInstance', glb, {'maxEdge': 256}), _png(1024, 512))
    _drive(_call('nodes.depth_estimate.IInstance', glb, {'maxEdge': 512}), _png(1024, 512))
    assert [size for size, _ in model.calls] == [(256, 128), (512, 256)]


def test_background_removal_resizes_each_call_to_its_own_edge():
    glb, model = _control('background_removal', 'remover')
    _drive(_call('nodes.background_removal.IInstance', glb, {'maxEdge': 256}), _png(1024, 512))
    _drive(_call('nodes.background_removal.IInstance', glb, {'maxEdge': 512}), _png(1024, 512))
    assert [size for size, _ in model.calls] == [(256, 128), (512, 256)]


def test_detect_sends_each_call_its_own_prompt_and_threshold():
    glb, model = _control('detect', 'detector', DETECT_OPEN_VOCAB)
    model.backend = glb.config.engine
    for params in ({}, {'prompt': 'car . dog', 'threshold': 0.7}):
        instance = _call('nodes.detect.IInstance', glb, params)
        instance.beginInstance()
        _drive(instance, _png())
    assert [kwargs for _, kwargs in model.calls] == [
        {'prompt': 'person', 'threshold': 0.3},
        {'prompt': 'car . dog', 'threshold': 0.7},
    ]


def test_detect_refuses_a_prompt_that_names_no_class():
    glb, model = _control('detect', 'detector', DETECT_OPEN_VOCAB)
    model.backend = glb.config.engine
    with pytest.raises(ValueError, match='requires a non-empty prompt') as refused:
        _call('nodes.detect.IInstance', glb, {'prompt': ' . , '}).beginInstance()
    # A caller's override is fixed on the call, not in the UI
    assert 'passes the prompt in its parameters' in str(refused.value)


def test_detect_segment_sends_each_call_its_own_threshold_and_edge():
    glb, model = _control('detect_segment', 'segmenter')
    _drive(_call('nodes.detect_segment.IInstance', glb), _png())
    _drive(_call('nodes.detect_segment.IInstance', glb, {'threshold': 0.9, 'maxEdge': 512}), _png())
    assert [kwargs for _, kwargs in model.calls] == [
        {'threshold': 0.3, 'max_edge': 1024},
        {'threshold': 0.9, 'max_edge': 512},
    ]


def test_pose_estimation_sends_each_call_its_own_threshold_and_cap():
    glb, model = _control('pose_estimation', 'pose_estimator')
    _drive(_call('nodes.pose_estimation.IInstance', glb), _png())
    _drive(_call('nodes.pose_estimation.IInstance', glb, {'threshold': 0.6, 'max_persons': 3}), _png())
    assert [kwargs for _, kwargs in model.calls] == [
        {'threshold': 0.3, 'max_persons': 20},
        {'threshold': 0.6, 'max_persons': 3},
    ]


def test_caption_sends_each_call_its_own_granularity():
    glb = SimpleNamespace(config=SimpleNamespace(), device_lock=threading.Lock(), captioner=SimpleNamespace(calls=[]))
    glb.captioner.caption = lambda image, task: glb.captioner.calls.append(task) or 'a caption'
    for task in ('caption', 'more_detailed_caption'):
        instance = importlib.import_module('nodes.caption.IInstance').IInstance()
        instance.IGlobal = glb
        instance._settings = SimpleNamespace(task=task)
        instance.instance = SimpleNamespace(hasListener=lambda lane: True, writeText=lambda text: None)
        instance._emit(None)
    assert glb.captioner.calls == ['caption', 'more_detailed_caption']


# ==== face_detection: a bounded cache of detectors keyed by threshold ==============


class _FaceDetector:
    """Stand-in for the MediaPipe-backed FaceDetector: one per threshold, records closes."""

    built = []

    def __init__(self, threshold):
        self.threshold = threshold
        self.closed = False
        type(self).built.append(threshold)

    def detect(self, image, emit_landmarks):
        return [{'label': 'face', 'score': 0.9, 'box': {}, 'landmarks': emit_landmarks}]

    def close(self):
        self.closed = True


def test_face_detection_keeps_one_detector_per_threshold_and_bounds_them(monkeypatch):
    module = importlib.import_module('nodes.face_detection.IGlobal')
    monkeypatch.setattr(module, 'FaceDetector', _FaceDetector)
    _FaceDetector.built = []
    glb = module.IGlobal()
    glb.beginGlobal()

    first = glb.detector_for(0.5)
    assert glb.detector_for(0.5) is first
    for threshold in (0.6, 0.7, 0.8, 0.9):
        glb.detector_for(threshold)
    assert _FaceDetector.built == [0.5, 0.6, 0.7, 0.8, 0.9]
    assert len(glb.detectors) == module.MAX_DETECTORS
    assert first.closed and 0.5 not in glb.detectors

    kept = list(glb.detectors.values())
    glb.endGlobal()
    assert all(detector.closed for detector in kept)


def test_face_detection_formats_landmarks_per_call(monkeypatch):
    module = importlib.import_module('nodes.face_detection.IGlobal')
    monkeypatch.setattr(module, 'FaceDetector', _FaceDetector)
    glb = module.IGlobal()
    glb.beginGlobal()
    seen = []
    for emit in (True, False):
        instance = importlib.import_module('nodes.face_detection.IInstance').IInstance()
        instance.IGlobal = glb
        instance._settings = SimpleNamespace(threshold=0.5, emit_landmarks=emit)
        instance._emit = lambda image, faces, chunk_id: seen.append(faces[0]['landmarks'])
        _drive(instance, _png())
    assert seen == [True, False]
    assert list(glb.detectors) == [0.5]
    glb.endGlobal()


# ==== The vision LLM drivers: model, prompt and system prompt per call ============

#: node -> (the control's stored config, the schema's default model, another model a call picks)
DRIVERS = {
    'llm_vision_openai': ({'apikey': 'sk-test'}, 'gpt-4.1', 'gpt-4o'),
    'llm_vision_gemini': ({'apikey': 'k1'}, 'models/gemini-2.5-flash', 'models/gemini-2.5-pro'),
    'llm_vision_mistral': ({'apikey': 'k1'}, 'mistral-large-2512', 'mistral-small-2506'),
    'llm_vision_ollama': ({}, 'llama3.2-vision:11b', 'llava:7b'),
}


def _vision_config(node: str):
    """The control's config of a vision LLM node."""
    return control_config(node.replace('llm_vision_', 'image_vision_'), DRIVERS[node][0])


class _Chat(ChatBase):
    """Stand-in for a vision driver over the real per-call seam: records the model and prompts of each chat."""

    def __init__(self, config):
        """Build the chat from the control's config, as a driver does."""
        super().__init__('test', config, {})
        self.calls = []

    def chat(self, question):
        """Record what the call sends (its system prompt is the call's, as a driver reads it); answer without a provider."""
        system_prompt = self.call.settings.get('systemPrompt') or ''
        self.calls.append((self.call.model, question.questions[0].text, system_prompt))
        return SimpleNamespace(getText=lambda: 'an answer')


@pytest.mark.parametrize('node', sorted(DRIVERS))
def test_one_vision_control_serves_each_call_its_own_model_and_prompts(node):
    _stored, default_model, other_model = DRIVERS[node]
    config = _vision_config(node)
    glb = SimpleNamespace(config=config, _chat=_Chat(config))
    calls = ({}, {'model': other_model, 'prompt': 'What is on the shelf?', 'systemPrompt': 'Answer in French.'})
    for params in calls:
        instance = bind_call(importlib.import_module(f'nodes.{node}.IInstance').IInstance(), glb, params)
        instance.instance = SimpleNamespace(writeText=lambda text: None, hasListener=lambda lane: True)
        instance.preventDefault = lambda: None
        if hasattr(instance, 'open'):
            instance.open(None)
        instance.writeImage(AVI_ACTION.BEGIN, 'image/png', b'')
        instance.writeImage(AVI_ACTION.WRITE, 'image/png', _png())
        instance.writeImage(AVI_ACTION.END, 'image/png', b'')
    # One chat, built once, served both calls, each on its own model and prompts
    (first_model, first_prompt, _first_system), second = glb._chat.calls
    assert first_model == default_model
    assert first_prompt and first_prompt != 'What is on the shelf?'
    assert second == (other_model, 'What is on the shelf?', 'Answer in French.')


# ==== The drivers: the call's model reaches the provider ==========================

#: The node packages, for loading a driver module from its file.
NODES_DIR = Path(__file__).resolve().parent.parent / 'src' / 'nodes'


def _module(name: str, **attributes) -> types.ModuleType:
    """A stand-in module with the given attributes."""
    module = types.ModuleType(name)
    for key, value in attributes.items():
        setattr(module, key, value)
    return module


def _reply(text: str) -> SimpleNamespace:
    """An OpenAI-shaped completion (OpenAI and Mistral SDKs answer alike)."""
    return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=text))])


def _openai_sdk(sent):
    """The ``openai`` SDK as openai_vision uses it: one completion per request."""

    class OpenAI:
        def __init__(self, **kwargs):
            self.chat = SimpleNamespace(completions=self)

        def create(self, model, messages, max_completion_tokens=None):
            system = [message['content'] for message in messages if message['role'] == 'system']
            sent.append({'model': model, 'system': system[0] if system else '', 'max_tokens': max_completion_tokens})
            return _reply('seen')

    errors = {'RateLimitError': type('RateLimitError', (Exception,), {})}
    errors['APIConnectionError'] = type('APIConnectionError', (Exception,), {})
    return 'openai_vision', {'openai': _module('openai', OpenAI=OpenAI, **errors)}


def _gemini_sdk(sent):
    """The ``google.genai`` SDK as gemini_vision uses it."""

    class Client:
        def __init__(self, api_key):
            self.models = self

        def generate_content(self, model, contents, config=None):
            config = config or {}
            sent.append(
                {
                    'model': model,
                    'system': config.get('system_instruction', ''),
                    'max_tokens': config.get('max_output_tokens'),
                }
            )
            return SimpleNamespace(text='seen')

    parts = SimpleNamespace(from_bytes=lambda **kwargs: kwargs, from_text=lambda **kwargs: kwargs)
    genai_types = _module('google.genai.types', Part=parts, Content=lambda **kwargs: kwargs)
    genai = _module('google.genai', Client=Client, types=genai_types)
    return 'gemini_vision', {
        'google': _module('google', genai=genai),
        'google.genai': genai,
        'google.genai.types': genai_types,
    }


def _mistral_sdk(sent):
    """The ``mistralai`` SDK, its tokenizer and ``httpx`` as mistral_vision uses them."""

    class Mistral:
        def __init__(self, api_key, client):
            self.chat = self

        def complete(self, **request):
            system = [message['content'][0]['text'] for message in request['messages'] if message['role'] == 'system']
            sent.append(
                {'model': request['model'], 'system': system[0] if system else '', 'max_tokens': request['max_tokens']}
            )
            return _reply('seen')

    tokenizers = _module('mistral_common.tokens.tokenizers.mistral', MistralTokenizer=object)
    return 'mistral_vision', {
        'httpx': _module('httpx', Client=lambda **kwargs: object()),
        'mistralai': _module('mistralai', Mistral=Mistral),
        'mistralai.client': _module('mistralai.client', Mistral=Mistral),
        'mistral_common.tokens.tokenizers.mistral': tokenizers,
    }


def _ollama_sdk(sent):
    """``langchain_openai.ChatOpenAI`` as ollama_vision uses it: one client per request."""

    class ChatOpenAI:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

        def invoke(self, messages):
            # The system message is the plain text one; the human message carries the image parts
            system = [message for message in messages if isinstance(message, str)]
            sent.append(
                {
                    'model': self.kwargs['model'],
                    'max_tokens': self.kwargs['max_tokens'],
                    'system': system[0] if system else '',
                }
            )
            return SimpleNamespace(content='seen')

    messages = _module(
        'langchain_core.messages', HumanMessage=lambda content: content, SystemMessage=lambda content: content
    )
    return 'ollama_vision', {
        'langchain_openai': _module('langchain_openai', ChatOpenAI=ChatOpenAI),
        'langchain_core.messages': messages,
    }


#: node -> builds (the driver module's name, the stand-in modules it imports) around a list of sent requests
PROVIDERS = {
    'llm_vision_openai': _openai_sdk,
    'llm_vision_gemini': _gemini_sdk,
    'llm_vision_mistral': _mistral_sdk,
    'llm_vision_ollama': _ollama_sdk,
}


def _load_driver(monkeypatch, node: str, module: str, fakes) -> types.ModuleType:
    """Load a driver module from its file over stand-in SDKs; it is never cached in ``sys.modules``."""
    monkeypatch.setitem(sys.modules, 'depends', SimpleNamespace(depends=lambda _requirements: None))
    for name, fake in fakes.items():
        monkeypatch.setitem(sys.modules, name, fake)
    spec = importlib.util.spec_from_file_location(f'_c26_vision_{module}', NODES_DIR / node / f'{module}.py')
    driver = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(driver)
    return driver


def _image_question() -> Question:
    """One image as context and a prompt, as the instance builds it."""
    import base64

    question = Question()
    question.addContext('data:image/png;base64,' + base64.b64encode(_png()).decode('ascii'))
    question.addQuestion('Describe this image.')
    return question


@pytest.mark.parametrize('node', sorted(DRIVERS))
def test_each_call_reaches_the_provider_on_its_own_model(monkeypatch, node):
    _stored, default_model, other_model = DRIVERS[node]
    sent = []
    module, fakes = PROVIDERS[node](sent)
    driver = _load_driver(monkeypatch, node, module, fakes)
    config = _vision_config(node)
    chat = driver.Chat('test', config, {})
    calls = [chat.resolve_call(config.overlay({'model': model})) for model in (other_model, default_model)]
    for call in calls:
        # The request runs on a worker thread in most drivers: the call is read before it
        with chat.calling(call):
            assert chat.chat(_image_question()).getText() == 'seen'
    assert [request['model'] for request in sent] == [other_model, default_model]
    # Every driver sends the call's output cap (the branch's modelOutputTokens)
    assert [request['max_tokens'] for request in sent] == [call.output_tokens for call in calls]


@pytest.mark.parametrize('node', sorted(DRIVERS))
def test_the_inherited_ask_sends_the_calls_system_prompt(monkeypatch, node):
    # ask (LLMBase) reaches the chat with the question alone: the system prompt
    # is the call's, so it reaches the provider on this path as on the lanes
    sent = []
    module, fakes = PROVIDERS[node](sent)
    driver = _load_driver(monkeypatch, node, module, fakes)
    config = _vision_config(node)
    glb = SimpleNamespace(config=config, _chat=driver.Chat('test', config, {}))
    for params in ({}, {'systemPrompt': 'Answer in French.'}):
        instance = bind_call(importlib.import_module(f'nodes.{node}.IInstance').IInstance(), glb, params)
        assert instance.ask(SimpleNamespace(question=_image_question())).getText() == 'seen'
    assert [request['system'] for request in sent] == ['', 'Answer in French.']


@pytest.mark.parametrize('node', sorted(DRIVERS))
def test_the_context_window_is_the_one_the_call_resolved(monkeypatch, node):
    # One budget: the window the prompt checks read is the window the call's
    # output limit was validated against, a custom model whose caller cleared
    # the window included (the schema's default fills it; no driver keeps a fallback of its own)
    module, fakes = PROVIDERS[node]([])
    driver = _load_driver(monkeypatch, node, module, fakes)
    config = _vision_config(node)
    glb = SimpleNamespace(config=config, _chat=driver.Chat('test', config, {}))
    custom = {'model': 'custom', 'customModel': 'my-vision-model'}
    windows = []
    for params in ({}, custom, {**custom, 'custom.modelTotalTokens': None}):
        instance = bind_call(importlib.import_module(f'nodes.{node}.IInstance').IInstance(), glb, params)
        windows.append((instance.getContextLength(None), glb._chat.resolve_call(instance.settings).total_tokens))
    assert all(read == resolved for read, resolved in windows)


def test_a_vision_chat_outside_a_call_refuses_to_guess_its_model(monkeypatch):
    module, fakes = PROVIDERS['llm_vision_openai']([])
    chat = _load_driver(monkeypatch, 'llm_vision_openai', module, fakes).Chat(
        'test', _vision_config('llm_vision_openai'), {}
    )
    with pytest.raises(RuntimeError, match='no call is being served'):
        chat.chat(_image_question())
