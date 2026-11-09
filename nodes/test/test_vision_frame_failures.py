"""Execute real frame handlers with only engine/media imports and inference stubbed."""

import importlib.util
from pathlib import Path
import sys
import threading
import types

import pytest


@pytest.fixture
def handler(monkeypatch):
    def load(node):
        root = Path(__file__).parents[1] / 'src/nodes' / node
        package = types.ModuleType('_frame_failure_' + node)
        package.__path__ = [str(root)]
        glb = types.ModuleType(package.__name__ + '.IGlobal')
        glb.IGlobal = object

        class Base:
            def preventDefault(self):
                return 'handled'

        image = types.SimpleNamespace(load_image_from_bytes=lambda data: object())
        stubs = {
            package.__name__: package,
            glb.__name__: glb,
            'rocketlib': types.SimpleNamespace(
                IInstanceBase=Base,
                AVI_ACTION=types.SimpleNamespace(BEGIN=0, WRITE=1, END=2),
                debug=lambda *a: None,
                warning=lambda *a: None,
            ),
            'ai.common.image': types.SimpleNamespace(ImageProcessor=image),
            'ai.common.image.dense_resize': types.SimpleNamespace(
                resize_for_inference=lambda image, edge: (image, (1, 1)),
                restore_dense_output=lambda value, *a, **kw: value,
            ),
            'ai.common.utils': types.SimpleNamespace(colorize_depth=lambda value: value),
            'ai.common.avi.descriptor': types.SimpleNamespace(
                descriptor_from_payload=lambda data: {}, forward_enriched_image=lambda *a: None
            ),
        }
        for name, value in stubs.items():
            monkeypatch.setitem(sys.modules, name, value)
        spec = importlib.util.spec_from_file_location(package.__name__ + '.IInstance', root / 'IInstance.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        instance = module.IInstance()
        instance.IGlobal = types.SimpleNamespace(device_lock=threading.Lock())
        instance.writeImage(0, 'image/png', b'')
        instance.writeImage(1, 'image/png', b'data')
        return instance, image

    return load


@pytest.mark.parametrize('node', ['detect', 'depth_estimate', 'detect_segment'])
@pytest.mark.parametrize('failure', ['decode', 'inference'])
def test_frame_failure_reaches_engine_and_releases_buffer(handler, node, failure):
    instance, processor = handler(node)
    emitted = []

    def fail(*args, **kwargs):
        raise ValueError('injected frame failure')

    if failure == 'decode':
        processor.load_image_from_bytes = fail
    if node == 'detect':
        instance.IGlobal.detector = types.SimpleNamespace(detect=fail)
        instance._emit = lambda *a: emitted.append(a)
    elif node == 'detect_segment':
        instance.IGlobal.segmenter = types.SimpleNamespace(segment=fail)
        instance._emit = lambda *a: emitted.append(a)
    else:
        instance._emit = fail
    with pytest.raises(RuntimeError, match='failed to process') as caught:
        instance.writeImage(2, 'image/png', b'')
    assert isinstance(caught.value.__cause__, ValueError)
    assert instance._image_data is None
    assert emitted == []
    assert instance.IGlobal.device_lock.acquire(blocking=False)
    instance.IGlobal.device_lock.release()


@pytest.mark.parametrize('node', ['detect', 'depth_estimate', 'detect_segment'])
def test_successful_frame_still_emits(handler, node):
    instance, _ = handler(node)
    emitted = []
    instance.IGlobal.detector = types.SimpleNamespace(detect=lambda image: [])
    instance.IGlobal.segmenter = types.SimpleNamespace(segment=lambda image: {})
    instance._emit = lambda *args: emitted.append(args)
    assert instance.writeImage(2, 'image/png', b'') == 'handled'
    assert len(emitted) == 1
    assert instance._image_data is None
