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

``ai.common.utils.decode_data_url`` and the tool-argument validators the node uses
(``normalize_tool_input``, ``require_str``, ``require_int``, ``optional_str``,
``optional_int``, ``optional_bool``, ``int_arg``) are the real helpers loaded from source: the node's PEM handling and input validation must match
what the engine does, not a copy of it.
"""

from __future__ import annotations

import importlib.util
import sys
import types
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import Mock

_REPO_ROOT = Path(__file__).resolve().parents[3]
_NODES_SRC = _REPO_ROOT / 'nodes' / 'src' / 'nodes'
_FILE_UTILS = _REPO_ROOT / 'packages' / 'ai' / 'src' / 'ai' / 'common' / 'utils' / 'file_utils.py'
_TOOL_ARGS = _REPO_ROOT / 'packages' / 'ai' / 'src' / 'ai' / 'common' / 'utils' / 'tool_args.py'
_TOOL_ARG_HELPERS = (
    'normalize_tool_input',
    'require_str',
    'require_int',
    'optional_str',
    'optional_int',
    'optional_bool',
    'int_arg',
    'require_str_list',
)

STUB_MODULE_NAMES = ('rocketlib', 'ai', 'ai.common', 'ai.common.utils')

# The branch each auth leaf is stored under (plan section 5.6.2): a flat test
# config names the leaves, ``to_conn_config`` nests them where the resolver reads.
_BRANCH_OF = {'token': 'pat', 'appId': 'app', 'privateKey': 'app', 'installationId': 'app'}

#: The stored config the current ``install_stubs`` call bound; ``conn_config()`` reads it.
_CURRENT_CONN_CONFIG: dict = {}


def to_conn_config(flat: dict | None) -> dict:
    """Nest a flat test config into the path-addressed shape the resolver expects.

    A ``credentialMap`` written as a dict (repository to credential, the terse form
    the routing tests use) is stored as the form's rows, which is the array leaf
    the schema declares; a list or a string is stored as given.
    """
    nested: dict = {}
    for key, value in (flat or {}).items():
        branch = _BRANCH_OF.get(key)
        if branch:
            nested.setdefault(branch, {})[key] = value
        elif key == 'credentialMap' and isinstance(value, dict):
            nested[key] = [
                {'credentialRepository': repository, 'credentialValue': credential}
                for repository, credential in value.items()
            ]
        else:
            nested[key] = value
    return nested


def conn_config() -> dict:
    """The stored config bound by the enclosing ``scoped_stubs``, for ``glb.connConfig``."""
    return dict(_CURRENT_CONN_CONFIG)


# What the schema's defaults give every option the node's readers touch.
_OPTION_DEFAULTS = {
    'authType': 'pat',
    'readOnly': False,
    'tools': [],
    'graphqlAllowMutations': False,
    'graphqlMaxResponseBytes': 4194304,
    'rateLimitBudgetSeconds': 60,
    'rateLimitMaxRetries': 3,
}


class FlatConfig(Mapping):
    """A flat test config read the way the node reads its ``ConfigView``: by item and attribute.

    For the parser-level tests: the schema stores a ``credentialMap`` as the form's rows,
    so a map written as an object or as JSON text, a bad row key or a bad value never
    reaches the node through the resolver. These tests check the node's own readers
    (``node_config``), so they hand them the config directly, defaults applied.
    """

    def __init__(self, flat: dict | None) -> None:
        self._values = {**_OPTION_DEFAULTS, **(flat or {})}

    def __getitem__(self, key):
        return self._values[key]

    def __getattr__(self, name):
        if name.startswith('_') or name not in self._values:
            raise AttributeError(name)
        return self._values[name]

    def __iter__(self):
        return iter(self._values)

    def __len__(self):
        return len(self._values)


def flat_config(flat: dict | None) -> FlatConfig:
    """``flat`` as the node's readers see a config, defaults applied."""
    return FlatConfig(flat)


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


def _load_real_tool_args():
    """Load the engine's validators from source; ``rocketlib`` must already be stubbed."""
    spec = importlib.util.spec_from_file_location('_tool_github_test_tool_args', _TOOL_ARGS)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def install_stubs(node_config: dict | None = None) -> None:
    """Bind ``node_config`` (flat leaves) as the stored config and stub the node's engine-only deps.

    The stub ``rocketlib`` keeps the REAL ``IGlobalBase`` so ``self.config`` resolves
    through the engine's schema for tool_github; ``warning`` is a Mock the tests inspect.
    """
    global _CURRENT_CONN_CONFIG
    _CURRENT_CONN_CONFIG = to_conn_config(node_config)

    mod_rl = types.ModuleType('rocketlib')
    # The real submodules by their sys.modules entries, so a leaked stub parent cannot hide them.
    mod_rl.engine = importlib.import_module('rocketlib.engine')
    mod_rl.config = importlib.import_module('rocketlib.config')

    def mock_tool_function(*, input_schema=None, description=None, output_schema=None):
        # Stamp the metadata like rocketlib does, so the node's tool list is the real one.
        def decorator(fn):
            fn.__tool_meta__ = {
                'input_schema': input_schema,
                'description': description,
                'output_schema': output_schema,
            }
            return fn

        return decorator

    mod_rl.tool_function = mock_tool_function

    class IInstanceBase:
        def _collect_tool_methods(self):
            # Same walk as rocketlib's IInstanceBase: every @tool_function method by name.
            return {
                name: getattr(self, name)
                for name in dir(type(self))
                if hasattr(getattr(type(self), name, None), '__tool_meta__')
            }

    # The real base: its ``config`` property resolves self.glb.connConfig against
    # the engine's schema for tool_github (rocketlib.filters is never stubbed).
    from rocketlib.filters import IGlobalBase, IValidatorBase

    mod_rl.IInstanceBase = IInstanceBase
    mod_rl.IGlobalBase = IGlobalBase
    mod_rl.IValidatorBase = IValidatorBase
    mod_rl.warning = Mock()
    sys.modules['rocketlib'] = mod_rl

    sys.modules['ai'] = types.ModuleType('ai')
    sys.modules['ai.common'] = types.ModuleType('ai.common')

    mod_ai_common_utils = types.ModuleType('ai.common.utils')
    tool_args = _load_real_tool_args()
    for name in _TOOL_ARG_HELPERS:
        setattr(mod_ai_common_utils, name, getattr(tool_args, name))
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
