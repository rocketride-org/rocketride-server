# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Tests for the ``embed`` tool on the embedding nodes (vector tool contract, section 4.3).

``ai.common.embed_tool.EmbedToolMixin`` gives ``embedding_transformer`` and
``embedding_openai`` one DAP-only tool, ``embed``: it turns 1 to 8 texts into
vectors with the node's own model, so Vector Explorer can place a text query on
its map with exactly the vector the pipeline would have produced.

The unit tests load the real mixin and the real node classes from source and
drive the tool through the real ``IInstanceBase.invoke`` dispatcher; only the
model is replaced, by :class:`FakeEmbedding`, which follows the wrappers'
``encodeQuestion`` / ``encodeChunks`` contract. They cover:

* the answer's shape (keys, dimension, model, rounding, numpy to lists) and the
  ``kind`` / prefix handling;
* every refusal: ``INVALID_INPUT`` (caps from ``vx_defaults.EMBED_TOOL_LIMITS``),
  ``NO_EMBEDDER``, ``RATE_LIMITED`` (token bucket per task: 30 a minute, burst 5),
  ``BUSY`` and ``STORE_ERROR``, none of which raises past the tool;
* ``IGlobal.embed_lock``: a tool call made while a batch is being embedded
  completes after that batch, and a batch (document flush or question) that
  arrives during or behind a tool call waits for it, on both nodes; the node's
  own batches still run concurrently with each other.

``test_embed_through_the_engine`` is live: it starts a pipeline whose Tools
source controls ``embedding_transformer`` and calls ``embed`` through the SDK.
It loads MiniLM, so like the node's other live tests it carries ``skip_node``::

    builder nodes:test --pytest="-m skip_node -k embed_tool"
"""

from __future__ import annotations

import asyncio
import hashlib
import importlib
import importlib.util
import json
import math
import sys
import threading
import time
import types
import uuid
from contextlib import suppress
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

import pytest

_NODES_SRC = Path(__file__).resolve().parents[1] / 'src' / 'nodes'

_ANSWER_KEYS = {'success', 'model', 'dimension', 'vectors', 'prefix_applied', 'ms'}


# ---------------------------------------------------------------------------
# Loading the real modules
# ---------------------------------------------------------------------------


def _embed_tool() -> types.ModuleType:
    """Import the real ``ai.common.embed_tool`` (lazily, so a missing module fails each test)."""
    return importlib.import_module('ai.common.embed_tool')


def _limits() -> Dict[str, int]:
    return importlib.import_module('ai.common.store.vx_defaults').EMBED_TOOL_LIMITS


_NODE_CLASSES: Dict[str, tuple] = {}


def _node_classes(node: str) -> tuple:
    """Load ``(IGlobal, IInstance)`` of one embedding node from source.

    The node package is registered under a private name and removed again, so the
    real ``nodes.<node>`` modules (if anything imported them) are never touched.
    """
    if node in _NODE_CLASSES:
        return _NODE_CLASSES[node]

    node_dir = _NODES_SRC / node
    pkg = f'_vx_embed_tool_test_{node}'
    names = [pkg, f'{pkg}.IGlobal', f'{pkg}.IInstance']
    try:
        pkg_spec = importlib.util.spec_from_file_location(
            pkg, node_dir / '__init__.py', submodule_search_locations=[str(node_dir)]
        )
        # Registered but not executed: the relative imports only need the package to exist.
        sys.modules[pkg] = importlib.util.module_from_spec(pkg_spec)
        for sub in ('IGlobal', 'IInstance'):
            spec = importlib.util.spec_from_file_location(f'{pkg}.{sub}', node_dir / f'{sub}.py')
            mod = importlib.util.module_from_spec(spec)
            sys.modules[f'{pkg}.{sub}'] = mod
            spec.loader.exec_module(mod)
        classes = (sys.modules[f'{pkg}.IGlobal'].IGlobal, sys.modules[f'{pkg}.IInstance'].IInstance)
    finally:
        for name in names:
            sys.modules.pop(name, None)

    _NODE_CLASSES[node] = classes
    return classes


NODES = ('embedding_transformer', 'embedding_openai')


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------


class FakeEmbedding:
    """A deterministic model behind the wrappers' ``encodeQuestion`` / ``encodeChunks`` API.

    Each text maps to a fixed vector derived from its SHA-256, with more decimals
    than the tool returns. ``as_numpy`` makes it return numpy float32 arrays the
    way a raw sentence-transformers call would. ``hook(kind, texts)`` runs inside
    every encode call, before the vectors are stamped (tests block on it).
    """

    def __init__(
        self,
        *,
        dim: int = 6,
        model: str = 'fake/model-v1',
        query_prefix: str = '',
        document_prefix: str = '',
        as_numpy: bool = False,
        hook: Optional[Callable[[str, List[str]], None]] = None,
    ) -> None:
        self.dim = dim
        self.model = model
        self.query_prefix = query_prefix
        self.document_prefix = document_prefix
        self.as_numpy = as_numpy
        self.hook = hook
        self.calls: List[tuple] = []

    def vector(self, text: str) -> List[float]:
        digest = hashlib.sha256(text.encode('utf-8')).digest()
        return [(digest[i % len(digest)] - 127.5) / 1000.0 + 1e-9 * (i + 1) for i in range(self.dim)]

    def _out(self, text: str) -> Any:
        values = self.vector(text)
        if self.as_numpy:
            import numpy as np

            return np.asarray(values, dtype=np.float32)
        return values

    def getVectorSize(self) -> int:
        return self.dim

    def getMaximumTokens(self) -> int:
        return 256

    def encodeQuestion(self, question: Any) -> None:
        texts = [f'{self.query_prefix}{q.text}' for q in question.questions]
        self.calls.append(('question', texts))
        if self.hook:
            self.hook('question', texts)
        for q, text in zip(question.questions, texts):
            q.embedding = self._out(text)
            q.embedding_model = self.model

    def encodeChunks(self, chunks: List[Any]) -> None:
        if not chunks:
            return
        texts = [f'{self.document_prefix}{c.page_content}' for c in chunks]
        self.calls.append(('chunks', texts))
        if self.hook:
            self.hook('chunks', texts)
        for chunk, text in zip(chunks, texts):
            chunk.embedding = self._out(text)
            chunk.embedding_model = self.model


class FakeClock:
    """A monotonic clock the test moves by hand."""

    def __init__(self, start: float = 1000.0) -> None:
        self.now = start

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


def _make(node: str = 'embedding_transformer', embedding: Any = 'default', clock: Optional[FakeClock] = None):
    """Build ``(instance, global)`` of a node wired to a fake model and a capturing downstream."""
    IGlobal, IInstance = _node_classes(node)
    glb = IGlobal()
    glb.embedding = FakeEmbedding() if embedding == 'default' else embedding
    if clock is not None:
        limits = _limits()
        glb.embed_bucket = _embed_tool().TokenBucket(limits['embed_per_minute'], limits['embed_burst'], clock=clock)
    inst = _instance(IInstance, glb)
    return inst, glb


def _instance(IInstance: type, glb: Any) -> Any:
    inst = IInstance()
    inst.IGlobal = glb
    inst.delivered = []
    inst.instance = types.SimpleNamespace(writeDocuments=lambda docs: inst.delivered.extend(docs))
    inst.open(None)
    return inst


def _invoke(inst: Any, payload: Any) -> Dict[str, Any]:
    """Call ``embed`` through the real ``IInstanceBase.invoke`` dispatcher, as the engine does."""
    param = {'op': 'tool.invoke', 'tool_name': 'embed', 'input': payload}
    result = inst.invoke(param)
    assert result is param
    return param['output']


def _docs(count: int) -> List[Any]:
    from ai.common.schema import Doc

    return [Doc(page_content=f'chunk {i}') for i in range(count)]


def _write_documents(inst: Any, docs: List[Any]) -> None:
    """Run ``writeDocuments`` and swallow the PreventDefault it ends with."""
    from rocketlib import APERR, Ec

    try:
        inst.writeDocuments(docs)
    except APERR as e:
        if e.ec != Ec.PreventDefault:
            raise


def _question(*texts: str) -> Any:
    from ai.common.schema import Question

    q = Question()
    for text in texts:
        q.addQuestion(text)
    return q


# ---------------------------------------------------------------------------
# Registration
# ---------------------------------------------------------------------------


@pytest.mark.parametrize('node', NODES)
def test_embed_is_registered_as_a_dap_only_tool(node):
    _, IInstance = _node_classes(node)
    et = _embed_tool()

    assert issubclass(IInstance, et.EmbedToolMixin)
    inst = IInstance()
    methods = inst._collect_tool_methods()
    assert 'embed' in methods, 'the embedding node must expose the embed tool to tool.invoke'

    meta = methods['embed'].__tool_meta__
    assert meta['audience'] == ('dap',), 'embed is for external tool calls only; agents never see it'


@pytest.mark.parametrize('node', NODES)
def test_agents_never_see_embed(node):
    from rocketlib import APERR, Ec

    inst, _ = _make(node)
    param = {'op': 'tool.query', 'tools': []}

    with pytest.raises(APERR) as raised:
        inst.invoke(param)  # tool.query always continues the chain

    assert raised.value.ec == Ec.PreventDefault
    assert 'embed' not in [tool['name'] for tool in param['tools']]


def test_input_schema_carries_the_node_enforced_caps():
    et = _embed_tool()
    limits = _limits()
    schema = et.EMBED_TOOL_INPUT_SCHEMA

    texts = schema['properties']['texts']
    assert schema['required'] == ['texts']
    assert texts['minItems'] == 1
    assert texts['maxItems'] == limits['embed_texts_max'] == 8
    assert texts['items']['maxLength'] == limits['embed_text_chars_max'] == 8000
    assert schema['properties']['kind']['enum'] == ['query', 'document']
    assert limits['embed_per_minute'] == 30 and limits['embed_burst'] == 5


# ---------------------------------------------------------------------------
# Answer shape
# ---------------------------------------------------------------------------


@pytest.mark.parametrize('node', NODES)
def test_query_answer_shape(node):
    inst, glb = _make(node)

    out = _invoke(inst, {'texts': ['where do kestrels nest', 'river flood map']})

    assert set(out) == _ANSWER_KEYS
    assert out['success'] is True
    assert out['model'] == 'fake/model-v1'
    assert out['dimension'] == 6
    assert out['prefix_applied'] is None
    assert isinstance(out['ms'], int) and out['ms'] >= 0
    assert len(out['vectors']) == 2
    for vector in out['vectors']:
        assert isinstance(vector, list) and len(vector) == 6
        assert all(type(v) is float for v in vector)
    # One batch, through the questions path of the model.
    assert glb.embedding.calls == [('question', ['where do kestrels nest', 'river flood map'])]
    json.dumps(out, allow_nan=False)


def test_kind_defaults_to_query_and_matches_the_questions_lane():
    inst, glb = _make()

    out = _invoke(inst, {'texts': ['capital of France']})

    question = _question('capital of France')
    inst.writeQuestions(question)
    lane_vector = question.questions[0].embedding
    assert question.questions[0].embedding_model == out['model']
    assert out['vectors'][0] == [round(v, 6) for v in lane_vector]


def test_document_kind_uses_the_documents_path_and_matches_the_flush():
    emb = FakeEmbedding(document_prefix='passage: ', query_prefix='query: ')
    inst, glb = _make(embedding=emb)

    out = _invoke(inst, {'texts': ['chunk 0'], 'kind': 'document'})

    assert out['success'] is True
    assert out['prefix_applied'] == 'passage: '
    assert emb.calls == [('chunks', ['passage: chunk 0'])]

    docs = _docs(1)
    emb.encodeChunks(docs)
    assert out['vectors'][0] == [round(v, 6) for v in docs[0].embedding]


def test_query_prefix_is_reported():
    emb = FakeEmbedding(query_prefix='query: ')
    inst, _ = _make(embedding=emb)

    out = _invoke(inst, {'texts': ['x'], 'kind': 'query'})

    assert out['prefix_applied'] == 'query: '
    assert emb.calls == [('question', ['query: x'])]


def test_numpy_vectors_become_plain_float_lists():
    inst, _ = _make(embedding=FakeEmbedding(as_numpy=True, dim=384))

    out = _invoke(inst, {'texts': ['a', 'b', 'c']})

    assert out['dimension'] == 384
    assert all(type(v) is float for vector in out['vectors'] for v in vector)
    json.dumps(out, allow_nan=False)


def test_values_are_rounded_to_six_decimals():
    emb = FakeEmbedding()
    inst, _ = _make(embedding=emb)

    out = _invoke(inst, {'texts': ['rounding']})

    raw = emb.vector('rounding')
    assert out['vectors'][0] == [round(v, 6) for v in raw]
    assert out['vectors'][0] != raw, 'the fake carries more than six decimals, so rounding must show'


def test_eight_texts_of_the_maximum_length_are_accepted():
    limits = _limits()
    inst, _ = _make()
    texts = [chr(ord('a') + i) * limits['embed_text_chars_max'] for i in range(limits['embed_texts_max'])]

    out = _invoke(inst, {'texts': texts})

    assert out['success'] is True
    assert len(out['vectors']) == limits['embed_texts_max']


@pytest.mark.parametrize(
    'payload',
    [
        json.dumps({'texts': ['as a JSON string']}),
        {'input': {'texts': ['nested input']}},
        {'input': json.dumps({'texts': ['nested JSON']})},
    ],
    ids=['json-string', 'nested-dict', 'nested-json'],
)
def test_wrapped_inputs_are_normalised(payload):
    inst, _ = _make()

    out = _invoke(inst, payload)

    assert out['success'] is True
    assert len(out['vectors']) == 1


def test_pydantic_style_input_is_normalised():
    class Model:
        def model_dump(self) -> Dict[str, Any]:
            return {'texts': ['from a model']}

    inst, _ = _make()

    assert _invoke(inst, Model())['success'] is True


def test_the_tool_leaves_buffered_documents_alone():
    inst, glb = _make()
    buffered = _docs(3)
    _write_documents(inst, buffered)

    _invoke(inst, {'texts': ['probe']})

    assert inst.documents == buffered
    assert inst.delivered == []
    assert glb.embedding.calls == [('question', ['probe'])]


# ---------------------------------------------------------------------------
# Refusals
# ---------------------------------------------------------------------------


def _assert_failure(out: Dict[str, Any], code: str) -> None:
    assert out['success'] is False
    assert out['code'] == code
    assert isinstance(out['error'], str) and out['error']
    assert code in importlib.import_module('ai.common.store.vx_types').TOOL_CODES


@pytest.mark.parametrize('node', NODES)
def test_a_caller_signed_in_with_a_public_task_key_is_refused_before_the_model_runs(node):
    from ai.common import tool_context
    from rocketlib.types import IInvokeTool

    inst, glb = _make(node)
    param = IInvokeTool.Invoke(tool_name='embed', input={'texts': ['probe']})
    ctx = tool_context.dap_context(source_type='tools', node_id='embed_1', caller={'auth': 'public'})
    tool_context.stamp_param(param, ctx)
    inst.invoke(param)
    _assert_failure(param.output, 'READS_PUBLIC')
    assert glb.embedding.calls == []
    # The refusal spent nothing: an account caller still has the whole burst.
    for _ in range(_limits()['embed_burst']):
        param = IInvokeTool.Invoke(tool_name='embed', input={'texts': ['probe']})
        tool_context.stamp_param(
            param, tool_context.dap_context(source_type='tools', node_id='embed_1', caller={'auth': 'account'})
        )
        inst.invoke(param)
        assert param.output['success'] is True, param.output


_INVALID = [
    ({}, 'no-texts'),
    ({'texts': None}, 'texts-none'),
    ({'texts': 'one string'}, 'texts-string'),
    ({'texts': []}, 'texts-empty'),
    ({'texts': ['t'] * 9}, 'nine-texts'),
    ({'texts': [7]}, 'not-a-string'),
    ({'texts': ['']}, 'empty-text'),
    ({'texts': ['   \n\t']}, 'blank-text'),
    ({'texts': ['x' * 8001]}, 'text-too-long'),
    ({'texts': ['ok'], 'kind': 'passage'}, 'unknown-kind'),
    ({'texts': ['ok'], 'kind': 3}, 'kind-not-a-string'),
    ('[1, 2]', 'json-list'),
    ('{not json', 'malformed-json'),
    (42, 'number'),
]


@pytest.mark.parametrize('payload', [p for p, _ in _INVALID], ids=[i for _, i in _INVALID])
def test_invalid_input_is_refused_without_calling_the_model(payload):
    inst, glb = _make()

    out = _invoke(inst, payload)

    _assert_failure(out, 'INVALID_INPUT')
    assert glb.embedding.calls == []


def test_invalid_calls_do_not_spend_the_rate_limit():
    clock = FakeClock()
    inst, _ = _make(clock=clock)

    for _ in range(20):
        _assert_failure(_invoke(inst, {'texts': []}), 'INVALID_INPUT')

    for _ in range(_limits()['embed_burst']):
        assert _invoke(inst, {'texts': ['ok']})['success'] is True


@pytest.mark.parametrize('node', NODES)
def test_no_model_answers_no_embedder(node):
    inst, _ = _make(node, embedding=None)

    _assert_failure(_invoke(inst, {'texts': ['x']}), 'NO_EMBEDDER')


def test_no_global_answers_no_embedder():
    _, IInstance = _node_classes('embedding_transformer')
    inst = IInstance()
    inst.IGlobal = None

    _assert_failure(_invoke(inst, {'texts': ['x']}), 'NO_EMBEDDER')


def test_a_model_failure_is_an_envelope_that_reveals_nothing_of_the_backend():
    def fail(kind: str, texts: List[str]) -> None:
        # What a hosted backend's error can carry: a credential fragment and the endpoint.
        raise RuntimeError('rejected sk-0000 at https://embeddings.internal.example:8443/v1')

    inst, _ = _make(embedding=FakeEmbedding(hook=fail))

    out = _invoke(inst, {'texts': ['x']})

    _assert_failure(out, 'STORE_ERROR')
    assert 'RuntimeError' in out['error']
    assert 'sk-' not in out['error'] and 'example' not in out['error'] and '8443' not in out['error']


def test_a_base_exception_from_the_model_is_contained():
    class Odd(BaseException):
        pass

    def fail(kind: str, texts: List[str]) -> None:
        raise Odd('odd')

    inst, _ = _make(embedding=FakeEmbedding(hook=fail))

    _assert_failure(_invoke(inst, {'texts': ['x']}), 'STORE_ERROR')


def test_keyboard_interrupt_is_not_swallowed():
    def stop(kind: str, texts: List[str]) -> None:
        raise KeyboardInterrupt()

    inst, _ = _make(embedding=FakeEmbedding(hook=stop))

    with pytest.raises(KeyboardInterrupt):
        _invoke(inst, {'texts': ['x']})


class _BadOutput(FakeEmbedding):
    def __init__(self, mode: str) -> None:
        super().__init__()
        self.mode = mode

    def encodeQuestion(self, question: Any) -> None:
        super().encodeQuestion(question)
        if self.mode == 'missing':
            question.questions[-1].embedding = None
        elif self.mode == 'ragged':
            question.questions[-1].embedding = [0.1, 0.2]
        elif self.mode == 'nan':
            question.questions[0].embedding = [float('nan')] * self.dim
        elif self.mode == 'empty':
            for q in question.questions:
                q.embedding = []


@pytest.mark.parametrize('mode', ['missing', 'ragged', 'nan', 'empty'])
def test_unusable_model_output_is_a_store_error(mode):
    inst, _ = _make(embedding=_BadOutput(mode))

    _assert_failure(_invoke(inst, {'texts': ['a', 'b']}), 'STORE_ERROR')


# ---------------------------------------------------------------------------
# Rate limit: token bucket per task (per IGlobal)
# ---------------------------------------------------------------------------


def test_burst_of_five_then_rate_limited_with_retry_after():
    clock = FakeClock()
    inst, glb = _make(clock=clock)

    for _ in range(5):
        assert _invoke(inst, {'texts': ['q']})['success'] is True

    out = _invoke(inst, {'texts': ['q']})

    _assert_failure(out, 'RATE_LIMITED')
    assert out['retry_after_s'] == 2
    assert isinstance(out['retry_after_s'], int)
    assert '2 s' in out['error']
    assert len(glb.embedding.calls) == 5, 'a rate-limited call must not reach the model'

    clock.advance(2.0)
    assert _invoke(inst, {'texts': ['q']})['success'] is True


def test_thirty_calls_a_minute_are_sustained():
    clock = FakeClock()
    inst, _ = _make(clock=clock)

    for _ in range(5):
        assert _invoke(inst, {'texts': ['q']})['success'] is True
    # The bucket refills at 30 a minute: one call every 2 s keeps succeeding.
    for _ in range(30):
        clock.advance(2.0)
        assert _invoke(inst, {'texts': ['q']})['success'] is True

    _assert_failure(_invoke(inst, {'texts': ['q']}), 'RATE_LIMITED')


def test_the_bucket_refills_to_the_burst_and_no_further():
    clock = FakeClock()
    inst, _ = _make(clock=clock)

    clock.advance(3600.0)
    for _ in range(5):
        assert _invoke(inst, {'texts': ['q']})['success'] is True
    _assert_failure(_invoke(inst, {'texts': ['q']}), 'RATE_LIMITED')


def test_retry_after_rounds_up_to_whole_seconds():
    clock = FakeClock()
    inst, _ = _make(clock=clock)
    for _ in range(5):
        _invoke(inst, {'texts': ['q']})

    clock.advance(0.5)
    out = _invoke(inst, {'texts': ['q']})

    _assert_failure(out, 'RATE_LIMITED')
    assert out['retry_after_s'] == 2  # 1.5 s left, rounded up


def test_the_bucket_is_per_task_and_shared_by_its_instances():
    IGlobal, IInstance = _node_classes('embedding_transformer')
    clock = FakeClock()
    limits = _limits()
    glb = IGlobal()
    glb.embedding = FakeEmbedding()
    glb.embed_bucket = _embed_tool().TokenBucket(limits['embed_per_minute'], limits['embed_burst'], clock=clock)
    first, second = _instance(IInstance, glb), _instance(IInstance, glb)

    for i in range(5):
        assert _invoke(first if i % 2 else second, {'texts': ['q']})['success'] is True
    _assert_failure(_invoke(first, {'texts': ['q']}), 'RATE_LIMITED')
    _assert_failure(_invoke(second, {'texts': ['q']}), 'RATE_LIMITED')

    other, _ = _make(clock=clock)
    assert _invoke(other, {'texts': ['q']})['success'] is True, 'another task has its own bucket'


def test_the_default_bucket_is_created_once_per_global():
    et = _embed_tool()
    IGlobal, _ = _node_classes('embedding_transformer')
    glb = IGlobal()

    bucket = et.embed_bucket_of(glb)

    assert isinstance(bucket, et.TokenBucket)
    assert et.embed_bucket_of(glb) is bucket
    assert et.embed_bucket_of(IGlobal()) is not bucket


def test_token_bucket_unit():
    et = _embed_tool()
    clock = FakeClock()
    bucket = et.TokenBucket(30, 5, clock=clock)

    assert [bucket.take() for _ in range(5)] == [None] * 5
    wait = bucket.take()
    assert wait == pytest.approx(2.0)
    bucket.refund()
    assert bucket.take() is None
    assert bucket.take() == pytest.approx(2.0)


# ---------------------------------------------------------------------------
# embed_lock: the tool and the flush path share the model
# ---------------------------------------------------------------------------


class _Gate:
    """Blocks the first encode of a given kind until released, recording the order of events."""

    def __init__(self, block_kind: str) -> None:
        self.block_kind = block_kind
        self.entered = threading.Event()
        self.release = threading.Event()
        self.events: List[str] = []
        self._lock = threading.Lock()
        self._blocked = False

    def hook(self, kind: str, texts: List[str]) -> None:
        with self._lock:
            block = kind == self.block_kind and not self._blocked
            if block:
                self._blocked = True
            self.events.append(f'{kind}:start')
        if block:
            self.entered.set()
            assert self.release.wait(10), 'the test never released the blocked encode'
        with self._lock:
            self.events.append(f'{kind}:end')


def _in_thread(fn: Callable[[], Any]) -> tuple:
    box: Dict[str, Any] = {}

    def run() -> None:
        try:
            box['result'] = fn()
        except BaseException as e:  # surfaced to the test below
            box['error'] = e

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    return thread, box


def _until(predicate: Callable[[], bool], what: str, wait_s: float = 10.0) -> None:
    deadline = time.monotonic() + wait_s
    while not predicate():
        assert time.monotonic() < deadline, f'timed out waiting until {what}'
        time.sleep(0.005)


def _flush_documents(node: str, inst: Any) -> None:
    """Make the node embed a batch: a full buffer on the transformer, any write on OpenAI."""
    if node == 'embedding_transformer':
        _write_documents(inst, _docs(inst.maxDocuments))
    else:
        _write_documents(inst, _docs(3))


@pytest.mark.parametrize('node', NODES)
def test_a_tool_call_during_a_flush_completes_after_the_flush(node):
    gate = _Gate('chunks')
    IGlobal, IInstance = _node_classes(node)
    glb = IGlobal()
    glb.embedding = FakeEmbedding(hook=gate.hook)
    ingest, tools = _instance(IInstance, glb), _instance(IInstance, glb)

    flush, flush_box = _in_thread(lambda: _flush_documents(node, ingest))
    assert gate.entered.wait(10), 'the flush never reached the model'

    call, call_box = _in_thread(lambda: _invoke(tools, {'texts': ['during the flush']}))
    _until(lambda: _embed_tool().embed_lock_of(glb).exclusive_waiters == 1, 'the tool call waits on the lock')
    call.join(0.2)
    assert call.is_alive(), 'the tool call must wait while the batch is being embedded'
    assert gate.events == ['chunks:start']

    gate.release.set()
    flush.join(10)
    call.join(10)
    assert not flush.is_alive() and not call.is_alive()
    assert 'error' not in flush_box and 'error' not in call_box, (flush_box, call_box)

    assert call_box['result']['success'] is True
    assert gate.events == ['chunks:start', 'chunks:end', 'question:start', 'question:end']
    if node == 'embedding_transformer':
        assert len(ingest.delivered) == ingest.maxDocuments, 'the flushed batch still goes downstream'


@pytest.mark.parametrize('node', NODES)
def test_a_flush_during_a_tool_call_waits_for_the_call(node):
    gate = _Gate('question')
    IGlobal, IInstance = _node_classes(node)
    glb = IGlobal()
    glb.embedding = FakeEmbedding(hook=gate.hook)
    ingest, tools = _instance(IInstance, glb), _instance(IInstance, glb)

    call, call_box = _in_thread(lambda: _invoke(tools, {'texts': ['first']}))
    assert gate.entered.wait(10), 'the tool call never reached the model'

    flush, flush_box = _in_thread(lambda: _flush_documents(node, ingest))
    flush.join(0.3)
    assert flush.is_alive(), 'the flush must wait while the tool call is embedding'

    gate.release.set()
    call.join(10)
    flush.join(10)
    assert 'error' not in flush_box and 'error' not in call_box, (flush_box, call_box)
    assert gate.events == ['question:start', 'question:end', 'chunks:start', 'chunks:end']


@pytest.mark.parametrize('node', NODES)
def test_the_questions_lane_waits_for_a_tool_call(node):
    gate = _Gate('question')
    IGlobal, IInstance = _node_classes(node)
    glb = IGlobal()
    glb.embedding = FakeEmbedding(hook=gate.hook)
    chat, tools = _instance(IInstance, glb), _instance(IInstance, glb)

    call, _ = _in_thread(lambda: _invoke(tools, {'texts': ['tool']}))
    assert gate.entered.wait(10)

    lane, lane_box = _in_thread(lambda: chat.writeQuestions(_question('lane')))
    lane.join(0.3)
    assert lane.is_alive(), 'encoding a question must wait for the tool call'

    gate.release.set()
    call.join(10)
    lane.join(10)
    assert 'error' not in lane_box, lane_box
    assert gate.events == ['question:start', 'question:end', 'question:start', 'question:end']


@pytest.mark.parametrize('node', NODES)
def test_batches_on_several_threads_still_run_concurrently(node):
    """The node's own batches share the lock: ingest threads are not serialised by it."""
    both_inside = threading.Barrier(2, timeout=10)

    def meet(kind: str, texts: List[str]) -> None:
        both_inside.wait()  # raises BrokenBarrierError unless both batches are on the model at once

    IGlobal, IInstance = _node_classes(node)
    glb = IGlobal()
    glb.embedding = FakeEmbedding(hook=meet)
    first, second = _instance(IInstance, glb), _instance(IInstance, glb)

    a, a_box = _in_thread(lambda: _flush_documents(node, first))
    b, b_box = _in_thread(lambda: second.writeQuestions(_question('chat')))
    a.join(15)
    b.join(15)

    assert 'error' not in a_box and 'error' not in b_box, (a_box, b_box)


@pytest.mark.parametrize('node', NODES)
def test_a_waiting_tool_call_goes_before_batches_that_arrive_after_it(node):
    gate = _Gate('chunks')
    IGlobal, IInstance = _node_classes(node)
    glb = IGlobal()
    glb.embedding = FakeEmbedding(hook=gate.hook)
    ingest, later, tools = _instance(IInstance, glb), _instance(IInstance, glb), _instance(IInstance, glb)

    flush, _ = _in_thread(lambda: _flush_documents(node, ingest))
    assert gate.entered.wait(10)
    call, call_box = _in_thread(lambda: _invoke(tools, {'texts': ['waiting']}))
    _until(lambda: _embed_tool().embed_lock_of(glb).exclusive_waiters == 1, 'the tool call waits on the lock')
    question, _ = _in_thread(lambda: later.writeQuestions(_question('arrived later')))
    question.join(0.2)
    assert question.is_alive(), 'a batch arriving while a tool call waits must queue behind it'

    gate.release.set()
    for thread in (flush, call, question):
        thread.join(10)

    assert call_box['result']['success'] is True
    assert gate.events == [
        'chunks:start',
        'chunks:end',
        'question:start',  # the tool call
        'question:end',
        'question:start',  # the batch that arrived after it
        'question:end',
    ]


@pytest.mark.parametrize('node', NODES)
def test_embed_lock_lives_on_the_global(node):
    et = _embed_tool()
    IGlobal, IInstance = _node_classes(node)
    glb = IGlobal()
    glb.embedding = FakeEmbedding()
    first, second = _instance(IInstance, glb), _instance(IInstance, glb)

    lock = et.embed_lock_of(glb)

    assert isinstance(lock, et.EmbedLock)
    assert glb.embed_lock is lock
    assert et.embed_lock_of(glb) is lock
    assert et.embed_lock_of(IGlobal()) is not lock
    with first._embed_batch(), second._embed_batch():
        assert not lock.acquire_exclusive(timeout=0.01), 'a batch in progress keeps the tool out'
    assert lock.acquire_exclusive(timeout=1)
    lock.release_exclusive()


def test_embed_lock_unit():
    lock = _embed_tool().EmbedLock()

    with lock.shared():
        with lock.shared():
            assert not lock.acquire_exclusive(timeout=0.01)
    assert lock.acquire_exclusive(timeout=0.01)
    assert not lock.acquire_exclusive(timeout=0.01), 'exclusive excludes exclusive'
    entered = threading.Event()

    def batch() -> None:
        with lock.shared():
            entered.set()

    thread, _ = _in_thread(batch)
    assert not entered.wait(0.1), 'exclusive excludes batches'
    lock.release_exclusive()
    assert entered.wait(5)
    thread.join(5)


def test_a_timed_out_tool_wait_does_not_hold_up_later_batches():
    lock = _embed_tool().EmbedLock()
    entered = threading.Event()

    with lock.shared():
        assert not lock.acquire_exclusive(timeout=0.05)
        assert lock.exclusive_waiters == 0

        def batch() -> None:
            with lock.shared():
                entered.set()

        thread, _ = _in_thread(batch)
        assert entered.wait(5), 'the abandoned exclusive wait must not keep blocking new batches'
        thread.join(5)


def test_a_call_that_cannot_get_the_model_in_time_answers_busy_and_keeps_its_token(monkeypatch):
    et = _embed_tool()
    clock = FakeClock()
    inst, glb = _make(clock=clock)
    monkeypatch.setattr(et, 'EMBED_LOCK_WAIT_S', 0.05)

    with inst._embed_batch():  # a batch that outlasts the wait
        out = _invoke(inst, {'texts': ['q']})

    _assert_failure(out, 'BUSY')
    assert glb.embedding.calls == []
    # The refused call gave its token back: the full burst is still there.
    for _ in range(5):
        assert _invoke(inst, {'texts': ['q']})['success'] is True
    _assert_failure(_invoke(inst, {'texts': ['q']}), 'RATE_LIMITED')


def test_the_flush_still_delivers_each_batch_once():
    inst, glb = _make()
    batch = _docs(inst.maxDocuments)

    _write_documents(inst, batch)

    assert inst.delivered == batch
    assert glb.embedding.calls == [('chunks', [d.page_content for d in batch])]
    assert all(d.embedding_model == 'fake/model-v1' for d in batch)


# ---------------------------------------------------------------------------
# Live: through the engine (loads MiniLM; opt-in like the node's other live tests)
# ---------------------------------------------------------------------------

_LIVE_MODEL = 'sentence-transformers/all-MiniLM-L6-v2'


def _source(cid: str, provider: str, name: str) -> Dict[str, Any]:
    return {
        'id': cid,
        'provider': provider,
        'name': name,
        'config': {'hideForm': True, 'mode': 'Source', 'parameters': {}, 'type': provider, 'name': name},
    }


def _live_pipeline() -> Dict[str, Any]:
    """Build webhook -> embed_1 -> response (questions), with embed_1 also controlled by a Tools source."""
    return {
        'project_id': str(uuid.uuid4()),
        'source': 'webhook_1',
        'components': [
            {'id': 'webhook_1', 'provider': 'webhook', 'config': {}, 'input': []},
            _source('tools_1', 'tools', 'Tools'),
            {
                'id': 'embed_1',
                'provider': 'embedding_transformer',
                'name': 'Embedding',
                'config': {'profile': 'miniAll', 'parameters': {}},
                'input': [{'lane': 'questions', 'from': 'webhook_1'}],
                'control': [{'classType': 'tool', 'from': 'tools_1'}],
            },
            {
                'id': 'response_1',
                'provider': 'response',
                'config': {},
                'input': [{'lane': 'questions', 'from': 'embed_1'}],
            },
        ],
    }


async def _first_embed(client: Any, token: str, payload: Dict[str, Any], wait_s: float = 180.0) -> Dict[str, Any]:
    """Make the first call, retrying while the task finishes starting.

    ``use()`` can return before the Tools source has bound its data target (the
    model loads first), and a call in that window fails inside the engine.
    """
    deadline = time.monotonic() + wait_s
    while True:
        try:
            return await client.tool(token=token, tool='embed', node_id='embed_1', input=payload, timeout=120000)
        except Exception:
            if time.monotonic() > deadline:
                raise
            await asyncio.sleep(1.0)


def _cosine(a: List[float], b: List[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    return dot / (math.sqrt(sum(x * x for x in a)) * math.sqrt(sum(y * y for y in b)))


@pytest.mark.skip_node
async def test_embed_through_the_engine(client):
    pipeline = _live_pipeline()
    text = 'Where do kestrels nest in winter?'
    tokens: List[str] = []
    try:
        tools = await client.use(pipeline=pipeline, source='tools_1', ttl=0)
        tokens.append(tools['token'])

        out = await _first_embed(client, tools['token'], {'texts': [text]})
        assert set(out) == _ANSWER_KEYS, out
        assert out['success'] is True
        assert out['model'] == _LIVE_MODEL
        assert out['dimension'] == 384 and len(out['vectors'][0]) == 384
        assert out['prefix_applied'] is None

        refused = await client.tool(token=tools['token'], tool='embed', node_id='embed_1', input={'texts': []})
        assert refused['success'] is False and refused['code'] == 'INVALID_INPUT', refused

        # The burst of five (one already spent) runs out within a couple of seconds.
        limited = None
        for _ in range(12):
            answer = await client.tool(token=tools['token'], tool='embed', node_id='embed_1', input={'texts': ['x']})
            if not answer['success']:
                limited = answer
                break
        assert limited is not None and limited['code'] == 'RATE_LIMITED', limited
        assert isinstance(limited['retry_after_s'], int) and limited['retry_after_s'] >= 1

        # The vector equals the one the questions lane stamps on the same text.
        webhook = await client.use(pipeline=pipeline, source='webhook_1', ttl=0)
        tokens.append(webhook['token'])
        pipe = await client.pipe(webhook['token'], objinfo={'name': 'embed_tool_live'}, mime_type='lane/questions')
        await pipe.open()
        await pipe.write(json.dumps({'questions': [{'text': text}]}).encode('utf-8'))
        result = await pipe.close()
        lane = result['questions'][0]['questions'][0]
        assert lane['embedding_model'] == _LIVE_MODEL
        assert _cosine(out['vectors'][0], lane['embedding']) > 0.999999
    finally:
        for token in tokens:
            with suppress(Exception):
                await asyncio.wait_for(client.terminate(token), timeout=30)


def test_live_pipeline_wires_the_tools_source_to_the_embedding_node():
    components = {c['id']: c for c in _live_pipeline()['components']}

    assert components['embed_1']['control'] == [{'classType': 'tool', 'from': 'tools_1'}]
    assert components['tools_1']['provider'] == 'tools'
    assert components['response_1']['input'] == [{'lane': 'questions', 'from': 'embed_1'}]
