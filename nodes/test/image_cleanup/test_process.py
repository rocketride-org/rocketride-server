# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Deterministic tests for image_cleanup's PNG processing contract."""

import importlib.util
import sys
from pathlib import Path
from types import ModuleType
from typing import Callable

import pytest


NODE_DIR = Path(__file__).parents[2] / 'src' / 'nodes' / 'image_cleanup'


def _load_module(monkeypatch, module_name, filename, dependencies=None):
    """Load one image_cleanup module with only its direct dependencies stubbed."""
    package = module_name.rsplit('.', 1)[0]
    package_module = ModuleType(package)
    package_module.__path__ = [str(NODE_DIR)]
    monkeypatch.setitem(sys.modules, package, package_module)

    for dependency, attributes in (dependencies or {}).items():
        dependency_module = ModuleType(f'{package}.{dependency}')
        for name, value in attributes.items():
            setattr(dependency_module, name, value)
        monkeypatch.setitem(sys.modules, dependency_module.__name__, dependency_module)

    spec = importlib.util.spec_from_file_location(module_name, NODE_DIR / filename)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, module_name, module)
    spec.loader.exec_module(module)
    return module


def test_process_image_returns_png_contract_and_runs_each_stage_once(monkeypatch):
    """Each stage receives the previous result and the public return is ``(MIME, bytes)``."""
    calls = []

    def ensure_png(mime_type, image_bytes):
        calls.append(('ensure_png', mime_type, image_bytes))
        return 'image/png', b'normalized'

    def stage(name, output):
        def run(image_bytes):
            calls.append((name, image_bytes))
            return output

        return run

    module = _load_module(
        monkeypatch,
        '_image_cleanup_process_test.process',
        'process.py',
        {
            'png': {'ensure_png': ensure_png},
            'binary': {'binary_image': stage('binary_image', b'binary')},
            'deskew': {'deskew_image': stage('deskew_image', b'deskewed')},
            'morphology': {'morph_image': stage('morph_image', b'cleaned')},
        },
    )

    assert module.process_image('image/jpeg', b'original') == ('image/png', b'cleaned')
    assert calls == [
        ('ensure_png', 'image/jpeg', b'original'),
        ('binary_image', b'normalized'),
        ('deskew_image', b'binary'),
        ('morph_image', b'deskewed'),
    ]


def test_process_image_return_annotation_matches_runtime_tuple(monkeypatch):
    """Static callers see the same two-value contract that the function returns."""

    def identity(value):
        return value

    module = _load_module(
        monkeypatch,
        '_image_cleanup_annotation_test.process',
        'process.py',
        {
            'png': {'ensure_png': lambda mime, data: ('image/png', data)},
            'binary': {'binary_image': identity},
            'deskew': {'deskew_image': identity},
            'morphology': {'morph_image': identity},
        },
    )

    assert module.process_image.__annotations__['return'] == tuple[str, bytes]


def test_global_process_annotation_matches_runtime_tuple(monkeypatch):
    """The callable exposed to instances carries the same two-value contract."""
    rocketlib = ModuleType('rocketlib')
    rocketlib.IGlobalBase = type('IGlobalBase', (), {})
    config_module = ModuleType('ai.common.config')
    config_module.Config = type('Config', (), {})

    monkeypatch.setitem(sys.modules, 'rocketlib', rocketlib)
    monkeypatch.setitem(sys.modules, 'ai', ModuleType('ai'))
    monkeypatch.setitem(sys.modules, 'ai.common', ModuleType('ai.common'))
    monkeypatch.setitem(sys.modules, 'ai.common.config', config_module)

    module = _load_module(monkeypatch, '_image_cleanup_global_test.IGlobal', 'IGlobal.py')

    assert module.IGlobal.__annotations__['process'] == Callable[[str, bytes], tuple[str, bytes]]


class _FakePILImage:
    """Minimal Pillow image used to test conversion without an optional dependency."""

    def __init__(self):
        self.converted_to = None

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def convert(self, mode):
        self.converted_to = mode
        return self

    def save(self, output, format):  # noqa: A002 - mirrors Pillow's public keyword
        assert format == 'PNG'
        output.write(b'converted-png')


def _load_png_module(monkeypatch, open_image):
    pil_module = ModuleType('PIL')
    pil_module.Image = type('_ImageAPI', (), {'open': staticmethod(open_image)})
    monkeypatch.setitem(sys.modules, 'PIL', pil_module)
    return _load_module(monkeypatch, '_image_cleanup_png_test.png', 'png.py')


def test_ensure_png_passes_png_bytes_through_without_opening_image(monkeypatch):
    """PNG input keeps byte identity and does not invoke Pillow."""
    module = _load_png_module(monkeypatch, lambda _stream: pytest.fail('PNG pass-through opened Pillow'))
    source = b'already-png'

    assert module.ensure_png('IMAGE/PNG', source) == ('image/png', source)


def test_ensure_png_converts_non_png_input_to_rgba_png(monkeypatch):
    """Non-PNG input is opened, normalized to RGBA, and returned with the PNG MIME type."""
    image = _FakePILImage()
    seen = []

    def open_image(stream):
        seen.append(stream.read())
        return image

    module = _load_png_module(monkeypatch, open_image)

    assert module.ensure_png('image/jpeg', b'jpeg-source') == ('image/png', b'converted-png')
    assert seen == [b'jpeg-source']
    assert image.converted_to == 'RGBA'


def test_ensure_png_reports_conversion_failures(monkeypatch):
    """A decoder failure remains a clear node-level ``ValueError``."""
    module = _load_png_module(monkeypatch, lambda _stream: (_ for _ in ()).throw(OSError('bad image')))

    with pytest.raises(ValueError, match='Failed to convert image to PNG: bad image'):
        module.ensure_png('image/jpeg', b'not-an-image')
