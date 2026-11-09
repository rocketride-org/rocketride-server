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
            IInstanceBase=Base, AVI_ACTION=types.SimpleNamespace(BEGIN=0, WRITE=1, END=2)
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
    instance, processor, emitted = caption_node

    def fail(*args):
        if failure == 'timeout':
            raise TimeoutError('injected timeout')
        raise ValueError('injected error')

    if failure == 'decode':
        processor.load_image_from_bytes = fail
    instance.IGlobal.captioner = types.SimpleNamespace(caption=fail)
    with pytest.raises(RuntimeError, match='caption failed'):
        instance.writeImage(2, 'image/png', b'')
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
