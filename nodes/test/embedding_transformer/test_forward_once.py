# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Delivery-count regression tests for embedding_transformer's document batching (#2051).

The engine forwards a lane handler's incoming argument after the handler returns,
unless it raised Ec.PreventDefault (__checkCallParent, engLib/python/call.hpp). The
flush path forwarded the buffer explicitly and returned normally, so every full
batch reached downstream twice.

_simulate_engine_dispatch stands in for that rule, so these assert delivery counts
rather than "the node forwarded once", which was true throughout the bug.

rocketlib and ai.common.* are stubbed and the node is loaded from source, so no
engine, server or model is involved.
"""

import importlib.util
import os
import sys
import types

_HERE = os.path.dirname(os.path.abspath(__file__))
_NODE_DIR = os.path.join(_HERE, '..', '..', 'src', 'nodes', 'embedding_transformer')
_PKG = 'embedding_transformer'


class FakeDoc:
    """Stand-in for ai.common.schema.Doc, carrying the fields the node touches."""

    def __init__(self, page_content):
        self.page_content = page_content
        self.embedding = None
        self.embedding_model = None


class FakeQuestion:
    """Stand-in for ai.common.schema.Question, passed through untouched."""


class FakeEmbeddingBase:
    """Stand-in for ai.common.embedding.EmbeddingBase, needed only by IGlobal's annotation."""


class _PreventDefaultRaised(Exception):
    """Stand-in for the real preventDefault(), which raises rather than setting a flag."""


def _simulate_engine_dispatch(write_override, default_forward):
    """Mimic checkCallParent(): the engine forwards after a handler returns, unless it raised PreventDefault."""
    try:
        write_override()
    except _PreventDefaultRaised:
        return
    default_forward()


def _load_iinstance():
    """
    Stub rocketlib and ai.common.*, then load the node's IGlobal and IInstance from source.

    Returns:
        The IInstance class. sys.modules is left as it was found.
    """
    saved = {}

    class FakeIInstanceBase:
        IGlobal = None
        instance = None

        def __init__(self):
            pass

        def preventDefault(self):
            pass

    class FakeIGlobalBase:
        glb = None
        IEndpoint = None

    class FakeEntry:
        pass

    stubs = {
        'rocketlib': types.ModuleType('rocketlib'),
        'ai': types.ModuleType('ai'),
        'ai.common': types.ModuleType('ai.common'),
        'ai.common.schema': types.ModuleType('ai.common.schema'),
        'ai.common.config': types.ModuleType('ai.common.config'),
        'ai.common.embedding': types.ModuleType('ai.common.embedding'),
    }
    stubs['rocketlib'].IInstanceBase = FakeIInstanceBase
    stubs['rocketlib'].IGlobalBase = FakeIGlobalBase
    stubs['rocketlib'].Entry = FakeEntry
    stubs['ai.common.schema'].Doc = FakeDoc
    stubs['ai.common.schema'].Question = FakeQuestion
    stubs['ai.common.embedding'].EmbeddingBase = FakeEmbeddingBase
    stubs['ai.common.config'].Config = type('FakeConfig', (), {'getNodeConfig': staticmethod(lambda lt, cc: {})})

    for name, stub in stubs.items():
        saved[name] = sys.modules.get(name)
        sys.modules[name] = stub

    # Snapshot pre-existing node modules so cleanup restores rather than clobbers them.
    saved_pkg = {k: v for k, v in sys.modules.items() if k == _PKG or k.startswith(_PKG + '.')}

    try:
        pkg_spec = importlib.util.spec_from_file_location(
            _PKG, os.path.join(_NODE_DIR, '__init__.py'), submodule_search_locations=[_NODE_DIR]
        )
        # Registered but not executed: the relative imports only need the package to exist.
        sys.modules[_PKG] = importlib.util.module_from_spec(pkg_spec)

        for sub in ('IGlobal', 'IInstance'):
            spec = importlib.util.spec_from_file_location(f'{_PKG}.{sub}', os.path.join(_NODE_DIR, f'{sub}.py'))
            mod = importlib.util.module_from_spec(spec)
            sys.modules[f'{_PKG}.{sub}'] = mod
            spec.loader.exec_module(mod)

        return sys.modules[f'{_PKG}.IInstance'].IInstance
    finally:
        for name in stubs:
            if saved[name] is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = saved[name]
        for mod_name in [k for k in sys.modules if k == _PKG or k.startswith(_PKG + '.')]:
            sys.modules.pop(mod_name, None)
        sys.modules.update(saved_pkg)


def _make_instance():
    """
    Build an IInstance wired to fakes.

    Returns:
        (inst, delivered, encoded): docs that reached the next node, and one entry
        per batch sent to the embedding.
    """
    inst = _load_iinstance()()

    delivered = []
    encoded = []

    inst.IGlobal = types.SimpleNamespace(
        embedding=types.SimpleNamespace(
            encodeChunks=lambda docs: encoded.append(list(docs)),
            encodeQuestion=lambda question: encoded.append(question),
        )
    )
    inst.instance = types.SimpleNamespace(writeDocuments=lambda docs: delivered.extend(docs))
    inst.preventDefault = lambda: (_ for _ in ()).throw(_PreventDefaultRaised())

    # The engine calls open() per object; without it self.documents is the class-level list.
    inst.open(None)

    return inst, delivered, encoded


def _docs(count, start=0):
    """Build count fake chunks, labelled from start so ordering is checkable."""
    return [FakeDoc(f'chunk-{start + i}') for i in range(count)]


def _write(inst, delivered, batch):
    """Dispatch writeDocuments(batch) the way the engine would."""
    _simulate_engine_dispatch(lambda: inst.writeDocuments(batch), lambda: delivered.extend(batch))


def test_partial_batch_is_buffered_and_delivers_nothing():
    inst, delivered, encoded = _make_instance()
    batch = _docs(10)

    _write(inst, delivered, batch)

    assert delivered == []
    assert encoded == []
    assert inst.documents == batch


def test_full_batch_is_delivered_exactly_once():
    """A full batch in one call, the common path and the #2051 path."""
    inst, delivered, encoded = _make_instance()
    batch = _docs(inst.maxDocuments)

    _write(inst, delivered, batch)

    assert delivered == batch, (
        f'delivered {len(delivered)} documents for a batch of {len(batch)}. The flush forwards the '
        f'buffer explicitly, so writeDocuments must raise preventDefault() or the engine forwards '
        f'the incoming batch on top of it'
    )
    assert encoded == [batch]
    assert inst.documents == []


def test_oversized_batch_is_delivered_exactly_once():
    inst, delivered, encoded = _make_instance()
    batch = _docs(inst.maxDocuments * 2 + 1)

    _write(inst, delivered, batch)

    assert delivered == batch
    assert encoded == [batch]
    assert inst.documents == []


def test_documents_accumulate_across_calls_and_flush_once():
    """Three quarter-batches buffer silently, the fourth flushes all of them."""
    inst, delivered, encoded = _make_instance()
    quarter = inst.maxDocuments // 4
    batches = [_docs(quarter, start=i * quarter) for i in range(4)]

    for batch in batches[:-1]:
        _write(inst, delivered, batch)
        assert delivered == []

    _write(inst, delivered, batches[-1])

    expected = [doc for batch in batches for doc in batch]
    assert delivered == expected
    assert encoded == [expected]


def test_second_full_batch_does_not_redeliver_the_first():
    inst, delivered, encoded = _make_instance()
    first = _docs(inst.maxDocuments)
    second = _docs(inst.maxDocuments, start=inst.maxDocuments)

    _write(inst, delivered, first)
    _write(inst, delivered, second)

    assert delivered == first + second
    assert encoded == [first, second]


def test_close_flushes_stragglers_exactly_once_and_still_closes():
    """
    Below the threshold nothing flushes until close().

    close() must not raise PreventDefault: the parent call it would suppress is
    Parent::close(), and every downstream node would be left open.
    """
    inst, delivered, encoded = _make_instance()
    batch = _docs(3)
    _write(inst, delivered, batch)
    assert delivered == []

    closed = []
    _simulate_engine_dispatch(inst.close, lambda: closed.append('parent-close'))

    assert delivered == batch
    assert encoded == [batch]
    assert closed == ['parent-close'], 'close() suppressed Parent::close(); downstream never closes'


def test_close_with_empty_buffer_delivers_nothing_and_still_closes():
    inst, delivered, encoded = _make_instance()

    closed = []
    _simulate_engine_dispatch(inst.close, lambda: closed.append('parent-close'))

    assert (delivered, encoded, closed) == ([], [], ['parent-close'])


def test_write_questions_relies_on_the_engine_default_forward():
    """
    The questions lane mutates in place and forwards nothing of its own.

    Pinned so the documents-lane fix is not copied onto this lane, which would
    drop every question instead of delivering it once.
    """
    inst, _, encoded = _make_instance()
    question = FakeQuestion()

    forwarded = []
    _simulate_engine_dispatch(lambda: inst.writeQuestions(question), lambda: forwarded.append(question))

    assert encoded == [question]
    assert forwarded == [question]
