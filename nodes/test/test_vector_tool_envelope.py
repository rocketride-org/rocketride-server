# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""The envelope every vector store tool answers in, and what agents see.

* ``vectordb_tool`` turns every outcome into ``{success, ...}`` or
  ``{success: false, code, error}``: ``StoreUnsupported`` -> ``UNSUPPORTED``,
  ``ToolRefusal`` -> its code, any other ``BaseException`` -> ``STORE_ERROR``;
  ``KeyboardInterrupt``/``SystemExit`` still propagate. Nothing else escapes.
* Answers are JSON: numpy becomes lists and numbers, NaN/inf become null, and an
  answer over the size cap is refused with ``LIMIT_EXCEEDED``.
* Error text never carries a URL, DSN, host, port or credential.
* The explorer tools are listed for external callers only; the six agent tools
  keep their descriptors byte for byte (pinned by a hash of today's catalog).
"""

from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable, Dict, Iterable, List

import numpy as np
import pytest
from rocketlib import IInstanceBase, tool_function

from ai.common.store import VectorStoreToolMixin, vx_tools
from ai.common.store.errors import StoreError, StoreUnsupported, ToolRefusal
from ai.common.store.vx_types import TOOL_CODES

from .test_vector_hooks import MemoryStore, corpus

#: sha256 of today's six agent descriptors (search, upsert, delete, objdir, get, stats) as
#: ``_build_tool_descriptors`` builds them, JSON with sorted keys and no spaces. Regenerated
#: for the develop merge of b76848a6f: the six are byte-identical to what develop builds except
#: where develop's text is false on this branch: objdir's ``parent`` (Qdrant matches the exact path,
#: not as a text match) and stats' ``document_count`` (null where the store cannot count, not
#: "does not list documents": every driver lists).
LEGACY_AGENT_CATALOG_SHA256 = '619a07af850b04c5b329f5c70b18828e911a76fab7859e3573fb6d123851e391'

LEGACY_TOOLS = ('delete', 'get', 'objdir', 'search', 'stats', 'upsert')
#: #2704's three, listed for agents too: the document listing and the trash.
TRASH_TOOLS = ('list_documents', 'restore', 'soft_delete')
EXPLORER_TOOLS = (
    'chunks',
    'dialect',
    'neighbors',
    'project',
    'recommend',
    'sample',
    'similarity_matrix',
    'vectors',
)


class _Probe:
    """A host for wrapped methods that raise whatever a test asks for."""

    def __init__(self, outcome: Any) -> None:
        self.outcome = outcome

    @vx_tools.vectordb_tool
    def run(self, args):
        if isinstance(self.outcome, BaseException):
            raise self.outcome
        if callable(self.outcome):
            return self.outcome(args)
        return self.outcome


def _run(outcome: Any, args: Any = None):
    return _Probe(outcome).run(args)


# ---------------------------------------------------------------------------
# The wrapper
# ---------------------------------------------------------------------------


def test_success_answers_pass_through_with_success_first():
    answer = _run({'value': 1, 'success': True})
    assert list(answer) == ['success', 'value'] and answer == {'success': True, 'value': 1}


def test_an_answer_without_success_gains_it():
    assert _run({'results': []}) == {'success': True, 'results': []}


def test_store_unsupported_becomes_unsupported():
    assert _run(StoreUnsupported('getVectors is not supported by this store')) == {
        'success': False,
        'code': 'UNSUPPORTED',
        'error': 'getVectors is not supported by this store',
    }


def test_tool_refusal_becomes_its_code_with_extra_keys():
    answer = _run(ToolRefusal('RATE_LIMITED', 'Too many calls.', {'retry_after_s': 12}))
    assert answer == {'success': False, 'code': 'RATE_LIMITED', 'error': 'Too many calls.', 'retry_after_s': 12}


@pytest.mark.parametrize(
    'exc', [RuntimeError('boom'), StoreError('backend failed'), ValueError('bad'), KeyError('k'), ZeroDivisionError()]
)
def test_other_exceptions_become_store_error(exc):
    answer = _run(exc)
    assert (answer['success'], answer['code']) == (False, 'STORE_ERROR')
    assert answer['error'].startswith(type(exc).__name__)


def test_a_bare_base_exception_never_escapes():
    class DriverAbort(BaseException):
        pass

    answer = _run(DriverAbort('non-zero offset'))
    assert answer == {'success': False, 'code': 'STORE_ERROR', 'error': 'DriverAbort: non-zero offset'}


def test_generator_exit_is_contained_too():
    assert _run(GeneratorExit())['code'] == 'STORE_ERROR'


@pytest.mark.parametrize('exc', [KeyboardInterrupt(), SystemExit(3)])
def test_interrupts_and_exits_propagate(exc):
    with pytest.raises(type(exc)):
        _run(exc)


def test_the_wrapper_normalises_the_input():
    seen = {}

    def capture(args):
        seen.update(args)
        return {'ok': True}

    _run(capture, '{"input": {"a": 1}, "b": 2, "security_context": {"x": 1}}')
    assert seen == {'a': 1, 'b': 2}


def test_the_wrapper_keeps_the_name_and_docstring():
    assert _Probe.run.__name__ == 'run'
    assert getattr(_Probe.run, '__vectordb_tool__', False) is True


# ---------------------------------------------------------------------------
# JSON post-processing
# ---------------------------------------------------------------------------


def test_numpy_values_become_json():
    answer = _run(
        {
            'array': np.array([1.5, 2.5], dtype=np.float32),
            'matrix': np.eye(2, dtype=np.int64),
            'scalar': np.float32(0.25),
            'integer': np.int64(7),
            'flag': np.bool_(True),
            'nested': {'tuple': (1, 2), 'set': {'b', 'a'}},
        }
    )
    assert answer['array'] == [1.5, 2.5] and answer['matrix'] == [[1, 0], [0, 1]]
    assert answer['scalar'] == 0.25 and answer['integer'] == 7 and answer['flag'] is True
    assert type(answer['integer']) is int and type(answer['flag']) is bool
    assert answer['nested'] == {'tuple': [1, 2], 'set': ['a', 'b']}
    json.dumps(answer, allow_nan=False)


def test_non_finite_numbers_become_null():
    answer = _run({'a': math.nan, 'b': [math.inf, -math.inf, 1.0], 'c': np.array([np.nan, 2.0])})
    assert answer == {'success': True, 'a': None, 'b': [None, None, 1.0], 'c': [None, 2.0]}


def test_bytes_never_reach_the_answer():
    assert _run({'blob': b'\x00\x01'})['blob'] is None


def test_an_oversized_answer_is_refused(monkeypatch):
    monkeypatch.setattr(vx_tools, 'MAX_ANSWER_BYTES', 100)
    answer = _run({'items': ['x' * 200]})
    assert (answer['success'], answer['code']) == (False, 'LIMIT_EXCEEDED')


def test_answers_up_to_eight_megabytes_pass_and_larger_ones_are_refused():
    cap = 8 * 1024 * 1024
    overhead = len(json.dumps({'success': True, 'blob': ''}, separators=(',', ':')))
    assert _run({'blob': 'x' * (cap - overhead)})['success'] is True
    answer = _run({'blob': 'x' * (cap - overhead + 1)})
    assert (answer['success'], answer.get('code')) == (False, 'LIMIT_EXCEEDED')


class _Unprintable:
    """A value whose text cannot be built (a driver handle whose repr touches a closed socket)."""

    def __str__(self) -> str:
        raise RuntimeError('the handle is closed')


class _BrokenModel:
    def model_dump(self) -> Dict[str, Any]:
        raise ValueError('model_dump failed')


def _cyclic() -> list:
    items: list = []
    items.append(items)
    return items


@pytest.mark.parametrize(
    'result',
    [
        {'success': True, 'handle': _Unprintable()},
        {'success': True, _Unprintable(): 1},
        {'success': True, 'doc': _BrokenModel()},
        {'success': True, 'x': _cyclic()},
        _Unprintable(),
    ],
    ids=['value', 'key', 'model_dump', 'cycle', 'bare'],
)
def test_an_answer_that_cannot_be_serialised_is_a_store_error(result):
    answer = _run(lambda _args: result)
    assert (answer['success'], answer['code']) == (False, 'STORE_ERROR')
    json.dumps(answer, allow_nan=False)


@pytest.mark.parametrize('exc', [KeyboardInterrupt(), SystemExit(3)])
def test_interrupts_while_serialising_still_propagate(exc, monkeypatch):
    def interrupted(_value):
        raise exc

    monkeypatch.setattr(vx_tools, 'jsonable', interrupted)
    with pytest.raises(type(exc)):
        _run({'value': 1})


# ---------------------------------------------------------------------------
# Error text
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    'message,secrets',
    [
        ('connection to server at "10.0.0.5", port 55432 failed', ['10.0.0.5', '55432']),
        (
            'could not connect to postgresql://rruser:rrpass@db.internal:5432/rrtenant',
            ['rrpass', 'db.internal', 'rrtenant'],
        ),
        (
            'host=db.internal port=5432 dbname=tenant_7 user=admin password=s3cret',
            ['db.internal', 'tenant_7', 's3cret', 'admin'],
        ),
        ('failed to reach http://localhost:6333/collections', ['localhost', '6333']),
        ('could not translate host name "vectors.example.com" to address', ['vectors.example.com']),
        ('apikey=abc123 rejected', ['abc123']),
        ('connect to [::1]:19530 refused', ['::1', '19530']),
        # libpq FATAL lines name the role and the database in double quotes
        (
            'connection to server at "127.0.0.1", port 55432 failed: FATAL:  password authentication failed '
            'for user "rruser"',
            ['127.0.0.1', '55432', 'rruser'],
        ),
        (
            'connection to server at "127.0.0.1", port 55432 failed: FATAL:  database "rrtenant" does not exist',
            ['127.0.0.1', '55432', 'rrtenant'],
        ),
        ('FATAL:  role "rruser" does not exist', ['rruser']),
        ('relation "rrtenant.vx_demo_docs" does not exist', ['rrtenant']),
        ("Access denied for user 'rruser'", ['rruser']),
        ('schema "tenant_7" does not exist', ['tenant_7']),
        # client libraries print bare host:port pairs and DNS names
        ('Could not connect to tenant default_tenant. Are you sure it exists? (vx-chroma:8000)', ['vx-chroma', '8000']),
        (
            'Could not connect to database team_db for tenant team_7. Are you sure it exists?',
            ['team_db', 'team_7'],
        ),
        (
            '<MilvusException: (code=2, message=Fail connecting to server on my-qdrant.example.com:19530)>',
            ['my-qdrant.example.com', '19530'],
        ),
        ('Name or service not known: db.internal', ['db.internal']),
        ('timed out talking to in01-abc.api.gcp-us-west1.zillizcloud.com', ['zillizcloud.com', 'in01-abc']),
        ('index host abc-123.svc.us-east1-gcp.pinecone.io unreachable', ['pinecone.io', 'abc-123']),
        # credentials outside a URL or a key=value pair
        ('Unauthorized: api key rrpass rejected', ['rrpass']),
        ('Authorization: Bearer eyJhbGciOi.payload.sig was refused', ['eyJhbGciOi']),
        ('auth failed for rruser:rrpass@127.0.0.1:55432/rrtenant', ['rruser', 'rrpass', '127.0.0.1', 'rrtenant']),
        ("password='s3cret value' user=admin", ['s3cret', 'admin']),
        ('api_key: sk-live-123 is not valid', ['sk-live-123']),
    ],
)
def test_error_text_is_scrubbed(message, secrets):
    answer = _run(RuntimeError(message))
    for secret in secrets:
        assert secret not in answer['error']


#: The local fixture identities a store error must never carry.
_FIXTURE_SECRETS = ('rruser', 'rrpass', 'rrtenant', '55432', '56434', 'vx-chroma', 'gx-pgvector')


@pytest.mark.parametrize(
    'message',
    [
        'connection to server at "gx-pgvector" (172.18.0.4), port 5432 failed: FATAL:  password authentication '
        'failed for user "rruser"',
        'connection to server at "127.0.0.1", port 56434 failed: FATAL:  database "rrtenant" does not exist',
        'could not connect to server: Connection refused\n\tIs the server running on host "vx-chroma" and accepting '
        'TCP/IP connections on port 8000?',
        "HTTPConnectionPool(host='vx-chroma', port=8000): Max retries exceeded",
        'FATAL:  no pg_hba.conf entry for host "172.18.0.1", user "rruser", database "rrtenant", no encryption',
    ],
)
def test_store_errors_never_carry_the_fixture_identities(message):
    answer = _run(RuntimeError(message))
    assert answer['code'] == 'STORE_ERROR'
    assert not [secret for secret in _FIXTURE_SECRETS if secret in answer['error']], answer['error']


@pytest.mark.parametrize(
    'message',
    [
        'the vector has 3 values',
        'statement timed out at 2026-10-08T18:20:11Z after 30000 ms',
        "No module named 'ai.common.store.pgvector'",
        'error in postgres.py line 12',
        'qdrant_client.http.exceptions.UnexpectedResponse: Unexpected Response: 404 (Not Found)',
        'canceling statement due to statement timeout',
        'cannot execute UPDATE in a read-only transaction',
        'the server-side cursor was closed',
        'Could not connect to a Chroma server. Are you sure it is running?',
    ],
)
def test_ordinary_error_text_survives_the_scrubber(message):
    assert vx_tools.safe_error_text(message) == message


@pytest.mark.parametrize(
    'message,secrets',
    [
        ('Name or service not known: gx-pgvector', ['gx-pgvector']),
        ('nodename nor servname provided, or not known: vx-qdrant', ['vx-qdrant']),
        ('getaddrinfo failed for gx-pgvector', ['gx-pgvector']),
        ('SSL error: certificate verify failed for rrtenant.vx-pgbouncer', ['rrtenant', 'vx-pgbouncer']),
        ('collection vx_demo_docs on server vx-qdrant (grpc 56334) is locked', ['vx-qdrant', '56334']),
        ('could not resolve host vx-chroma', ['vx-chroma']),
        ('token AstraCS:abcdefghijklmnop:0123456789abcdef is invalid', ['AstraCS', 'abcdefghijklmnop', '0123456789']),
        ('x-api-key header value pcsk_1234567890abcdef rejected', ['pcsk_', '1234567890abcdef']),
    ],
)
def test_bare_host_names_and_token_shapes_are_scrubbed(message, secrets):
    out = vx_tools.safe_error_text(message)
    assert not [secret for secret in secrets if secret in out], out


def _rpc_error(number: int) -> BaseException:
    """A gRPC error whose ``code()`` is the ``StatusCode`` numbered ``number``."""
    status = next(code for code in _lib('grpc', 'StatusCode') if code.value[0] == number)

    class _Rpc(_lib('grpc', 'RpcError')):
        def code(self):
            return status

        def __str__(self) -> str:
            return f'<_Rpc {number} ipv4:172.18.0.9:56334 vx-qdrant>'

    return _Rpc()


def _wrapped_refusal() -> BaseException:
    try:
        try:
            raise ConnectionRefusedError(61, 'Connection refused: vx-qdrant')
        except ConnectionRefusedError as inner:
            raise RuntimeError('the store vx-qdrant failed') from inner
    except RuntimeError as outer:
        return outer


def _lib(module: str, name: str) -> Any:
    """A real client-library class; skip the case when the library is absent or shadowed by a mock."""
    import importlib

    try:
        value = getattr(importlib.import_module(module), name)
    except (ImportError, AttributeError):
        value = None
    if not isinstance(value, type):  # absent, a mock package, or a MagicMock left in sys.modules
        pytest.skip(f'NOT RUN: {module}.{name} is not importable here (library absent or mocked)')
    return value


def _httpx_connect(message: str) -> BaseException:
    return _lib('httpx', 'ConnectError')(message)


def _qdrant_response(status: int, content: bytes = b'') -> BaseException:
    headers = _lib('httpx', 'Headers')()
    return _lib('qdrant_client.http.exceptions', 'UnexpectedResponse')(
        status_code=status, reason_phrase='x', content=content, headers=headers
    )


_UNREACHABLE: Dict[str, Callable[[], BaseException]] = {
    'refused': lambda: ConnectionRefusedError(61, 'Connection refused: gx-pgvector'),
    'gaierror': lambda: __import__('socket').gaierror(8, 'nodename nor servname provided, or not known: gx-pgvector'),
    'tls': lambda: __import__('ssl').SSLCertVerificationError('certificate verify failed for rrtenant.vx-pgbouncer'),
    'libpq': lambda: _lib('psycopg2', 'OperationalError')(
        'connection to server at "gx-pgvector" (172.18.0.3), port 5432 failed: FATAL:  password authentication '
        'failed for user "rruser"'
    ),
    'libpq-closed': lambda: _lib('psycopg2', 'InterfaceError')('connection already closed'),
    'httpx': lambda: _httpx_connect('All connection attempts failed: vx-chroma'),
    'requests': lambda: _lib('requests.exceptions', 'ConnectionError')(
        "HTTPConnectionPool(host='vx-chroma', port=8000)"
    ),
    'qdrant-transport': lambda: _lib('qdrant_client.http.exceptions', 'ResponseHandlingException')(
        _httpx_connect('vx-qdrant refused')
    ),
    'qdrant-401': lambda: _qdrant_response(401, b'vx-qdrant'),
    'weaviate': lambda: _lib('weaviate.exceptions', 'WeaviateConnectionError')('Connection failed at vx-weaviate'),
    'weaviate-auth': lambda: _lib('weaviate.exceptions', 'AuthenticationFailedError')('bad key for vx-weaviate'),
    'pinecone-401': lambda: _lib('pinecone.exceptions', 'UnauthorizedException')(
        'Invalid API key pcsk_1234567890abcdef'
    ),
    'milvus-connect': lambda: _lib('pymilvus.exceptions', 'MilvusException')(
        code=2, message='Fail connecting to server on vx-milvus:19530'
    ),
    'mongo-select': lambda: _lib('pymongo.errors', 'ServerSelectionTimeoutError')(
        'vx-mongo:27017: [Errno 61] Connection refused'
    ),
    'mongo-auth': lambda: _lib('pymongo.errors', 'OperationFailure')('Authentication failed for vx-mongo.', code=18),
    'grpc-14-unavailable': lambda: _rpc_error(14),
    'grpc-16-no-credentials': lambda: _rpc_error(16),
    'grpc-7-permission-denied': lambda: _rpc_error(7),
    'wrapped': _wrapped_refusal,
}


@pytest.mark.parametrize('case', sorted(_UNREACHABLE))
def test_connection_and_credential_failures_answer_a_fixed_sentence(case, monkeypatch):
    logged: List[str] = []
    monkeypatch.setattr(vx_tools, 'warning', lambda message: logged.append(str(message)))
    exc = _UNREACHABLE[case]()
    answer = _run(exc)
    assert answer == {
        'success': False,
        'code': 'STORE_ERROR',
        'error': f'{type(exc).__name__}: The store could not be reached or refused the credentials; see the engine log.',
    }
    assert len(logged) == 1 and type(exc).__name__ in logged[0]
    assert not [s for s in ('gx-pgvector', 'vx-pgbouncer', 'rruser', '172.18', 'pcsk_') if s in logged[0]]


_OTHER: Dict[str, Callable[[], BaseException]] = {
    'statement-timeout': lambda: _lib('psycopg2.errors', 'QueryCanceled')(
        'canceling statement due to statement timeout'
    ),
    'lock-timeout': lambda: _lib('psycopg2.errors', 'LockNotAvailable')('could not obtain lock on relation'),
    'qdrant-404': lambda: _qdrant_response(404),
    'milvus-other': lambda: _lib('pymilvus.exceptions', 'MilvusException')(code=1, message='collection not loaded'),
    'file': lambda: FileNotFoundError(2, 'No such file or directory'),
    'grpc-3-invalid-argument': lambda: _rpc_error(3),
}


@pytest.mark.parametrize('case', sorted(_OTHER))
def test_other_backend_failures_keep_their_scrubbed_text(case):
    exc = _OTHER[case]()
    answer = _run(exc)
    assert answer['code'] == 'STORE_ERROR'
    assert 'could not be reached' not in answer['error'] and answer['error'].startswith(type(exc).__name__)


def test_error_text_is_bounded():
    assert len(vx_tools.safe_error_text('x ' * 1000)) <= 300


def test_plain_error_text_is_kept():
    assert vx_tools.safe_error(ValueError('the vector has 3 values')) == 'ValueError: the vector has 3 values'


def test_an_exception_whose_text_fails_still_answers():
    class Unprintable(Exception):
        def __str__(self) -> str:
            raise RuntimeError('the message cannot be built')

    assert vx_tools.safe_error(Unprintable()) == 'Unprintable'
    assert _run(Unprintable()) == {'success': False, 'code': 'STORE_ERROR', 'error': 'Unprintable'}


# ---------------------------------------------------------------------------
# Every tool, every failure: an envelope, never an exception
# ---------------------------------------------------------------------------


class Node(VectorStoreToolMixin, IInstanceBase):
    pass


def _node(store: Any) -> Node:
    inst = object.__new__(Node)
    inst.IGlobal = SimpleNamespace(store=store, glb=SimpleNamespace(logicalType='postgres'), allow_writes=True)
    inst.instance = SimpleNamespace(pipeType={'id': 'store_1'})
    return inst


_INPUTS = {
    'dialect': {},
    'stats': {},
    'list_documents': {},
    'chunks': {'object_id': 'a'},
    'vectors': {'keys': [['a', 0]]},
    'sample': {'n': 5},
    'project': {'sample_id': 's-1-aaaaaaaa', 'vector': [0.1, 0.2]},
    'neighbors': {'vector': [0.1, 0.2]},
    'recommend': {'positive': [['a', 0]]},
    'similarity_matrix': {'keys': [['a', 0], ['a', 1]]},
    'search': {'vector': [0.1, 0.2]},
    'soft_delete': {'object_ids': ['a']},
    'restore': {'object_ids': ['a']},
    'delete': {'object_ids': ['a']},
    'upsert': {'documents': [{'content': 'x', 'object_id': 'a'}]},
    'get': {'object_id': 'a'},
    'objdir': {},
}


def test_every_tool_has_an_input_case():
    assert set(_INPUTS) == set(LEGACY_TOOLS) | set(TRASH_TOOLS) | set(EXPLORER_TOOLS)


@pytest.mark.parametrize('tool', sorted(_INPUTS))
def test_every_tool_answers_an_envelope_when_the_store_is_not_open(tool):
    answer = getattr(_node(None), tool)(_INPUTS[tool])
    assert answer['success'] is False and answer['code'] in TOOL_CODES and answer['error']


class _Exploding(MemoryStore):
    """A store whose every backend call fails."""

    def __getattribute__(self, name):
        if name in {
            '_doesCollectionExist',
            'get',
            'count_documents',
            'searchSemantic',
            'searchKeyword',
            'remove',
            'addChunks',
            'getPaths',
        }:

            def boom(*a, **kw):
                raise OSError('connection to server at "10.9.9.9", port 5432 failed')

            return boom
        return super().__getattribute__(name)


@pytest.mark.parametrize('tool', sorted(_INPUTS))
def test_every_tool_answers_an_envelope_when_the_backend_fails(tool, monkeypatch):
    from ai.common.store import vx_write_gate

    monkeypatch.setattr(
        vx_write_gate,
        '_current_tool_call',
        lambda: {'origin': 'dap', 'source_type': 'tools', 'targeted': True, 'caller': {'auth': 'account'}},
    )
    answer = getattr(_node(_Exploding()), tool)(_INPUTS[tool])
    assert answer['success'] is False and answer['code'] in TOOL_CODES
    assert '10.9.9.9' not in json.dumps(answer)


@pytest.mark.parametrize('tool', sorted(_INPUTS))
def test_every_tool_answer_is_strict_json(tool):
    store = MemoryStore().seed(corpus({'a': [0, 1]}, dim=2))
    answer = getattr(_node(store), tool)(_INPUTS[tool])
    json.dumps(answer, allow_nan=False)
    assert isinstance(answer['success'], bool)


# ---------------------------------------------------------------------------
# Audience and the agent catalog
# ---------------------------------------------------------------------------


def _tool_methods():
    inst = object.__new__(Node)
    inst.IGlobal = SimpleNamespace(tool_description='')
    return inst, inst._collect_tool_methods()


def test_the_store_tools_are_the_six_legacy_ones_the_trash_tools_and_the_explorer_set():
    _inst, methods = _tool_methods()
    assert set(methods) == set(LEGACY_TOOLS) | set(TRASH_TOOLS) | set(EXPLORER_TOOLS)


@pytest.mark.parametrize('tool', LEGACY_TOOLS + TRASH_TOOLS)
def test_legacy_and_trash_tools_are_listed_for_agents(tool):
    _inst, methods = _tool_methods()
    assert methods[tool].__tool_meta__['audience'] == ('agent', 'dap')


@pytest.mark.parametrize('tool', EXPLORER_TOOLS)
def test_explorer_tools_are_listed_for_external_callers_only(tool):
    _inst, methods = _tool_methods()
    assert methods[tool].__tool_meta__['audience'] == ('dap',)


@pytest.mark.parametrize('tool', LEGACY_TOOLS + TRASH_TOOLS + EXPLORER_TOOLS)
def test_every_store_tool_runs_inside_the_wrapper(tool):
    _inst, methods = _tool_methods()
    assert getattr(methods[tool], '__vectordb_tool__', False) is True


def test_the_six_legacy_agent_descriptors_are_byte_identical_to_develop():
    inst, methods = _tool_methods()
    agent = {name: m for name, m in methods.items() if 'agent' in m.__tool_meta__['audience']}
    assert sorted(agent) == sorted(LEGACY_TOOLS + TRASH_TOOLS)
    legacy = {name: m for name, m in sorted(agent.items()) if name in LEGACY_TOOLS}
    text = json.dumps(inst._build_tool_descriptors(legacy), sort_keys=True, separators=(',', ':'))
    assert hashlib.sha256(text.encode('utf-8')).hexdigest() == LEGACY_AGENT_CATALOG_SHA256


def test_explorer_descriptors_build_cleanly():
    inst, methods = _tool_methods()
    explorer = {name: m for name, m in methods.items() if name in EXPLORER_TOOLS}
    for descriptor in inst._build_tool_descriptors(explorer):
        assert descriptor['description'] and descriptor['inputSchema']['type'] == 'object'


def test_tool_function_records_the_audience_it_is_given():
    @tool_function(input_schema={'type': 'object'}, description='x', audience=('dap',))
    def probe(self, args):
        return {}

    assert probe.__tool_meta__['audience'] == ('dap',)


# ---------------------------------------------------------------------------
# Wire shapes agree with the app's fixtures
# ---------------------------------------------------------------------------

_FIXTURES = Path(__file__).resolve().parents[2] / 'apps' / 'vector-ui' / 'tests' / 'fixtures' / 'provisional'

#: Keys an answer may carry beyond the fixture, or leave out when they do not apply
#: (``range`` is optional in ``dialect.score``: a driver reports it when it knows it).
_OPTIONAL = {'caveats', 'warnings', 'similarities', 'not_found', 'range'}


def _fixture(name: str) -> Dict[str, Any]:
    return json.loads((_FIXTURES / f'{name}.json').read_text(encoding='utf-8'))


def _same_keys(answer: Dict[str, Any], fixture: Dict[str, Any], where: str, additive: Iterable[str] = ()) -> None:
    mine, theirs, allowed = set(answer), set(fixture), set(_OPTIONAL) | set(additive)
    assert theirs - _OPTIONAL <= mine, f'{where}: missing {sorted(theirs - _OPTIONAL - mine)}'
    assert mine <= theirs | allowed, f'{where}: unexpected {sorted(mine - theirs - allowed)}'


def _additive(base: Dict[str, Any], *enriched: Dict[str, Any]) -> set:
    """The keys the additive extensions (contract section 4.4) add to an answer of the first contract.

    An answer may carry them or not, whichever node change is merged; the enriched
    provisional fixtures fix which keys they are.
    """
    return set().union(*(set(e) for e in enriched)) - set(base)


@pytest.fixture
def wired(monkeypatch):
    """A node over a counting, vector-capable store with a sample drawn."""
    from ai.common.store import vx_write_gate

    from .test_vectordb_tool_mixin import clustered, node

    monkeypatch.setattr(
        vx_write_gate,
        '_current_tool_call',
        lambda: {'origin': 'dap', 'source_type': 'tools', 'targeted': True, 'caller': {'auth': 'account'}},
    )
    store = clustered(docs=4, chunks=5)
    inst = node(store, allow_writes=True)
    sample = inst.sample({'n': 12, 'seed': 7})
    return store, inst, sample


def test_dialect_matches_the_fixture(wired):
    _store, inst, _sample = wired
    answer, fixture = inst.dialect({}), _fixture('dialect_pgvector')
    _same_keys(answer, fixture, 'dialect', _additive(fixture, _fixture('dialect_enriched')))
    for part in ('score', 'limits', 'health'):
        _same_keys(answer[part], fixture[part], f'dialect.{part}')
    assert set(answer['capabilities']) == set(fixture['capabilities'])


def test_stats_matches_the_fixture(wired):
    _store, inst, _sample = wired
    # document_count is #2704's name for the documents figure, kept beside it.
    _same_keys(inst.stats({}), _fixture('stats_pgvector'), 'stats', {'document_count'})
    _same_keys(
        _node(MemoryStore()).stats({}),
        _fixture('stats_collection_missing_legacy'),
        'stats(missing)',
        {'document_count'},
    )


def test_list_documents_matches_the_fixture(wired):
    _store, inst, _sample = wired
    answer, fixture = inst.list_documents({}), _fixture('list_documents_page1')
    # documents, offset and has_more are #2704's answer keys, kept as aliases of items / next_cursor.
    _same_keys(answer, fixture, 'list_documents', {'documents', 'offset', 'has_more'})
    _same_keys(
        answer['items'][0],
        fixture['items'][0],
        'list_documents.items[]',
        _additive(fixture['items'][0], _fixture('list_documents_filter_server')['items'][0]),
    )


def test_chunks_matches_the_fixture(wired):
    _store, inst, _sample = wired
    answer, fixture = inst.chunks({'object_id': 'doc00', 'limit': 2}), _fixture('chunks_page')
    _same_keys(answer, fixture, 'chunks')
    _same_keys(answer['items'][0], fixture['items'][0], 'chunks.items[]')


def test_sample_matches_the_fixtures(wired):
    _store, _inst, sample = wired
    enriched = (_fixture('sample_demo_1000_clusters'), _fixture('sample_listing_truncated'))
    for name in ('sample_demo_1000', 'sample_biased_refilled', 'sample_native_knn'):
        fixture = _fixture(name)
        _same_keys(sample, fixture, name, _additive(fixture, *enriched))
        _same_keys(
            sample['points'], fixture['points'], f'{name}.points', _additive(fixture['points'], enriched[0]['points'])
        )
        _same_keys(sample['knn'], fixture['knn'], f'{name}.knn')
        _same_keys(sample['docs'][0], fixture['docs'][0], f'{name}.docs[]')
        _same_keys(sample['pca'], fixture['pca'], f'{name}.pca')
        _same_keys(sample['of'], fixture['of'], f'{name}.of')


def test_project_matches_the_fixtures(wired):
    store, inst, sample = wired
    by_vector = inst.project(
        {'sample_id': sample['sample_id'], 'vector': store.rows[('doc00', 0)].embedding, 'with_similarities': True}
    )
    by_keys = inst.project({'sample_id': sample['sample_id'], 'keys': [['doc00', 0], ['doc03', 4]]})
    _same_keys(by_vector, _fixture('project_vector'), 'project(vector)')
    _same_keys(by_keys, _fixture('project_keys'), 'project(keys)')
    _same_keys(by_keys['items'][0], _fixture('project_keys')['items'][0], 'project.items[]')


def test_neighbors_matches_the_fixtures(wired):
    _store, inst, _sample = wired
    answer, fixture = inst.neighbors({'key': ['doc00', 0]}), _fixture('neighbors_key')
    _same_keys(answer, fixture, 'neighbors')
    _same_keys(answer['items'][0], fixture['items'][0], 'neighbors.items[]')
    scoped = inst.neighbors({'key': ['doc00', 0], 'scope_keys': [['doc01', 0]]})
    _same_keys(scoped, _fixture('neighbors_scope_scores'), 'neighbors(scope)')


def test_the_additive_keys_are_the_enriched_fixtures_own():
    assert _additive(_fixture('dialect_pgvector'), _fixture('dialect_enriched')) == {'keyword_match', 'size_bytes'}
    sample = _fixture('sample_demo_1000')
    assert _additive(sample, _fixture('sample_demo_1000_clusters'), _fixture('sample_listing_truncated')) == {
        'clusters',
        'listing',
        'caveats',
    }
    assert _additive(sample['points'], _fixture('sample_demo_1000_clusters')['points']) == {'table'}
    with pytest.raises(AssertionError, match='unexpected'):
        _same_keys({**sample, 'vectors': []}, sample, 'sample', {'listing'})


def test_recommend_matches_the_fixtures(wired):
    _store, inst, _sample = wired
    answer = inst.recommend({'positive': [['doc00', 0], ['doc01', 1]], 'negative': [['doc03', 2]], 'k': 6})
    fixture = _fixture('recommend_ok')
    _same_keys(answer, fixture, 'recommend')
    _same_keys(answer['items'][0], fixture['items'][0], 'recommend.items[]')
    _same_keys(answer['examples_resolved'], fixture['examples_resolved'], 'recommend.examples_resolved')
    assert inst.recommend({'positive': [['doc00', 0]], 'strategy': 'best_score'}) == _fixture('recommend_unsupported')


def test_similarity_matrix_matches_the_fixture(wired):
    _store, inst, _sample = wired
    answer = inst.similarity_matrix({'keys': [['doc00', 0], ['doc00', 3], ['doc02', 0]]})
    fixture = _fixture('similarity_matrix_ok')
    _same_keys(answer, fixture, 'similarity_matrix')
    assert (answer['n'], answer['dp'], answer['metric']) == (fixture['n'], fixture['dp'], fixture['metric'])
    assert answer['keys'] == [['doc00', 0], ['doc00', 3], ['doc02', 0]] and len(answer['matrix']) == 3
    assert answer['source'] in ('cache', 'store', 'mixed') and answer['not_found'] == fixture['not_found'] == []


def test_search_matches_the_fixture(wired):
    store, inst, _sample = wired
    answer, fixture = inst.search({'vector': store.rows[('doc00', 0)].embedding}), _fixture('search_vector')
    _same_keys(answer, fixture, 'search')
    _same_keys(answer['results'][0], fixture['results'][0], 'search.results[]')


def test_the_trash_answers_match_the_fixtures(wired):
    store, inst, _sample = wired
    for tool, args, name in (
        ('soft_delete', {'object_ids': ['doc01']}, 'soft_delete_ok'),
        ('restore', {'object_ids': ['doc01']}, 'restore_ok'),
        ('delete', {'object_ids': ['doc01']}, 'delete_ok'),
    ):
        answer, fixture = getattr(inst, tool)(args), _fixture(name)
        # moved_chunks (the trash writes) and object_ids (delete's echo) are #2704-compatible additions.
        _same_keys(answer, fixture, tool, {'moved_chunks', 'object_ids'})
        _same_keys(answer['audit'], fixture['audit'], f'{tool}.audit')
    store.markDeleted(['doc02'])
    store.rows[('doc03', 0)].metadata.isDeleted = True
    emptied = inst.delete({'object_ids': ['doc02', 'doc03'], 'deleted_only': True})
    fixture = _fixture('delete_deleted_only')
    _same_keys(emptied, fixture, 'delete(deleted_only)', {'object_ids'})
    assert emptied['kept_live'] == ['doc03'] and fixture['kept_live']
    in_trash = inst.list_documents({'deleted': 'deleted'})
    assert [item['objectId'] for item in in_trash['items']] == ['doc03']
    store.markDeleted(['doc00'])
    answer, fixture = inst.chunks({'object_id': 'doc00'}), _fixture('chunks_in_trash')
    _same_keys(answer, fixture, 'chunks(in trash)')
    assert answer['code'] == fixture['code'] == 'IN_TRASH'


def test_every_documented_code_has_an_app_sentence():
    assert set(_fixture('errors')) == set(TOOL_CODES)
