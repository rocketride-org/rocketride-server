# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Module stubs shared by the tool_github unit tests.

The node imports ``rocketlib`` and ``ai.common.*``, which are only present inside
the engine. ``scoped_stubs`` installs light stand-ins for them, forces a clean
import of ``tool_github.*`` bound to the given node config, and on exit restores
every module it touched, including the ``tool_github.*`` modules another test file
imported earlier, so file order does not matter.

``ai.common.utils.decode_data_url`` is the real helper loaded from source: the
node's PEM handling must match what the engine does, not a copy of it.
"""

from __future__ import annotations

import importlib.util
import sys
import types
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import Mock

_REPO_ROOT = Path(__file__).resolve().parents[3]
_NODES_SRC = _REPO_ROOT / 'nodes' / 'src' / 'nodes'
_FILE_UTILS = _REPO_ROOT / 'packages' / 'ai' / 'src' / 'ai' / 'common' / 'utils' / 'file_utils.py'

STUB_MODULE_NAMES = ('rocketlib', 'ai', 'ai.common', 'ai.common.config', 'ai.common.utils')

if str(_NODES_SRC) not in sys.path:
    sys.path.insert(0, str(_NODES_SRC))


def _load_real_decode_data_url():
    # file_utils imports ``filetype`` for guess_filename only; stand it in when absent.
    placeholder = None
    if importlib.util.find_spec('filetype') is None:
        placeholder = types.ModuleType('filetype')
        sys.modules['filetype'] = placeholder
    try:
        spec = importlib.util.spec_from_file_location('_tool_github_test_file_utils', _FILE_UTILS)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    finally:
        if placeholder is not None:
            sys.modules.pop('filetype', None)
    return module.decode_data_url


decode_data_url = _load_real_decode_data_url()


def install_stubs(node_config: dict | None = None) -> None:
    mod_rl = types.ModuleType('rocketlib')

    def mock_tool_function(*args, **kwargs):
        return lambda f: f

    mod_rl.tool_function = mock_tool_function

    class IInstanceBase:
        pass

    class IGlobalBase:
        pass

    mod_rl.IInstanceBase = IInstanceBase
    mod_rl.IGlobalBase = IGlobalBase
    mod_rl.OPEN_MODE = types.SimpleNamespace(CONFIG='config')
    mod_rl.warning = Mock()
    sys.modules['rocketlib'] = mod_rl

    sys.modules['ai'] = types.ModuleType('ai')
    sys.modules['ai.common'] = types.ModuleType('ai.common')

    mod_ai_common_config = types.ModuleType('ai.common.config')

    class Config:
        @staticmethod
        def getNodeConfig(logical_type, conn_config):
            return node_config if node_config is not None else {}

    mod_ai_common_config.Config = Config
    sys.modules['ai.common.config'] = mod_ai_common_config

    mod_ai_common_utils = types.ModuleType('ai.common.utils')
    mod_ai_common_utils.normalize_tool_input = lambda x, **kwargs: x
    mod_ai_common_utils.require_str = lambda x, k, **kwargs: x.get(k)
    mod_ai_common_utils.require_int = lambda x, k, **kwargs: x.get(k)
    mod_ai_common_utils.decode_data_url = decode_data_url
    sys.modules['ai.common.utils'] = mod_ai_common_utils


def _tool_github_modules() -> list[str]:
    return [k for k in sys.modules if k == 'tool_github' or k.startswith('tool_github.')]


@contextmanager
def scoped_stubs(node_config: dict | None = None, *, keep_modules: bool = False) -> Iterator[None]:
    """Install fresh stubs bound to ``node_config`` and re-import ``tool_github.*`` inside.

    Everything that touches ``tool_github.*`` (imports, patches, assertions) must happen
    inside this context. On exit the stubs are removed and the ``tool_github.*`` modules
    present before (another test file's module-level imports) are put back, so
    ``@patch('tool_github....')`` targets in that file keep pointing at its own modules.

    ``keep_modules=True`` is for a module-level import: the ``tool_github.*`` modules
    imported inside stay in ``sys.modules`` so the file's ``@patch`` targets resolve to them.
    """
    saved = {name: sys.modules.get(name) for name in (*STUB_MODULE_NAMES, *_tool_github_modules())}
    for name in _tool_github_modules():
        del sys.modules[name]
    install_stubs(node_config)
    try:
        yield
    finally:
        if not keep_modules:
            for name in _tool_github_modules():
                del sys.modules[name]
        for name, module in saved.items():
            if module is None:
                if not keep_modules or not name.startswith('tool_github'):
                    sys.modules.pop(name, None)
            else:
                sys.modules[name] = module
