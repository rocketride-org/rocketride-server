# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""Tests for the filesystem sink: services.json contract + naming helper."""

from __future__ import annotations

import importlib.util
import json
import sys
import types
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

_NODE_DIR = Path(__file__).resolve().parent.parent.parent / 'src' / 'nodes' / 'filesystem'


def _load_services():
    return json.loads((_NODE_DIR / 'services.json').read_text())


class TestServicesContract:
    def test_classtype_is_tool_and_store(self):
        d = _load_services()
        assert d['classType'] == ['tool', 'store']

    def test_all_input_lanes_emit_documents(self):
        d = _load_services()
        assert d['lanes'] == {
            'documents': ['documents'],
            'text': ['documents'],
            'table': ['documents'],
            'image': ['documents'],
            'audio': ['documents'],
            'video': ['documents'],
        }

    def test_new_config_fields_present_with_defaults(self):
        f = _load_services()['fields']
        assert f['filesystem.targetDir']['type'] == 'string'
        assert f['filesystem.targetDir']['default'] == 'output/'
        assert f['filesystem.emitUrl']['type'] == 'boolean'
        assert f['filesystem.emitUrl']['default'] is False
        assert f['filesystem.urlExpiresIn']['type'] == 'integer'
        assert f['filesystem.urlExpiresIn']['default'] == 3600


def _install_stubs():
    """Install engine + ``ai`` stubs so IGlobal/IInstance import as pure Python.

    The real ``ai`` package needs the engine-only ``depends`` module, so these
    unit tests stub the tree. ``setdefault``/``getattr`` guards ensure a real
    module (present under ``./builder nodes:test``) is never clobbered, and the
    ``ai.common.utils`` shims are faithful so the sibling ``test_read_size_cap``
    still works if it inherits them.
    """
    rl = sys.modules.get('rocketlib') or types.ModuleType('rocketlib')
    rl.IInstanceBase = getattr(rl, 'IInstanceBase', type('IInstanceBase', (), {}))
    rl.IGlobalBase = getattr(rl, 'IGlobalBase', type('IGlobalBase', (), {}))
    if not hasattr(rl, 'tool_function'):

        def _tf(**meta):
            def wrap(fn):
                fn.__tool_meta__ = meta
                return fn

            return wrap

        rl.tool_function = _tf
    rl.OPEN_MODE = getattr(rl, 'OPEN_MODE', types.SimpleNamespace(CONFIG='config'))
    rl.AVI_ACTION = getattr(rl, 'AVI_ACTION', types.SimpleNamespace(BEGIN=0, WRITE=1, END=2))
    rl.Entry = getattr(rl, 'Entry', object)
    rl.warning = getattr(rl, 'warning', lambda *a, **k: None)
    sys.modules['rocketlib'] = rl

    for name in ('ai', 'ai.account', 'ai.common'):
        sys.modules.setdefault(name, types.ModuleType(name))

    if 'ai.account.store' not in sys.modules:
        m = types.ModuleType('ai.account.store')
        m.Store = object
        sys.modules['ai.account.store'] = m
    if 'ai.common.config' not in sys.modules:
        m = types.ModuleType('ai.common.config')
        m.Config = object
        sys.modules['ai.common.config'] = m
    if 'ai.common.utils' not in sys.modules:
        m = types.ModuleType('ai.common.utils')

        def require_dict(args, **k):
            if not isinstance(args, dict):
                raise ValueError('args must be a dict')
            return args

        def require_str(args, key, tool_name=None, **k):
            v = args.get(key)
            if not isinstance(v, str):
                raise ValueError(f'{key} is required and must be a string')
            return v

        def optional_str(args, key, default=None, tool_name=None, **k):
            v = args.get(key, default)
            if v is not None and not isinstance(v, str):
                raise ValueError(f'{key} must be a string')
            return v

        m.require_dict = require_dict
        m.require_str = require_str
        m.optional_str = optional_str
        sys.modules['ai.common.utils'] = m
    if 'ai.common.schema' not in sys.modules:
        m = types.ModuleType('ai.common.schema')

        class _DocMetadata:
            # Mirror the real DocMetadata: objectId and chunkId are REQUIRED.
            def __init__(self, *, objectId, chunkId, **kwargs):
                self.objectId = objectId
                self.chunkId = chunkId
                self.__dict__.update(kwargs)

        class _Doc:
            # Mirror the real Doc: ``metadata`` is None unless explicitly passed
            # (a fresh Doc does NOT auto-create a metadata object).
            def __init__(self, page_content=None, metadata=None):
                self.page_content = page_content
                self.metadata = metadata

        m.Doc = _Doc
        m.DocMetadata = _DocMetadata
        sys.modules['ai.common.schema'] = m


def _load_real_iglobal():
    """Load the real ``IGlobal`` under a unique module name (deps stubbed) so
    ``_sink_config`` can be unit-tested without the engine.
    """
    _install_stubs()
    spec = importlib.util.spec_from_file_location('tfs_iglobal_real', str(_NODE_DIR / 'IGlobal.py'))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.IGlobal


class TestSinkConfig:
    def test_defaults_when_missing(self):
        IG = _load_real_iglobal()
        assert IG._sink_config({}) == ('output/', False, 3600)

    def test_explicit_values(self):
        IG = _load_real_iglobal()
        assert IG._sink_config({'targetDir': 'out2/', 'emitUrl': True, 'urlExpiresIn': 120}) == (
            'out2/',
            True,
            120,
        )

    def test_url_expires_clamped_to_ceiling(self):
        IG = _load_real_iglobal()
        assert IG._sink_config({'urlExpiresIn': 999999})[2] == 3600

    def test_url_expires_non_positive_falls_back_to_default(self):
        IG = _load_real_iglobal()
        assert IG._sink_config({'urlExpiresIn': -5})[2] == 3600
        assert IG._sink_config({'urlExpiresIn': 0})[2] == 3600


# ---------------------------------------------------------------------------
# IInstance sink harness (shared by test_sink_lanes.py)
# ---------------------------------------------------------------------------


def _install_iinstance_stubs():
    """Stubs for importing the real IInstance: engine/ai stubs + a stub
    ``filesystem`` package whose ``__path__`` points at the node dir.
    """
    _install_stubs()
    if 'filesystem' not in sys.modules:
        pkg = types.ModuleType('filesystem')
        pkg.__path__ = [str(_NODE_DIR)]
        sys.modules['filesystem'] = pkg
    if 'filesystem.IGlobal' not in sys.modules:
        ig = types.ModuleType('filesystem.IGlobal')

        class _IGlobalStub:
            file_store = None
            allow_write = True
            path_patterns = None
            target_dir = 'output/'
            emit_url = False
            url_expires_in = 3600

        ig.IGlobal = _IGlobalStub
        sys.modules['filesystem.IGlobal'] = ig


def _fs(exists_paths=()):
    """AsyncMock FileStore: write/stat/get_url. ``stat`` reports existence."""
    fs = AsyncMock()
    fs.write = AsyncMock(return_value=None)

    async def _stat(p):
        return {'exists': p in exists_paths}

    fs.stat = AsyncMock(side_effect=_stat)
    fs.get_url = AsyncMock(return_value='https://x/task/fetch?token=t')
    return fs


def _sink_instance(
    file_store,
    *,
    has_name=True,
    name='report.pdf',
    object_id='obj-123',
    target_dir='output/',
    emit_url=False,
    url_expires_in=3600,
    allow_write=True,
    path_patterns=None,
):
    """Build an IInstance wired to a stub IGlobal + mocked engine ``instance``."""
    _install_iinstance_stubs()
    from filesystem.IGlobal import IGlobal
    from filesystem.IInstance import IInstance

    inst = IInstance()
    g = IGlobal()
    g.file_store = file_store
    g.allow_write = allow_write
    g.path_patterns = path_patterns
    g.target_dir = target_dir
    g.emit_url = emit_url
    g.url_expires_in = url_expires_in
    inst.IGlobal = g
    inst.instance = MagicMock()
    # NB: ``name`` is a reserved MagicMock constructor kwarg (sets the mock's
    # repr, not a ``.name`` attribute), so assign it after construction.
    current = MagicMock(hasName=has_name, objectId=object_id)
    current.name = name
    inst.instance.currentObject = current
    return inst


class TestSinkPersist:
    def test_uses_object_name_and_target_dir(self):
        fs = _fs()
        inst = _sink_instance(fs, name='report.pdf', target_dir='output/')
        ref = inst._sink_persist(b'data', ext_hint=None, mime=None)
        assert ref['storePath'] == 'output/report.pdf'
        (path_arg, data_arg), _ = fs.write.await_args
        assert path_arg == 'output/report.pdf' and data_arg == b'data'

    def test_fallback_to_object_id_and_md_ext(self):
        fs = _fs()
        inst = _sink_instance(fs, has_name=False, object_id='obj-9')
        ref = inst._sink_persist(b'# hi', ext_hint='.md', mime=None)
        assert ref['storePath'] == 'output/obj-9.md'

    def test_media_extension_from_mime(self):
        fs = _fs()
        inst = _sink_instance(fs, has_name=False, object_id='m1')
        ref = inst._sink_persist(b'\x00', ext_hint=None, mime='image/png')
        assert ref['storePath'] == 'output/m1.png'

    def test_collision_autosuffix(self):
        fs = _fs(exists_paths={'output/report.pdf', 'output/report_1.pdf'})
        inst = _sink_instance(fs, name='report.pdf')
        ref = inst._sink_persist(b'd', ext_hint=None, mime=None)
        assert ref['storePath'] == 'output/report_2.pdf'

    def test_emit_url_attaches_signed_url(self):
        fs = _fs()
        inst = _sink_instance(fs, emit_url=True, url_expires_in=120)
        ref = inst._sink_persist(b'd', ext_hint=None, mime=None)
        assert ref['url'] == 'https://x/task/fetch?token=t'
        _, kwargs = fs.get_url.await_args
        assert kwargs.get('expires_in') == 120

    def test_no_url_when_emit_disabled(self):
        fs = _fs()
        inst = _sink_instance(fs, emit_url=False)
        ref = inst._sink_persist(b'd', ext_hint=None, mime=None)
        assert ref['url'] is None
        fs.get_url.assert_not_awaited()

    def test_allow_write_gate(self):
        fs = _fs()
        inst = _sink_instance(fs, allow_write=False)
        with pytest.raises(ValueError, match='write access is not enabled'):
            inst._sink_persist(b'd', ext_hint=None, mime=None)
        fs.write.assert_not_awaited()

    def test_path_whitelist_enforced(self):
        import re

        fs = _fs()
        inst = _sink_instance(fs, name='secret.pdf', path_patterns=[re.compile(r'^output/allowed')])
        with pytest.raises(ValueError, match='does not match any allowed path pattern'):
            inst._sink_persist(b'd', ext_hint=None, mime=None)
