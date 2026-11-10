# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Frame-failure tests for the vision nodes' writeImage handlers.

On END each handler decodes the buffered frame, runs its model and writes its
outputs. A failure in any of those steps used to be logged as a warning and the
frame dropped, so the image or video completed with that frame missing and no
error. The handler now raises RuntimeError and the engine fails the object.
The engine builds the object's error from str() of the raised exception only and
never reads __cause__ (engLib/python/call.hpp), so the message must carry the cause.

Each node's real IInstance.py runs with rocketlib, ai.common.* and the node's own
IGlobal stubbed. Failures are injected at the decoder or at the model call, so the
real _emit, the device_lock handling and the buffer reset all run.
"""

import importlib.util
from pathlib import Path
import sys
import threading
import types

import numpy as np
from PIL import Image
import pytest

_NODES_DIR = Path(__file__).parents[1] / 'src' / 'nodes'

_BEGIN, _WRITE, _END = 0, 1, 2

# Node -> (IGlobal attribute, method name) of the model call its handler makes.
_MODEL_CALLS = {
    'detect': ('detector', 'detect'),
    'depth_estimate': ('estimator', 'estimate'),
    'detect_segment': ('segmenter', 'segment'),
}

NODES = list(_MODEL_CALLS)


class _PreventDefaultRaised(Exception):
    """Stand-in for the real preventDefault(), which raises rather than returning."""


def _simulate_engine_dispatch(write_override, default_forward):
    """Mimic checkCallParent(): the engine forwards after a handler returns, unless it raised.

    Ec.PreventDefault suppresses the forward. Any other error propagates and also
    skips it, as every other error skips the parent call in the engine.
    """
    try:
        write_override()
    except _PreventDefaultRaised:
        return
    default_forward()


class _FakeIInstanceBase:
    """Stand-in for rocketlib.IInstanceBase whose preventDefault() raises, like the real one."""

    def preventDefault(self):
        """Raise, as the real implementation does."""
        raise _PreventDefaultRaised()


class _FakeInstance:
    """Stand-in for the engine-side instance handle that records each lane's writes."""

    def __init__(self):
        """Start with nothing delivered."""
        self.delivered = {}

    def hasListener(self, lane):
        """Report every lane as connected, so both outputs are produced."""
        return True

    def writeText(self, text):
        """Record a write on the text lane."""
        self.delivered.setdefault('text', []).append(text)


def _forward_enriched_image(instance, descriptor, mime_type, data):
    """Record a write on the image lane, standing in for ai.common.avi.descriptor."""
    instance.delivered.setdefault('image', []).append(mime_type)


def _decode(data):
    """Decode the buffered bytes into a small real image."""
    return Image.new('RGB', (4, 4))


def _fail(*args, **kwargs):
    """Fail like a decoder or model call would, for example on CUDA out of memory."""
    raise ValueError('injected frame failure')


def _model_result(node, image):
    """Return what the node's model returns for a frame with nothing found in it."""
    if node == 'depth_estimate':
        return np.zeros((image.height, image.width), dtype=np.float32)
    return []


def _stubs(package):
    """Build the modules the handlers import, keyed by module name."""
    iglobal = types.ModuleType(package.__name__ + '.IGlobal')
    iglobal.IGlobal = object
    return {
        package.__name__: package,
        iglobal.__name__: iglobal,
        'rocketlib': types.SimpleNamespace(
            IInstanceBase=_FakeIInstanceBase,
            AVI_ACTION=types.SimpleNamespace(BEGIN=_BEGIN, WRITE=_WRITE, END=_END),
            debug=lambda *a, **kw: None,
            warning=lambda *a, **kw: None,
        ),
        'ai.common.image': types.SimpleNamespace(
            ImageProcessor=types.SimpleNamespace(load_image_from_bytes=_decode, get_bytes=lambda *a, **kw: b'encoded'),
        ),
        'ai.common.image.dense_resize': types.SimpleNamespace(
            resize_for_inference=lambda image, edge: (image, image.size),
            restore_dense_output=lambda value, *a, **kw: value,
        ),
        'ai.common.utils': types.SimpleNamespace(colorize_depth=lambda value: value),
        'ai.common.avi.descriptor': types.SimpleNamespace(
            descriptor_from_payload=lambda data: {}, forward_enriched_image=_forward_enriched_image
        ),
    }


@pytest.fixture
def handler(monkeypatch):
    """Return a loader that builds a node's real IInstance with a frame buffered."""

    def load(node, decode, model):
        """Load the node's IInstance, wire its decoder and model, and buffer one frame.

        Args:
            node: Node package name, e.g. 'detect'.
            decode: Replaces ImageProcessor.load_image_from_bytes.
            model: Replaces the node's model call; it receives the decoded image.

        Returns:
            The instance after BEGIN and WRITE, ready for END.
        """
        package = types.ModuleType('_frame_failure_' + node)
        package.__path__ = [str(_NODES_DIR / node)]
        stubs = _stubs(package)
        for name, value in stubs.items():
            monkeypatch.setitem(sys.modules, name, value)
        stubs['ai.common.image'].ImageProcessor.load_image_from_bytes = decode

        spec = importlib.util.spec_from_file_location(
            package.__name__ + '.IInstance', _NODES_DIR / node / 'IInstance.py'
        )
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)

        attr, method = _MODEL_CALLS[node]
        instance = module.IInstance()
        instance.instance = _FakeInstance()
        instance.IGlobal = types.SimpleNamespace(
            device_lock=threading.Lock(),
            max_edge=1024,
            **{attr: types.SimpleNamespace(mode='instance', **{method: model})},
        )
        instance.writeImage(_BEGIN, 'image/png', b'')
        instance.writeImage(_WRITE, 'image/png', b'data')
        return instance

    return load


def _end(instance, forwarded):
    """Deliver END through the engine's dispatch rule, recording a default forward."""
    _simulate_engine_dispatch(lambda: instance.writeImage(_END, 'image/png', b''), lambda: forwarded.append('END'))


@pytest.mark.parametrize('node', NODES)
@pytest.mark.parametrize('failure', ['decode', 'inference'])
def test_frame_failure_fails_the_object_with_the_cause(handler, node, failure):
    """A frame that cannot be decoded or inferred raises with the cause and writes nothing."""
    instance = handler(node, decode=_fail if failure == 'decode' else _decode, model=_fail)
    forwarded = []

    with pytest.raises(
        RuntimeError, match=f'^{node} failed to process the input frame: injected frame failure$'
    ) as caught:
        _end(instance, forwarded)

    assert isinstance(caught.value.__cause__, ValueError)
    assert forwarded == [], 'the raw END was forwarded after the failure'
    assert instance.instance.delivered == {}, 'a failed frame wrote output'
    assert instance._image_data is None
    assert instance.IGlobal.device_lock.acquire(blocking=False), 'device_lock is still held after the failure'
    instance.IGlobal.device_lock.release()


@pytest.mark.parametrize('node', NODES)
def test_frame_failure_without_a_message_names_the_exception_type(handler, node):
    """An exception whose str() is empty, such as a bare AssertionError, still leaves a cause."""

    def fail_without_message(*args, **kwargs):
        """Fail with an exception that has no message."""
        raise AssertionError()

    instance = handler(node, decode=_decode, model=fail_without_message)

    with pytest.raises(RuntimeError, match=f'^{node} failed to process the input frame: AssertionError$'):
        _end(instance, [])


@pytest.mark.parametrize('node', NODES)
def test_successful_frame_writes_each_output_once(handler, node):
    """A frame that succeeds writes text and image once and suppresses the raw END."""
    instance = handler(node, decode=_decode, model=lambda image: _model_result(node, image))
    forwarded = []

    _end(instance, forwarded)

    assert forwarded == [], 'the raw END was forwarded next to the node output'
    assert len(instance.instance.delivered['text']) == 1
    assert len(instance.instance.delivered['image']) == 1
    assert instance._image_data is None
