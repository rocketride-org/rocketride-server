"""Exercise the real caption callback without the native engine or a model download."""

import importlib.util
from pathlib import Path
import sys
import threading
import types

import pytest


@pytest.fixture
def caption_node(monkeypatch):
    root = Path(__file__).parents[2] / 'src/nodes/caption'
    package = types.ModuleType('_caption_failure_contract')
    package.__path__ = [str(root)]
    glb = types.ModuleType(package.__name__ + '.IGlobal')
    glb.IGlobal = object

    class Base:
        def preventDefault(self):
            return 'handled'

    processor = types.SimpleNamespace(load_image_from_bytes=lambda data: object())
    for name, value in {
        package.__name__: package,
        glb.__name__: glb,
        'rocketlib': types.SimpleNamespace(
            IInstanceBase=Base,
            AVI_ACTION=types.SimpleNamespace(BEGIN=0, WRITE=1, END=2),
            warning=lambda *args, **kwargs: None,
        ),
        'ai.common.image': types.SimpleNamespace(ImageProcessor=processor),
    }.items():
        monkeypatch.setitem(sys.modules, name, value)
    spec = importlib.util.spec_from_file_location(package.__name__ + '.IInstance', root / 'IInstance.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    instance = module.IInstance()
    emitted = []
    instance.instance = types.SimpleNamespace(hasListener=lambda lane: True, writeText=emitted.append)
    instance.IGlobal = types.SimpleNamespace(device_lock=threading.Lock())
    instance.writeImage(0, 'image/png', b'')
    instance.writeImage(1, 'image/png', b'data')
    return instance, processor, emitted


@pytest.mark.parametrize('failure', ['decode', 'inference', 'timeout'])
def test_failure_does_not_emit_an_empty_caption(caption_node, failure):
    """A failed decode or caption raises with its cause in the message and writes nothing."""
    instance, processor, emitted = caption_node
    cause = 'TimeoutError: injected timeout' if failure == 'timeout' else 'ValueError: injected error'

    def fail(*args):
        if failure == 'timeout':
            raise TimeoutError('injected timeout')
        raise ValueError('injected error')

    if failure == 'decode':
        processor.load_image_from_bytes = fail
    instance.IGlobal.captioner = types.SimpleNamespace(caption=fail)
    with pytest.raises(RuntimeError, match=r'^caption: could not caption the image \(') as raised:
        instance.writeImage(2, 'image/png', b'')
    # The engine shows only str() of the error, so the cause must be in the text.
    assert f'({cause})' in str(raised.value)
    assert emitted == []
    assert instance._image_data is None
    assert instance.IGlobal.device_lock.acquire(blocking=False)
    instance.IGlobal.device_lock.release()


def test_valid_caption_is_emitted(caption_node):
    instance, _, emitted = caption_node
    instance.IGlobal.captioner = types.SimpleNamespace(caption=lambda image: 'a meeting')
    assert instance.writeImage(2, 'image/png', b'') == 'handled'
    assert emitted == ['a meeting']
    assert instance._image_data is None


def test_downstream_write_error_is_not_relabelled(caption_node):
    """An error raised while writing the caption downstream reaches the engine unchanged."""
    instance, _, _ = caption_node
    written = []

    def write_text(text):
        written.append(text)
        raise ValueError('downstream failed')

    instance.instance.writeText = write_text
    instance.IGlobal.captioner = types.SimpleNamespace(caption=lambda image: 'a meeting')
    with pytest.raises(ValueError, match='downstream failed'):
        instance.writeImage(2, 'image/png', b'')
    assert written == ['a meeting']
    assert instance._image_data is None
