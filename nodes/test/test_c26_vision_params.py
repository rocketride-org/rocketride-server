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
Each node's schema is checked as the engine resolves it, and one control (one
IGlobal holding a recording stand-in for the model) serves two calls with
different values. No test loads a model or reaches a provider.
"""

from __future__ import annotations

import importlib
import io
import threading
from types import SimpleNamespace

import pytest
import rocketlib
from ai.common.avi.descriptor import build_stream_descriptor, descriptor_to_payload
from rocketlib import AVI_ACTION

from .framework.controls import assert_config_refuses, assert_params, bind_call, control_config

# ==== The schemas ================================================================

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
    'image_vision_openai': (['systemPrompt', 'prompt'], ['systemPrompt'], ['systemPrompt', 'prompt']),
    'image_vision_gemini': (['systemPrompt', 'prompt'], [], ['systemPrompt', 'prompt']),
    'image_vision_mistral': (['systemPrompt', 'prompt'], [], ['systemPrompt', 'prompt']),
    'image_vision_ollama': (['systemPrompt', 'prompt'], [], ['systemPrompt', 'prompt']),
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
    instance.writeImage(AVI_ACTION.END, 'image/png', b'')


class _Recorder:
    """A model facade that records each call's input size and keyword arguments."""

    def __init__(self):
        self.calls = []

    def _record(self, image, **kwargs):
        self.calls.append((image.size, kwargs))
        raise RuntimeError('recorded')  # the node drops the frame with a warning; the call is what matters

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
    with pytest.raises(ValueError, match='requires a non-empty prompt'):
        _call('nodes.detect.IInstance', glb, {'prompt': ' . , '}).beginInstance()


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


# ==== The vision LLM drivers: prompt and system prompt per call ===================


class _Chat:
    """Stand-in for a vision driver: records the prompt and system prompt of each chat."""

    def __init__(self):
        self.calls = []

    def chat(self, question, system_prompt=''):
        self.calls.append((question.questions[0].text, system_prompt))
        return SimpleNamespace(getText=lambda: 'an answer')


@pytest.mark.parametrize('node', ['llm_vision_openai', 'llm_vision_gemini', 'llm_vision_mistral', 'llm_vision_ollama'])
def test_a_vision_driver_takes_the_prompts_of_each_call(node):
    logical_type = node.replace('llm_vision_', 'image_vision_')
    stored = {} if node == 'llm_vision_ollama' else {'apikey': 'k1'}
    glb = SimpleNamespace(config=control_config(logical_type, stored), _chat=_Chat())
    calls = ({}, {'prompt': 'What is on the shelf?', 'systemPrompt': 'Answer in French.'})
    for params in calls:
        instance = bind_call(importlib.import_module(f'nodes.{node}.IInstance').IInstance(), glb, params)
        instance.instance = SimpleNamespace(writeText=lambda text: None, hasListener=lambda lane: True)
        instance.preventDefault = lambda: None
        if hasattr(instance, 'open'):
            instance.open(None)
        instance.writeImage(AVI_ACTION.BEGIN, 'image/png', b'')
        instance.writeImage(AVI_ACTION.WRITE, 'image/png', _png())
        instance.writeImage(AVI_ACTION.END, 'image/png', b'')
    (first_prompt, _first_system), second = glb._chat.calls
    assert first_prompt and first_prompt != 'What is on the shelf?'
    assert second == ('What is on the shelf?', 'Answer in French.')
