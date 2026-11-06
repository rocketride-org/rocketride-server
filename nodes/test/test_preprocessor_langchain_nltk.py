# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""The NLTK splitter records, at import, whether ``nltk`` can be imported.

On a fresh engine that import happens before ``depends()`` installs ``nltk``,
so the cached module still reports it missing. The node reloads the module
once ``nltk`` is importable. This does not download the punkt data.
"""

import importlib
import importlib.util
import sys
import types
from pathlib import Path

import pytest

_LANGCHAIN = Path(__file__).resolve().parents[1] / 'src' / 'nodes' / 'preprocessor_langchain' / 'langchain.py'


class _HideNltk:
    """Import finder that makes ``nltk`` unimportable."""

    def find_spec(self, fullname, _path, _target=None):
        if fullname == 'nltk' or fullname.startswith('nltk.'):
            raise ModuleNotFoundError(fullname)
        return None


def _saved_nltk_modules():
    names = [
        name
        for name in list(sys.modules)
        if name == 'nltk' or name.startswith('nltk.') or name == 'langchain_text_splitters.nltk'
    ]
    return {name: sys.modules.pop(name) for name in names}


def _restore_nltk_modules(saved):
    for name in list(sys.modules):
        if name == 'nltk' or name.startswith('nltk.') or name == 'langchain_text_splitters.nltk':
            sys.modules.pop(name, None)
    sys.modules.update(saved)
    if 'langchain_text_splitters.nltk' in sys.modules:
        importlib.reload(sys.modules['langchain_text_splitters.nltk'])


def _make_nltk_importable():
    """Put a stand-in ``nltk`` on ``sys.modules`` so a reload can import it.

    The real package is not required, and neither is the punkt download the
    splitter would otherwise attempt.
    """
    nltk = types.ModuleType('nltk')
    tokenize = types.ModuleType('nltk.tokenize')
    tokenize.sent_tokenize = lambda text, language='english': [text]
    nltk.tokenize = tokenize
    data = types.ModuleType('nltk.data')
    data.find = lambda resource: resource
    nltk.data = data
    nltk.download = lambda *_args, **_kwargs: True
    sys.modules['nltk'] = nltk


def _package(name):
    module = types.ModuleType(name)
    module.__path__ = []
    module.__package__ = name
    return module


def _install_load_stubs():
    """Stub the engine imports ``langchain.py`` needs so the test can load it.

    ``depends()`` stays a no-op: the test makes ``nltk`` importable itself and
    must not pip-install it.
    """
    names = ('depends', 'rocketlib', 'ai', 'ai.common', 'ai.common.config', 'ai.common.preprocessor')
    saved = {name: sys.modules.get(name) for name in names}

    depends = types.ModuleType('depends')
    depends.depends = lambda *_args, **_kwargs: None
    rocketlib = types.ModuleType('rocketlib')
    rocketlib.monitorStatus = lambda *_args, **_kwargs: None
    ai = _package('ai')
    common = _package('ai.common')
    config = types.ModuleType('ai.common.config')
    config.Config = type('Config', (), {})
    preprocessor = types.ModuleType('ai.common.preprocessor')

    class PreProcessorBase:
        def __init__(self, provider, connConfig, bag):
            pass

    preprocessor.PreProcessorBase = PreProcessorBase
    ai.common = common
    common.config = config
    common.preprocessor = preprocessor

    sys.modules['depends'] = depends
    sys.modules['rocketlib'] = rocketlib
    sys.modules['ai'] = ai
    sys.modules['ai.common'] = common
    sys.modules['ai.common.config'] = config
    sys.modules['ai.common.preprocessor'] = preprocessor
    return saved


def _restore_modules(saved):
    for name, module in saved.items():
        if module is None:
            sys.modules.pop(name, None)
        else:
            sys.modules[name] = module


def _load_preprocessor():
    spec = importlib.util.spec_from_file_location('preprocessor_langchain_under_test', _LANGCHAIN)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_nltk_splitter_builds_after_nltk_becomes_importable():
    """A splitter imported while ``nltk`` is hidden still builds once it is importable."""
    pytest.importorskip('langchain_text_splitters')

    saved_nltk = _saved_nltk_modules()
    saved_stubs = None
    blocker = _HideNltk()
    sys.meta_path.insert(0, blocker)
    try:
        nltk_splitters = importlib.import_module('langchain_text_splitters.nltk')
        with pytest.raises(ImportError, match='NLTK is not installed'):
            nltk_splitters.NLTKTextSplitter()

        sys.meta_path.remove(blocker)
        blocker = None
        _make_nltk_importable()

        saved_stubs = _install_load_stubs()
        module = _load_preprocessor()
        processor = module.PreProcessor.__new__(module.PreProcessor)
        processor._mode = 'strlen'
        processor._splitSize = 512
        built = processor._getSplitter('preprocessor_langchain', {'splitter': 'NLTKTextSplitter'})

        assert type(built).__name__ == 'NLTKTextSplitter'
        assert type(built).__module__ == 'langchain_text_splitters.nltk'
    finally:
        if blocker is not None and blocker in sys.meta_path:
            sys.meta_path.remove(blocker)
        if saved_stubs is not None:
            _restore_modules(saved_stubs)
        _restore_nltk_modules(saved_nltk)
