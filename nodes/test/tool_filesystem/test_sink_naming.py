# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""Tests for the tool_filesystem sink: services*.json contracts, config, and the
per-lane naming/path helpers.
"""

from __future__ import annotations

import importlib.util
import json
import sys
import types
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

_NODE_DIR = Path(__file__).resolve().parent.parent.parent / 'src' / 'nodes' / 'tool_filesystem'


def _load_services(name='services.tool.json'):
    return json.loads((_NODE_DIR / name).read_text())


class TestServicesContract:
    def test_tool_variant_reverted_to_tool_only(self):
        d = _load_services()
        assert d['classType'] == ['tool']
        assert d['lanes'] == {}
        assert d['protocol'] == 'tool_filesystem://'
        # Sink config must be gone from the tool surface.
        for key in (
            'filesystem.targetDir',
            'filesystem.onConflict',
            'filesystem.emitUrl',
            'filesystem.urlExpiresIn',
        ):
            assert key not in d['fields']
            assert key not in d['shape'][0]['properties']

    def test_store_variant_identity(self):
        d = _load_services('services.store.json')
        assert d['protocol'] == 'filestore://'
        assert d['title'] == 'File Store'
        assert d['classType'] == ['store']
        assert d['register'] == 'filter'
        assert d['path'] == 'nodes.tool_filesystem'

    def test_store_variant_lanes_all_emit_json(self):
        d = _load_services('services.store.json')
        assert d['lanes'] == {
            'documents': ['json'],
            'text': ['json'],
            'table': ['json'],
            'image': ['json'],
            'audio': ['json'],
            'video': ['json'],
        }

    def test_store_variant_fields(self):
        d = _load_services('services.store.json')
        f = d['fields']
        assert f['filesystem.targetDir']['type'] == 'string'
        assert f['filesystem.targetDir']['default'] == 'output/'
        assert f['filesystem.emitUrl']['type'] == 'boolean'
        assert f['filesystem.emitUrl']['default'] is False
        assert f['filesystem.urlExpiresIn']['type'] == 'integer'
        assert f['filesystem.urlExpiresIn']['default'] == 3600
        assert f['filesystem.urlExpiresIn']['minimum'] == 1
        assert f['filesystem.urlExpiresIn']['maximum'] == 3600
        assert f['filesystem.onConflict']['type'] == 'string'
        assert f['filesystem.onConflict']['default'] == 'unique', 'the safe outcome must be the default'
        assert [c[0] for c in f['filesystem.onConflict']['enum']] == ['unique', 'overwrite', 'skip']
        assert 'filesystem.onConflict' in d['shape'][0]['properties']
        # No agent-tool toggles on the store surface.
        assert not any(k.startswith('filesystem.allow') for k in f)

    def test_source_variant_identity(self):
        d = _load_services('services.source.json')
        assert d['protocol'] == 'filestore_source://'
        assert d['title'] == 'File Store Source'
        assert d['classType'] == ['source']
        assert d['register'] == 'endpoint'
        assert d['capabilities'] == ['noinclude']
        assert d['path'] == 'nodes.tool_filesystem'
        # Raw objects go out on the tags lane for a downstream Parser.
        assert d['lanes'] == {'_source': ['tags']}
        # The shape must route the declared fields through the source-parameters
        # wrapper (telegram/dropper convention) — fields listed directly in the
        # Pipe section never reach serviceConfig['parameters'] at runtime.
        assert d['shape'][0]['properties'] == ['type', 'Pipe.source.parameters']

    def test_source_variant_fields(self):
        d = _load_services('services.source.json')
        f = d['fields']
        assert f['filesystem.path']['type'] == 'string'
        assert f['filesystem.recursive']['type'] == 'boolean'
        assert f['filesystem.recursive']['default'] is False
        # Source-parameters wrapper: the engine strips the 'filesystem.' prefix
        # and delivers these flat under serviceConfig['parameters'].
        assert f['Pipe.source.parameters'] == {
            'section': 'parameters',
            'properties': ['filesystem.path', 'filesystem.recursive'],
        }


def _install_stubs():
    """Install engine + ``ai`` stubs so IGlobal/IInstance import as pure Python.

    The real ``ai`` package needs the engine-only ``depends`` module, so these
    unit tests stub the tree. ``setdefault``/``getattr`` guards ensure a real
    module (present under ``./builder nodes:test``) is never clobbered.
    """
    rl = sys.modules.get('rocketlib') or types.ModuleType('rocketlib')
    # Other node suites install their own bare ``rocketlib`` stubs (e.g. an
    # empty ``IInstanceBase``); under xdist whichever ran first in the worker
    # wins. Judge the base by capability, not presence: the real class and our
    # stub both have ``preventDefault``, a foreign empty stub does not.
    if not hasattr(getattr(rl, 'IInstanceBase', None), 'preventDefault'):

        class _IInstanceBase:
            def preventDefault(self):
                # Sentinel so lane-handler tests can assert default routing is
                # suppressed. The real engine base returns its own control value.
                return 'PREVENT_DEFAULT'

        rl.IInstanceBase = _IInstanceBase
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
            # Mirror the real DocMetadata: first positional arg is the pInstance,
            # from which objectId/nodeId/etc are auto-filled; kwargs override.
            def __init__(self, pInstance=None, **data):
                if pInstance is not None:
                    obj = pInstance.instance.currentObject
                    self.objectId = getattr(obj, 'objectId', None)
                    self.chunkId = 0
                self.__dict__.update(data)

        class _Doc:
            def __init__(self, page_content=None, metadata=None):
                self.page_content = page_content
                self.metadata = metadata

        m.Doc = _Doc
        m.DocMetadata = _DocMetadata
        sys.modules['ai.common.schema'] = m


def _load_real_iglobal_module():
    """Load the real ``IGlobal`` module under a unique name (deps stubbed)."""
    _install_stubs()
    spec = importlib.util.spec_from_file_location('tfs_iglobal_real', str(_NODE_DIR / 'IGlobal.py'))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _load_real_iglobal():
    """The real ``IGlobal`` class."""
    return _load_real_iglobal_module().IGlobal


class TestSinkConfig:
    def test_defaults_when_missing(self):
        mod = _load_real_iglobal_module()
        assert mod.IGlobal._sink_config({}) == ('output/', False, 3600, mod.OnConflict.UNIQUE)

    def test_explicit_values(self):
        mod = _load_real_iglobal_module()
        IG = mod.IGlobal
        assert IG._sink_config({'targetDir': 'out2/', 'emitUrl': True, 'urlExpiresIn': 120, 'onConflict': 'skip'}) == (
            'out2/',
            True,
            120,
            mod.OnConflict.SKIP,
        )

    def test_conflict_policy_defaults_to_the_non_destructive_choice(self):
        """A mistyped or missing policy degrades to `unique`, never to overwriting."""
        mod = _load_real_iglobal_module()
        IG = mod.IGlobal
        assert IG._sink_config({})[3] is mod.OnConflict.UNIQUE
        assert IG._sink_config({'onConflict': 'nonsense'})[3] is mod.OnConflict.UNIQUE
        assert IG._sink_config({'onConflict': None})[3] is mod.OnConflict.UNIQUE
        assert IG._sink_config({'onConflict': '  skip  '})[3] is mod.OnConflict.SKIP
        assert IG._sink_config({'onConflict': 'OVERWRITE'})[3] is mod.OnConflict.OVERWRITE

    def test_overwriting_is_never_reached_by_accident(self):
        """The destructive outcome has to be named exactly; nothing else degrades into it."""
        mod = _load_real_iglobal_module()
        IG = mod.IGlobal
        for junk in ({}, {'onConflict': ''}, {'onConflict': 'true'}, {'onConflict': True}):
            assert IG._sink_config(junk)[3] is mod.OnConflict.UNIQUE

    def test_members_cover_exactly_the_services_json_enum(self):
        """Member names are what resolves the dropdown value, so a new choice needs a member."""
        mod = _load_real_iglobal_module()
        fields = _load_services('services.store.json')['fields']
        choices = [c[0] for c in fields['filesystem.onConflict']['enum']]
        assert sorted(m.name.lower() for m in mod.OnConflict) == sorted(choices)

    def test_url_expires_clamped_to_ceiling(self):
        mod = _load_real_iglobal_module()
        IG = mod.IGlobal
        assert IG._sink_config({'urlExpiresIn': 999999})[2] == 3600

    def test_url_expires_non_positive_falls_back_to_default(self):
        mod = _load_real_iglobal_module()
        IG = mod.IGlobal
        assert IG._sink_config({'urlExpiresIn': -5})[2] == 3600
        assert IG._sink_config({'urlExpiresIn': 0})[2] == 3600

    def test_url_expires_non_numeric_falls_back_to_default(self):
        # A bad config value must not raise out of beginGlobal.
        mod = _load_real_iglobal_module()
        IG = mod.IGlobal
        assert IG._sink_config({'urlExpiresIn': 'not-a-number'})[2] == 3600


# ---------------------------------------------------------------------------
# IInstance sink harness (shared by test_sink_lanes.py)
# ---------------------------------------------------------------------------


def _install_iinstance_stubs():
    """Stubs for importing the real IInstance: engine/ai stubs + a stub
    ``tool_filesystem`` package whose ``__path__`` points at the node dir.
    """
    _install_stubs()
    if 'tool_filesystem' not in sys.modules:
        pkg = types.ModuleType('tool_filesystem')
        pkg.__path__ = [str(_NODE_DIR)]
        sys.modules['tool_filesystem'] = pkg
    if 'tool_filesystem.IGlobal' not in sys.modules:
        ig = types.ModuleType('tool_filesystem.IGlobal')

        class _IGlobalStub:
            file_store = None
            allow_write = True
            path_patterns = None
            target_dir = 'output/'
            emit_url = False
            url_expires_in = 3600

        ig.IGlobal = _IGlobalStub
        sys.modules['tool_filesystem.IGlobal'] = ig

    # Set unconditionally: test_read_size_cap installs its own stub over the same key, so a
    # conditional patch would depend on which module ran first.
    stub_module = sys.modules['tool_filesystem.IGlobal']
    stub_module.OnConflict = _load_real_iglobal_module().OnConflict
    stub_module.IGlobal.on_conflict = stub_module.OnConflict.UNIQUE


def _fs(exists_paths=()):
    """AsyncMock FileStore covering the one-shot write API and the streaming
    write API. ``stat`` reports the paths in ``exists_paths`` as existing so
    collision handling can be exercised; streamed chunks are recorded per handle
    so lane tests can assert the bytes and final path.
    """
    fs = AsyncMock()
    fs.write = AsyncMock(return_value=None)
    fs.get_url = AsyncMock(return_value='https://x/task/fetch?token=t')
    fs.delete = AsyncMock(return_value=None)

    async def _stat(path):
        # Shaped like the real FileStore.stat, which reports `type` alongside `exists` —
        # the conflict policy distinguishes a file from a directory sharing the name.
        if path in exists_paths:
            return {'exists': True, 'type': 'file', 'size': 1, 'modified': 0}
        return {'exists': False}

    fs.stat = AsyncMock(side_effect=_stat)

    fs.streams = {}
    counter = {'n': 0}

    async def _open_write(path):
        counter['n'] += 1
        handle = f'h{counter["n"]}'
        fs.streams[handle] = {'path': path, 'chunks': []}
        return handle

    async def _write_chunk(handle, data):
        fs.streams[handle]['chunks'].append(bytes(data))
        return len(data)

    async def _close_write(handle):
        return None

    fs.open_write = AsyncMock(side_effect=_open_write)
    fs.write_chunk = AsyncMock(side_effect=_write_chunk)
    fs.close_write = AsyncMock(side_effect=_close_write)
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
    listeners=('json',),
    on_conflict='unique',
):
    """Build an IInstance wired to a stub IGlobal + mocked engine ``instance``."""
    _install_iinstance_stubs()
    from tool_filesystem.IGlobal import IGlobal, OnConflict
    from tool_filesystem.IInstance import IInstance

    inst = IInstance()
    g = IGlobal()
    g.file_store = file_store
    g.allow_write = allow_write
    g.path_patterns = path_patterns
    g.target_dir = target_dir
    g.emit_url = emit_url
    g.url_expires_in = url_expires_in
    g.on_conflict = OnConflict[on_conflict.upper()]
    inst.IGlobal = g
    inst.instance = MagicMock()
    inst.instance.getListeners.return_value = list(listeners)
    # NB: ``name`` is a reserved MagicMock constructor kwarg, so assign after.
    current = MagicMock(hasName=has_name, objectId=object_id)
    current.name = name
    # Concrete values for the fields the REAL pydantic DocMetadata pulls from
    # the instance context (under ``./builder nodes:test`` the real
    # ``ai.common.schema`` is importable and the stub steps aside).
    current.path = name if has_name else str(object_id)
    current.permissionId = 1
    current.componentId = 'comp-test'
    inst.instance.currentObject = current
    inst.IEndpoint = MagicMock()
    inst.IEndpoint.endpoint.jobConfig = {'nodeId': 'test-node'}
    # Pin the sentinel at instance level: the real base's preventDefault raises
    # the engine control-flow exception, the stub returns the sentinel — tests
    # must behave identically regardless of which base class won the import.
    inst.preventDefault = lambda: 'PREVENT_DEFAULT'
    return inst


# ---------------------------------------------------------------------------
# Naming / path helpers
# ---------------------------------------------------------------------------


class TestNamingHelpers:
    def test_base_name_from_object_name(self):
        inst = _sink_instance(_fs(), name='report.pdf')
        assert inst._sink_base_name() == 'report'
        assert inst._sink_source_ext() == '.pdf'

    def test_base_name_falls_back_to_object_id(self):
        inst = _sink_instance(_fs(), has_name=False, object_id='obj-9')
        assert inst._sink_base_name() == 'obj-9'
        assert inst._sink_source_ext() == ''

    def test_target_path_keeps_clean_name_when_free(self):
        inst = _sink_instance(_fs(), object_id='obj-123')
        assert inst._sink_target_path('report.pdf') == 'output/report.pdf'

    def test_target_path_index_disambiguates(self):
        inst = _sink_instance(_fs(), object_id='obj-123')
        assert inst._sink_target_path('report.md', index=2) == 'output/report_2.md'

    def test_target_path_suffixes_on_collision(self):
        fs = _fs(exists_paths={'output/report.pdf', 'output/report_1.pdf'})
        inst = _sink_instance(fs, object_id='obj-123')
        assert inst._sink_target_path('report.pdf') == 'output/report_2.pdf'

    def test_target_path_raises_past_the_cap(self):
        from tool_filesystem.IInstance import MAX_COLLISION_SUFFIX

        # Every candidate is taken, so the probe must give up rather than spin.
        taken = {'output/report.pdf'} | {f'output/report_{n}.pdf' for n in range(1, MAX_COLLISION_SUFFIX + 1)}
        inst = _sink_instance(_fs(exists_paths=taken), object_id='obj-123')
        with pytest.raises(ValueError, match='could not find a free path'):
            inst._sink_target_path('report.pdf')

    def test_whitelist_rejects_before_probing_the_store(self):
        import re

        fs = _fs()
        inst = _sink_instance(fs, path_patterns=[re.compile(r'^output/allowed')])
        with pytest.raises(ValueError, match='does not match any allowed path pattern'):
            inst._sink_target_path('secret.pdf')
        fs.stat.assert_not_awaited()  # no existence oracle for rejected paths

    def test_target_path_honours_target_dir(self):
        inst = _sink_instance(_fs(), object_id='o1', target_dir='exports')
        assert inst._sink_target_path('a.txt') == 'exports/a.txt'


class TestMimeExtension:
    def test_common_types(self):
        from tool_filesystem.IInstance import _ext_from_mime

        assert _ext_from_mime('image/png') == '.png'
        assert _ext_from_mime('image/jpeg') == '.jpg'

    def test_compound_subtype_is_stripped(self):
        from tool_filesystem.IInstance import _ext_from_mime

        # The old naive split produced '.svg+xml'; overrides/strip fix it.
        assert _ext_from_mime('image/svg+xml') == '.svg'

    def test_override_types(self):
        from tool_filesystem.IInstance import _ext_from_mime

        assert _ext_from_mime('audio/wav') == '.wav'
        assert _ext_from_mime('application/vnd.openxmlformats-officedocument.wordprocessingml.document') == '.docx'

    def test_params_and_case_ignored(self):
        from tool_filesystem.IInstance import _ext_from_mime

        assert _ext_from_mime('IMAGE/PNG; charset=binary') == '.png'

    def test_empty_and_unknown(self):
        from tool_filesystem.IInstance import _ext_from_mime

        assert _ext_from_mime(None) == ''
        assert _ext_from_mime('') == ''

    def test_unmapped_vendor_subtype_is_rejected(self):
        from tool_filesystem.IInstance import _ext_from_mime

        # No override and unknown to mimetypes: report unknown ('') so callers
        # fall back to the source ext / '.bin', not a junk '.acme.report'.
        assert _ext_from_mime('application/vnd.acme.report') == ''

    def test_media_ext_prefers_mime_then_source_then_bin(self):
        inst = _sink_instance(_fs(), name='clip.mov')
        assert inst._media_ext('image/png') == '.png'  # mime wins
        inst2 = _sink_instance(_fs(), name='clip.mov')
        assert inst2._media_ext(None) == '.mov'  # falls back to source ext
        inst3 = _sink_instance(_fs(), has_name=False, object_id='m1')
        assert inst3._media_ext(None) == '.bin'  # last resort


# ---------------------------------------------------------------------------
# One-shot write path (_sink_write)
# ---------------------------------------------------------------------------


class TestSinkWrite:
    def test_writes_data_to_object_scoped_path(self):
        fs = _fs()
        inst = _sink_instance(fs, name='report.pdf', object_id='obj-123')
        ref = inst._sink_write(b'data', 'report.pdf')
        assert ref['storePath'] == 'output/report.pdf'
        (path_arg, data_arg), _ = fs.write.await_args
        assert path_arg == 'output/report.pdf' and data_arg == b'data'

    def test_emit_url_attaches_signed_url(self):
        fs = _fs()
        inst = _sink_instance(fs, emit_url=True, url_expires_in=120)
        ref = inst._sink_write(b'd', 'report.pdf')
        assert ref['url'] == 'https://x/task/fetch?token=t'
        _, kwargs = fs.get_url.await_args
        assert kwargs.get('expires_in') == 120

    def test_no_url_when_emit_disabled(self):
        fs = _fs()
        inst = _sink_instance(fs, emit_url=False)
        ref = inst._sink_write(b'd', 'report.pdf')
        assert ref['url'] is None
        fs.get_url.assert_not_awaited()

    def test_allow_write_gate(self):
        fs = _fs()
        inst = _sink_instance(fs, allow_write=False)
        with pytest.raises(ValueError, match='write access is not enabled'):
            inst._sink_write(b'd', 'report.pdf')
        fs.write.assert_not_awaited()

    def test_path_whitelist_enforced_before_write(self):
        import re

        fs = _fs()
        inst = _sink_instance(fs, name='secret.pdf', path_patterns=[re.compile(r'^output/allowed')])
        with pytest.raises(ValueError, match='does not match any allowed path pattern'):
            inst._sink_write(b'd', 'secret.pdf')
        fs.write.assert_not_awaited()


# ---------------------------------------------------------------------------
# Per-stream naming from the BEGIN descriptor
# ---------------------------------------------------------------------------


class _Descriptor:
    """Stand-in for a parsed stream descriptor carrying only a name."""

    def __init__(self, name):
        self.metadata = types.SimpleNamespace(name=name)


class TestStreamFilename:
    """A stream's own name wins over the source object's, so fan-out stays distinguishable."""

    def test_descriptor_name_is_preferred(self):
        inst = _sink_instance(_fs(), name='1.jpg')
        assert inst._stream_filename(_Descriptor('1.crop0.jpg'), 'image/jpeg') == '1.crop0.jpg'

    def test_falls_back_to_the_object_name(self):
        """No descriptor, or no name on it, keeps the previous behaviour."""
        inst = _sink_instance(_fs(), name='report.pdf')
        assert inst._stream_filename(None, 'image/jpeg') == 'report.jpg'
        assert inst._stream_filename(_Descriptor(None), 'image/jpeg') == 'report.jpg'

    def test_extension_appended_when_the_name_has_none(self):
        """
        A producer names a stream without necessarily giving it an extension.

        os.path.splitext cannot answer this: it splits at the last dot, so `1.crop0` looks
        like stem `1` with extension `.crop0` and the file would be stored with nothing
        identifying its type. The stream's mime decides instead.
        """
        inst = _sink_instance(_fs(), name='1.jpg')
        assert inst._stream_filename(_Descriptor('1.crop0'), 'image/jpeg') == '1.crop0.jpg'

    def test_extension_is_not_doubled(self):
        """A name that already ends in the stream's extension is left alone."""
        inst = _sink_instance(_fs(), name='1.jpg')
        assert inst._stream_filename(_Descriptor('1.crop0.jpg'), 'image/jpeg') == '1.crop0.jpg'
        assert inst._stream_filename(_Descriptor('1.crop0.JPG'), 'image/jpeg') == '1.crop0.JPG'

    def test_path_separators_are_stripped(self):
        """
        The name is untrusted: it comes from whatever node is upstream.

        Backslashes are checked explicitly because os.path.basename on a POSIX host leaves
        a Windows-style traversal completely untouched. The stored name also picks up the
        stream's real extension, so a payload cannot masquerade as another type.
        """
        inst = _sink_instance(_fs(), name='report.pdf')
        assert inst._stream_filename(_Descriptor('../../secrets/key.pem'), 'image/jpeg') == 'key.pem.jpg'
        assert inst._stream_filename(_Descriptor(r'..\..\secrets\key.pem'), 'image/jpeg') == 'key.pem.jpg'

    def test_name_that_reduces_to_nothing_falls_back(self):
        inst = _sink_instance(_fs(), name='report.pdf')
        assert inst._stream_filename(_Descriptor('../'), 'image/jpeg') == 'report.jpg'


class TestConflictPolicy:
    def test_unique_suffixes_rather_than_replacing(self):
        """The default: never destructive, never silent."""
        fs = _fs(exists_paths={'output/report.pdf'})
        inst = _sink_instance(fs, object_id='obj-123')
        assert inst._sink_target_path('report.pdf') == 'output/report_1.pdf'

    def test_overwrite_returns_the_plain_path(self):
        """Overwriting replaces in place rather than finding a free name."""
        fs = _fs(exists_paths={'output/report.pdf'})
        inst = _sink_instance(fs, object_id='obj-123', on_conflict='overwrite')
        assert inst._sink_target_path('report.pdf') == 'output/report.pdf'

    def test_overwrite_does_not_probe_the_store(self):
        """
        No stat() at all when overwriting.

        Worth asserting rather than assuming: the probe is a network round-trip per stream
        on S3 or Azure, and skipping it is half the point of the setting.
        """
        fs = _fs(exists_paths={'output/report.pdf'})
        inst = _sink_instance(fs, object_id='obj-123', on_conflict='overwrite')
        inst._sink_target_path('report.pdf')
        fs.stat.assert_not_awaited()

    def test_skip_returns_none_when_taken(self):
        """`None` means "leave it alone" — it is a decision, not a failure."""
        fs = _fs(exists_paths={'output/report.pdf'})
        inst = _sink_instance(fs, object_id='obj-123', on_conflict='skip')
        assert inst._sink_target_path('report.pdf') is None

    def test_skip_writes_normally_when_free(self):
        fs = _fs()
        inst = _sink_instance(fs, object_id='obj-123', on_conflict='skip')
        assert inst._sink_target_path('report.pdf') == 'output/report.pdf'

    def test_skipped_write_touches_nothing_and_emits_no_ref(self):
        """A skipped one-shot write must not create a file or claim it did."""
        fs = _fs(exists_paths={'output/report.md'})
        inst = _sink_instance(fs, name='report.pdf', on_conflict='skip')
        assert inst._sink_write(b'data', 'report.md') is None
        fs.write.assert_not_awaited()
        inst._sink_emit([None])
        inst.instance.writeJson.assert_not_called()

    def test_skip_compares_against_a_file_not_a_directory(self):
        """A directory sharing the name is not a file to preserve, so it does not skip."""
        fs = _fs()

        async def _dir_stat(path):
            return {'exists': True, 'type': 'dir'}

        fs.stat.side_effect = _dir_stat
        inst = _sink_instance(fs, object_id='obj-123', on_conflict='skip')
        assert inst._sink_target_path('report.pdf') == 'output/report.pdf'

    def test_skip_treats_a_file_shadowed_by_a_directory_as_present(self):
        """`both` still has a file to leave alone, so it skips."""
        fs = _fs()

        async def _both_stat(path):
            return {'exists': True, 'type': 'both', 'size': 1, 'modified': 0}

        fs.stat.side_effect = _both_stat
        inst = _sink_instance(fs, object_id='obj-123', on_conflict='skip')
        assert inst._sink_target_path('report.pdf') is None
