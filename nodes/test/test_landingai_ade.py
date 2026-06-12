# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Unit tests for the landingai_ade node (no network).

Covers:
  - parser.py: ADE SDK call + ParseResponse -> (text, tables) shaping, the
    credential resolution (config / env / defaults) and magic-byte file typing.
  - IInstance.py: tag-lane streaming (SBGN/SDAT/SEND) -> text/table lanes, the
    close() fallback, and listener gating.

Everything runs against a stubbed `landingai-ade` SDK so nothing touches the
network or needs the engine runtime.
"""

from __future__ import annotations

import importlib.util
import sys
import types
from pathlib import Path
from types import SimpleNamespace

import pytest

# ---------------------------------------------------------------------------
# Log capture
# ---------------------------------------------------------------------------
_DEBUG_CALLS: list[str] = []
_WARNING_CALLS: list[str] = []


def _reset_logs() -> None:
    _DEBUG_CALLS.clear()
    _WARNING_CALLS.clear()


def _capture_debug(*args: object, **_k: object) -> None:
    _DEBUG_CALLS.append(' '.join(str(a) for a in args))


def _capture_warning(*args: object, **_k: object) -> None:
    _WARNING_CALLS.append(' '.join(str(a) for a in args))


# ---------------------------------------------------------------------------
# Fake landingai-ade SDK
# ---------------------------------------------------------------------------
class _FakeChunk:
    def __init__(self, type: str = 'text', markdown: str = '', id: str = 'c0'):
        self.type = type
        self.markdown = markdown
        self.id = id
        self.grounding = None


class _FakeParseResponse:
    def __init__(self, markdown: str = '', chunks=None):
        self.markdown = markdown
        self.chunks = chunks if chunks is not None else []
        self.metadata = None
        self.splits = []
        self.grounding = None


# Captures how the SDK was constructed / called, and what it should return/raise.
_SDK = SimpleNamespace(constructed=[], calls=[], response=None, side_effect=None)


def _reset_sdk() -> None:
    _SDK.constructed = []
    _SDK.calls = []
    _SDK.response = None
    _SDK.side_effect = None


class _FakeLandingAIADE:
    def __init__(self, *, apikey=None, environment=None, **kwargs):
        _SDK.constructed.append({'apikey': apikey, 'environment': environment, 'kwargs': kwargs})

    def parse(self, *, document=None, model=None, **kwargs):
        _SDK.calls.append({'document': document, 'model': model, 'kwargs': kwargs})
        if _SDK.side_effect is not None:
            raise _SDK.side_effect
        return _SDK.response if _SDK.response is not None else _FakeParseResponse()


def _install_sdk_stub() -> None:
    """Install the fake SDK and keep it resident.

    parser.parse() imports `landingai_ade` lazily at call time, so the stub must
    stay in sys.modules for the whole session. It is node-specific and shadows
    nothing else.
    """
    mod = types.ModuleType('landingai_ade')
    mod.LandingAIADE = _FakeLandingAIADE

    class APIError(Exception):
        pass

    mod.APIError = APIError
    sys.modules['landingai_ade'] = mod


# ---------------------------------------------------------------------------
# Stub Config (per-test config dict)
# ---------------------------------------------------------------------------
class _StubConfig:
    @staticmethod
    def getNodeConfig(provider, connConfig):
        return {}


def _build_shared_stubs() -> dict:
    rocketlib = types.ModuleType('rocketlib')
    rocketlib.IInstanceBase = object
    rocketlib.IGlobalBase = object
    rocketlib.Entry = object
    rocketlib.debug = _capture_debug
    rocketlib.warning = _capture_warning
    rocketlib.error = lambda *_a, **_k: None
    rocketlib.OPEN_MODE = SimpleNamespace(CONFIG='config')

    ai = types.ModuleType('ai')
    ai.__path__ = []
    ai_common = types.ModuleType('ai.common')
    ai_common.__path__ = []

    ai_reader = types.ModuleType('ai.common.reader')

    class ReaderBase:
        def __init__(self, *_a, **_k):
            pass

    ai_reader.ReaderBase = ReaderBase

    ai_config = types.ModuleType('ai.common.config')
    ai_config.Config = _StubConfig

    return {
        'rocketlib': rocketlib,
        'ai': ai,
        'ai.common': ai_common,
        'ai.common.reader': ai_reader,
        'ai.common.config': ai_config,
    }


# ---------------------------------------------------------------------------
# Load the modules under test (install-then-pop shared stubs; rebind globals).
# ---------------------------------------------------------------------------
_NODE_DIR = Path(__file__).resolve().parent.parent / 'src' / 'nodes' / 'landingai_ade'


def _load_module(filename: str, mod_name: str):
    added: list[str] = []
    for name, stub in _build_shared_stubs().items():
        if name not in sys.modules:
            sys.modules[name] = stub
            added.append(name)
    try:
        spec = importlib.util.spec_from_file_location(mod_name, _NODE_DIR / filename)
        assert spec is not None and spec.loader is not None
        mod = importlib.util.module_from_spec(spec)
        sys.modules[mod_name] = mod
        spec.loader.exec_module(mod)
    finally:
        for name in added:
            sys.modules.pop(name, None)
        sys.modules.pop(mod_name, None)

    # Rebind module globals to our capture stubs so assertions hold even under the
    # full runner, where real rocketlib/ai modules exist and our stubs above were
    # therefore skipped (binding happens at import time).
    mod.debug = _capture_debug
    if hasattr(mod, 'warning'):
        mod.warning = _capture_warning
    if hasattr(mod, 'Config'):
        mod.Config = _StubConfig
    return mod


_install_sdk_stub()
_parser_mod = _load_module('parser.py', '_landingai_ade_parser_uut')
_iinstance_mod = _load_module('IInstance.py', '_landingai_ade_iinstance_uut')

Parser = _parser_mod.Parser
IInstance = _iinstance_mod.IInstance


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _make_parser(api_key='test-key', model='dpt-2-latest', region='production') -> Parser:
    p = Parser.__new__(Parser)
    p._api_key = api_key
    p._model = model
    p._region = region
    p.bag = {}
    return p


class _FakeInstance:
    def __init__(self, listeners=('text', 'table')):
        self._listeners = set(listeners)
        self.texts: list[str] = []
        self.tables: list[str] = []

    def hasListener(self, lane: str) -> bool:
        return lane in self._listeners

    def writeText(self, text: str) -> None:
        self.texts.append(text)

    def writeTable(self, table: str) -> None:
        self.tables.append(table)


class _FakeParserForInstance:
    def __init__(self, text='', tables=None, error=None):
        self.text = text
        self.tables = tables or []
        self.error = error
        self.calls: list[dict] = []

    def parse(self, document_data, file_name=None):
        self.calls.append({'data': document_data, 'file_name': file_name})
        if self.error is not None:
            raise self.error
        return self.text, self.tables


def _make_iinstance(parser=None, listeners=('text', 'table'), file_name='doc.pdf') -> IInstance:
    inst = IInstance.__new__(IInstance)
    inst.current_object = SimpleNamespace(fileName=file_name, objectFailed=False)
    inst.current_metadata = None
    inst.current_text = ''
    inst.document_data = b''
    inst.IGlobal = SimpleNamespace(parser=parser if parser is not None else _FakeParserForInstance())
    inst.instance = _FakeInstance(listeners)
    return inst


def _tag(suffix: str, *, asBytes=None, size=None, value=None):
    t = SimpleNamespace()
    t.tagId = 'XX' + suffix
    if asBytes is not None:
        t.asBytes = asBytes
    if size is not None:
        t.size = size
    if value is not None:
        t.value = value
    return t


def _sdat(data: bytes, header: bytes = b'HEADER__'):
    # IInstance derives header_size = len(asBytes) - size, then data = asBytes[header_size:]
    return _tag('SDAT', asBytes=header + data, size=len(data))


# =============================================================================
# (a) Parser._resolve_credentials
# =============================================================================
class TestResolveCredentials:
    def test_config_api_key_used(self):
        key, model, region = Parser._resolve_credentials({'api_key': 'cfg-key'})
        assert key == 'cfg-key'
        assert model == 'dpt-2-latest'
        assert region == 'production'

    def test_env_fallback_when_blank(self, monkeypatch):
        monkeypatch.setenv('VISION_AGENT_API_KEY', 'env-key')
        key, _, _ = Parser._resolve_credentials({'api_key': ''})
        assert key == 'env-key'

    def test_env_fallback_when_whitespace(self, monkeypatch):
        monkeypatch.setenv('VISION_AGENT_API_KEY', 'env-key')
        key, _, _ = Parser._resolve_credentials({'api_key': '   '})
        assert key == 'env-key'

    def test_config_key_wins_over_env(self, monkeypatch):
        monkeypatch.setenv('VISION_AGENT_API_KEY', 'env-key')
        key, _, _ = Parser._resolve_credentials({'api_key': 'cfg-key'})
        assert key == 'cfg-key'

    def test_no_key_anywhere_is_none(self, monkeypatch):
        monkeypatch.delenv('VISION_AGENT_API_KEY', raising=False)
        key, _, _ = Parser._resolve_credentials({})
        assert key is None

    def test_model_and_region_defaults(self, monkeypatch):
        monkeypatch.delenv('VISION_AGENT_API_KEY', raising=False)
        _, model, region = Parser._resolve_credentials({})
        assert model == 'dpt-2-latest'
        assert region == 'production'

    def test_eu_region_preserved(self):
        _, _, region = Parser._resolve_credentials({'api_key': 'k', 'region': 'eu'})
        assert region == 'eu'

    def test_unknown_region_clamped_to_production(self):
        _, _, region = Parser._resolve_credentials({'api_key': 'k', 'region': 'mars'})
        assert region == 'production'

    def test_custom_model_preserved(self):
        _, model, _ = Parser._resolve_credentials({'api_key': 'k', 'model': 'dpt-9'})
        assert model == 'dpt-9'


# =============================================================================
# (b) Parser._detect_file_type_from_bytes
# =============================================================================
class TestDetectFileType:
    def setup_method(self):
        self.p = _make_parser()

    def test_pdf(self):
        assert self.p._detect_file_type_from_bytes(b'%PDF-1.7\n...').endswith('.pdf')

    def test_png(self):
        assert self.p._detect_file_type_from_bytes(b'\x89PNG\r\n\x1a\n....').endswith('.png')

    def test_jpeg(self):
        assert self.p._detect_file_type_from_bytes(b'\xff\xd8\xff\xe0....').endswith('.jpg')

    def test_zip_docx(self):
        assert self.p._detect_file_type_from_bytes(b'\x50\x4b\x03\x04....').endswith('.docx')

    def test_ole_doc(self):
        assert self.p._detect_file_type_from_bytes(b'\xd0\xcf\x11\xe0....').endswith('.doc')

    def test_gif(self):
        assert self.p._detect_file_type_from_bytes(b'GIF89a....').endswith('.gif')

    def test_webp(self):
        assert self.p._detect_file_type_from_bytes(b'RIFF\x00\x00\x00\x00WEBP').endswith('.webp')

    def test_tiff(self):
        assert self.p._detect_file_type_from_bytes(b'II*\x00....').endswith('.tiff')

    def test_unknown_defaults_to_pdf(self):
        assert self.p._detect_file_type_from_bytes(b'not a known signature').endswith('.pdf')

    def test_empty_defaults_to_pdf(self):
        assert self.p._detect_file_type_from_bytes(b'').endswith('.pdf')


# =============================================================================
# (c) Parser.parse
# =============================================================================
class TestParse:
    def setup_method(self):
        _reset_sdk()
        _reset_logs()

    def test_no_api_key_returns_empty_and_no_call(self):
        p = _make_parser(api_key=None)
        assert p.parse(b'%PDF-data', 'a.pdf') == ('', [])
        assert _SDK.calls == []
        assert _SDK.constructed == []

    def test_empty_bytes_returns_empty_and_no_call(self):
        p = _make_parser()
        assert p.parse(b'', 'a.pdf') == ('', [])
        assert _SDK.calls == []

    def test_happy_path_returns_markdown_and_tables(self):
        _SDK.response = _FakeParseResponse(
            markdown='# Title\n\nbody',
            chunks=[
                _FakeChunk(type='text', markdown='body'),
                _FakeChunk(type='table', markdown='| a | b |\n|---|---|\n| 1 | 2 |'),
            ],
        )
        text, tables = _make_parser().parse(b'%PDF-data', 'a.pdf')
        assert text == '# Title\n\nbody'
        assert tables == ['| a | b |\n|---|---|\n| 1 | 2 |']

    def test_only_table_chunks_become_tables(self):
        _SDK.response = _FakeParseResponse(
            markdown='doc',
            chunks=[
                _FakeChunk(type='text', markdown='ignored'),
                _FakeChunk(type='figure', markdown='ignored too'),
                _FakeChunk(type='table', markdown='T1'),
                _FakeChunk(type='table', markdown='T2'),
            ],
        )
        _text, tables = _make_parser().parse(b'%PDF', 'a.pdf')
        assert tables == ['T1', 'T2']

    def test_table_type_is_case_insensitive(self):
        _SDK.response = _FakeParseResponse(markdown='d', chunks=[_FakeChunk(type='TABLE', markdown='T')])
        _text, tables = _make_parser().parse(b'%PDF', 'a.pdf')
        assert tables == ['T']

    def test_empty_table_chunk_skipped(self):
        _SDK.response = _FakeParseResponse(
            markdown='d',
            chunks=[_FakeChunk(type='table', markdown='   '), _FakeChunk(type='table', markdown='real')],
        )
        _text, tables = _make_parser().parse(b'%PDF', 'a.pdf')
        assert tables == ['real']

    def test_passes_document_tuple_and_model(self):
        _make_parser(model='dpt-2-latest').parse(b'%PDF-bytes', 'report.pdf')
        call = _SDK.calls[0]
        assert call['document'] == ('report.pdf', b'%PDF-bytes')
        assert call['model'] == 'dpt-2-latest'

    def test_constructs_client_with_apikey_and_region(self):
        _make_parser(api_key='secret-key', region='eu').parse(b'%PDF', 'a.pdf')
        built = _SDK.constructed[0]
        assert built['apikey'] == 'secret-key'
        assert built['environment'] == 'eu'

    def test_detects_filename_when_missing(self):
        _make_parser().parse(b'%PDF-1.4 data', None)
        assert _SDK.calls[0]['document'][0].endswith('.pdf')

    def test_uses_provided_filename(self):
        _make_parser().parse(b'%PDF', 'custom-name.pdf')
        assert _SDK.calls[0]['document'][0] == 'custom-name.pdf'

    def test_sdk_exception_returns_empty(self):
        _SDK.side_effect = RuntimeError('ade boom')
        assert _make_parser().parse(b'%PDF', 'a.pdf') == ('', [])

    def test_api_key_never_logged(self):
        _SDK.response = _FakeParseResponse(markdown='ok')
        _make_parser(api_key='SUPER-SECRET-KEY').parse(b'%PDF', 'a.pdf')
        assert all('SUPER-SECRET-KEY' not in line for line in _DEBUG_CALLS)


# =============================================================================
# (d) Parser.extract_content / read
# =============================================================================
class TestExtractContentAndRead:
    def test_no_chunks_returns_text_and_empty_tables(self):
        resp = _FakeParseResponse(markdown='just text', chunks=[])
        text, tables = _make_parser().extract_content(resp)
        assert text == 'just text'
        assert tables == []

    def test_missing_markdown_attr_yields_empty_text(self):
        resp = SimpleNamespace(chunks=[])  # no .markdown attribute
        text, tables = _make_parser().extract_content(resp)
        assert text == ''
        assert tables == []

    def test_none_markdown_coerced_to_empty(self):
        resp = _FakeParseResponse(markdown=None, chunks=[])
        text, _tables = _make_parser().extract_content(resp)
        assert text == ''

    def test_read_returns_text_only(self):
        _reset_sdk()
        _SDK.response = _FakeParseResponse(markdown='hello', chunks=[_FakeChunk(type='table', markdown='T')])
        assert _make_parser().read(b'%PDF') == 'hello'


# =============================================================================
# (e) IInstance — tag-lane streaming
# =============================================================================
class TestIInstanceFlow:
    def setup_method(self):
        _reset_logs()

    def test_open_resets_state(self):
        inst = _make_iinstance()
        inst.document_data = b'leftover'
        inst.open(SimpleNamespace(fileName='new.pdf', objectFailed=False))
        assert inst.document_data == b''
        assert inst.current_text == ''
        assert inst.current_metadata is None

    def test_full_stream_parses_and_writes(self):
        parser = _FakeParserForInstance(text='parsed text', tables=['T1', 'T2'])
        inst = _make_iinstance(parser=parser)
        inst.writeTag(_tag('SBGN'))
        inst.writeTag(_sdat(b'%PDF-'))
        inst.writeTag(_sdat(b'rest'))
        inst.writeTag(_tag('SEND'))
        # Parser saw the reassembled bytes once.
        assert len(parser.calls) == 1
        assert parser.calls[0]['data'] == b'%PDF-rest'
        assert parser.calls[0]['file_name'] == 'doc.pdf'
        # Lanes received the outputs.
        assert inst.instance.texts == ['parsed text']
        assert inst.instance.tables == ['T1', 'T2']

    def test_sbgn_resets_buffer(self):
        inst = _make_iinstance()
        inst.document_data = b'stale'
        inst.writeTag(_tag('SBGN'))
        assert inst.document_data == b''

    def test_writes_text_only_when_text_listener(self):
        parser = _FakeParserForInstance(text='T', tables=['tab'])
        inst = _make_iinstance(parser=parser, listeners=('table',))  # no text listener
        inst.writeTag(_tag('SBGN'))
        inst.writeTag(_sdat(b'data'))
        inst.writeTag(_tag('SEND'))
        assert inst.instance.texts == []
        assert inst.instance.tables == ['tab']

    def test_writes_tables_only_when_table_listener(self):
        parser = _FakeParserForInstance(text='T', tables=['tab'])
        inst = _make_iinstance(parser=parser, listeners=('text',))  # no table listener
        inst.writeTag(_tag('SBGN'))
        inst.writeTag(_sdat(b'data'))
        inst.writeTag(_tag('SEND'))
        assert inst.instance.texts == ['T']
        assert inst.instance.tables == []

    def test_send_with_no_data_does_not_call_parser(self):
        parser = _FakeParserForInstance()
        inst = _make_iinstance(parser=parser)
        inst.writeTag(_tag('SBGN'))
        inst.writeTag(_tag('SEND'))
        assert parser.calls == []

    def test_empty_text_not_written(self):
        parser = _FakeParserForInstance(text='', tables=[])
        inst = _make_iinstance(parser=parser)
        inst.writeTag(_tag('SBGN'))
        inst.writeTag(_sdat(b'data'))
        inst.writeTag(_tag('SEND'))
        assert inst.instance.texts == []

    def test_close_processes_unflushed_buffer(self):
        parser = _FakeParserForInstance(text='late', tables=[])
        inst = _make_iinstance(parser=parser)
        inst.writeTag(_tag('SBGN'))
        inst.writeTag(_sdat(b'unflushed'))
        # No SEND — data still buffered. close() should flush it once.
        inst.close()
        assert len(parser.calls) == 1
        assert parser.calls[0]['data'] == b'unflushed'

    def test_close_no_double_process_after_send(self):
        parser = _FakeParserForInstance(text='x', tables=[])
        inst = _make_iinstance(parser=parser)
        inst.writeTag(_tag('SBGN'))
        inst.writeTag(_sdat(b'data'))
        inst.writeTag(_tag('SEND'))
        inst.close()
        assert len(parser.calls) == 1  # not reprocessed by close()

    def test_input_bytes_passed_through_unmutated(self):
        parser = _FakeParserForInstance(text='x')
        inst = _make_iinstance(parser=parser)
        original = b'%PDF-immutable'
        inst.writeTag(_tag('SBGN'))
        inst.writeTag(_sdat(original))
        inst.writeTag(_tag('SEND'))
        assert parser.calls[0]['data'] == original

    def test_omet_metadata_parsed(self):
        inst = _make_iinstance()
        inst.writeTag(_tag('OMET', value=b'{"Content-Type": "application/pdf"}'))
        assert inst.current_metadata == {'Content-Type': 'application/pdf'}

    def test_bad_omet_metadata_is_tolerated(self):
        inst = _make_iinstance()
        inst.current_metadata = {'old': 1}
        inst.writeTag(_tag('OMET', value=b'not json{{'))
        assert inst.current_metadata is None

    def test_unknown_tag_ignored(self):
        parser = _FakeParserForInstance()
        inst = _make_iinstance(parser=parser)
        inst.writeTag(_tag('ZZZZ'))
        assert parser.calls == []


if __name__ == '__main__':
    sys.exit(pytest.main([__file__, '-v']))
