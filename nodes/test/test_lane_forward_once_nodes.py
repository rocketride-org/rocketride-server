# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Delivery-count regression tests for the lane-forwarding contract (#2041).

The engine forwards a lane handler's incoming argument after the handler returns,
unless it raised Ec.PreventDefault (__checkCallParent, engLib/python/call.hpp).
Seven handlers across five nodes forwarded explicitly and returned normally, so the
payload they forwarded reached downstream twice. For the nodes that forward an enriched or converted
copy, the second delivery was the unmodified original.

_simulate_engine_dispatch stands in for that rule, so these assert delivery counts
rather than "the node forwarded once", which was true throughout the bug.

Each node is loaded from source with rocketlib and ai.common.* stubbed, including a
stub for the node's own IGlobal module, so no API key, model or SDK is involved.
"""

import contextlib
import importlib.util
import os
import sys
import types

_HERE = os.path.dirname(os.path.abspath(__file__))
_NODES_DIR = os.path.join(_HERE, '..', 'src', 'nodes')


class _PreventDefaultRaised(Exception):
    """Stand-in for the real preventDefault(), which raises rather than setting a flag."""


def _simulate_engine_dispatch(write_override, default_forward):
    """Mimic checkCallParent(): the engine forwards after a handler returns, unless it raised."""
    try:
        write_override()
    except _PreventDefaultRaised:
        return
    default_forward()


class FakeMetadata:
    """Stand-in for DocMetadata: attribute assignment plus model_dump()."""

    def __init__(self, **kwargs):
        self.chunkId = 0
        for key, value in kwargs.items():
            setattr(self, key, value)

    def model_dump(self):
        """Return the metadata fields as a plain dict."""
        return dict(self.__dict__)


class FakeDoc:
    """Stand-in for ai.common.schema.Doc, carrying the fields these nodes touch."""

    def __init__(self, type='Document', page_content='', metadata=None):
        self.type = type
        self.page_content = page_content
        self.metadata = metadata

    def model_copy(self, deep=False):
        """Return a copy, deep-copying metadata when asked, like pydantic does."""
        meta = self.metadata
        if deep and isinstance(meta, FakeMetadata):
            meta = FakeMetadata(**meta.model_dump())
        return FakeDoc(type=self.type, page_content=self.page_content, metadata=meta)


class FakeQuestion:
    """Stand-in for ai.common.schema.Question."""

    def __init__(self):
        self.context = []
        self.questions = []

    def addContext(self, value):
        """Attach context to the question."""
        self.context.append(value)

    def addQuestion(self, value):
        """Attach question text."""
        self.questions.append(value)


class FakeInstance:
    """
    Stand-in for the engine-side instance handle.

    Records every explicit forward per lane and answers hasListener() from a fixed set,
    so gated forwards can be exercised on both branches.
    """

    def __init__(self, listeners=None):
        self.listeners = set(listeners) if listeners is not None else None
        self.delivered = {}

    def hasListener(self, lane):
        """Report whether the given lane has a downstream listener."""
        return True if self.listeners is None else lane in self.listeners

    def _record(self, lane, payload):
        """Append a forwarded payload to the lane's delivery list."""
        self.delivered.setdefault(lane, []).extend(payload)

    def writeText(self, text):
        """Record an explicit forward on the text lane."""
        self._record('text', [text])

    def writeTable(self, table):
        """Record an explicit forward on the table lane."""
        self._record('table', [table])

    def writeDocuments(self, documents):
        """Record an explicit forward on the documents lane."""
        self._record('documents', list(documents))

    def writeQuestions(self, question):
        """Record an explicit forward on the questions lane."""
        self._record('questions', [question])

    def writeAnswers(self, answer):
        """Record an explicit forward on the answers lane."""
        self._record('answers', [answer])


class _FakeIInstanceBase:
    """Stand-in for rocketlib.IInstanceBase whose preventDefault() raises, like the real one."""

    IGlobal = None
    instance = None

    def __init__(self):
        pass

    def preventDefault(self):
        """Raise, as the real implementation does."""
        raise _PreventDefaultRaised()


def _make_stubs():
    """Build the rocketlib and ai.common.* stub modules these nodes import."""

    class FakeEntry:
        """Stand-in for rocketlib.Entry."""

        pass

    class FakeAviAction:
        """Stand-in for rocketlib.AVI_ACTION."""

        BEGIN = 0
        WRITE = 1
        END = 2

    stubs = {
        'rocketlib': types.ModuleType('rocketlib'),
        'ai': types.ModuleType('ai'),
        'ai.common': types.ModuleType('ai.common'),
        'ai.common.schema': types.ModuleType('ai.common.schema'),
        'ai.common.llm_base': types.ModuleType('ai.common.llm_base'),
        'ai.common.avi': types.ModuleType('ai.common.avi'),
        'ai.common.avi.descriptor': types.ModuleType('ai.common.avi.descriptor'),
    }
    stubs['rocketlib'].IInstanceBase = _FakeIInstanceBase
    stubs['rocketlib'].Entry = FakeEntry
    stubs['rocketlib'].AVI_ACTION = FakeAviAction
    stubs['rocketlib'].debug = lambda *a, **kw: None
    stubs['rocketlib'].warning = lambda *a, **kw: None
    stubs['ai.common.schema'].Doc = FakeDoc
    stubs['ai.common.schema'].Question = FakeQuestion
    stubs['ai.common.llm_base'].LLMBase = _FakeIInstanceBase
    stubs['ai.common.avi.descriptor'].rename_ext = lambda metadata, ext: metadata
    return stubs


@contextlib.contextmanager
def stubbed_modules():
    """
    Install the stubs for the duration of the block, then restore sys.modules exactly.

    Needed around execution as well as import: llm_vision_mistral.writeDocuments imports
    ai.common.schema inside the method body. _sys_modules_guard.py fails the whole session
    if a stub is left behind, hence the unconditional restore.
    """
    stubs = _make_stubs()
    saved = {name: sys.modules.get(name) for name in stubs}
    sys.modules.update(stubs)
    try:
        yield
    finally:
        for name in stubs:
            if saved[name] is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = saved[name]


def _load_iinstance(pkg):
    """
    Load a node's IInstance class from source with its dependencies stubbed.

    The node's own IGlobal module is stubbed rather than executed, which keeps every
    API key, model loader and vendor SDK out of the test.

    Args:
        pkg: Node package name, e.g. 'ner'.

    Returns:
        The IInstance class. sys.modules is left as it was found.
    """
    node_dir = os.path.join(_NODES_DIR, pkg)

    # Snapshot pre-existing node modules so cleanup restores rather than clobbers them.
    saved_pkg = {k: v for k, v in sys.modules.items() if k == pkg or k.startswith(pkg + '.')}

    with stubbed_modules():
        try:
            pkg_spec = importlib.util.spec_from_file_location(
                pkg, os.path.join(node_dir, '__init__.py'), submodule_search_locations=[node_dir]
            )
            # Registered but not executed: the relative imports only need the package to exist.
            sys.modules[pkg] = importlib.util.module_from_spec(pkg_spec)

            # Stub the node's own IGlobal so its dependencies are never imported.
            iglobal_stub = types.ModuleType(f'{pkg}.IGlobal')
            iglobal_stub.IGlobal = type('FakeIGlobal', (), {})
            sys.modules[f'{pkg}.IGlobal'] = iglobal_stub

            spec = importlib.util.spec_from_file_location(f'{pkg}.IInstance', os.path.join(node_dir, 'IInstance.py'))
            mod = importlib.util.module_from_spec(spec)
            sys.modules[f'{pkg}.IInstance'] = mod
            spec.loader.exec_module(mod)

            return mod.IInstance
        finally:
            for mod_name in [k for k in sys.modules if k == pkg or k.startswith(pkg + '.')]:
                sys.modules.pop(mod_name, None)
            sys.modules.update(saved_pkg)


def _build(pkg, iglobal, listeners=None):
    """
    Build a node instance wired to fakes.

    Args:
        pkg: Node package name.
        iglobal: Object assigned to inst.IGlobal.
        listeners: Lanes hasListener() reports; None means every lane is connected.

    Returns:
        (inst, fake_instance).
    """
    inst = _load_iinstance(pkg)()
    inst.IGlobal = iglobal
    inst.instance = FakeInstance(listeners)
    return inst, inst.instance


# ============================================================================
# anomaly_detector: both handlers forward on two branches, so both must suppress
# ============================================================================


class _StubDetector:
    """Annotates text and scores documents the way AnomalyDetector does."""

    def evaluate_text(self, text):
        """Annotate the text so a duplicate delivery is distinguishable."""
        return f'{text} [ANOMALY: yes]'

    def evaluate_document(self, metadata_dict):
        """Return a fixed anomaly result."""
        return {'score': 1.0, 'severity': 'high', 'is_anomalous': True, 'details': 'stub'}


def _anomaly(detector, listeners=None):
    """Build an anomaly_detector instance with the given detector."""
    return _build('anomaly_detector', types.SimpleNamespace(detector=detector), listeners)


def test_anomaly_detector_text_delivered_once():
    """The annotated result is delivered, and the unannotated original is not."""
    inst, fake = _anomaly(_StubDetector())

    delivered = []
    _simulate_engine_dispatch(lambda: inst.writeText('cpu 900'), lambda: delivered.append('cpu 900'))
    delivered.extend(fake.delivered.get('text', []))

    assert delivered == ['cpu 900 [ANOMALY: yes]'], (
        f'text lane delivered {delivered}. Both the annotated result and the original arrive '
        f'unless writeText suppresses the engine default forward'
    )


def test_anomaly_detector_text_delivered_once_without_detector():
    """The detector-is-None branch forwards too, so it needs its own suppression."""
    inst, fake = _anomaly(None)

    delivered = []
    _simulate_engine_dispatch(lambda: inst.writeText('cpu 900'), lambda: delivered.append('cpu 900'))
    delivered.extend(fake.delivered.get('text', []))

    assert delivered == ['cpu 900']


def test_anomaly_detector_documents_delivered_once():
    """Only the enriched copy arrives, never the un-enriched original."""
    inst, fake = _anomaly(_StubDetector())
    docs = [FakeDoc(page_content='a', metadata=FakeMetadata())]

    delivered = []
    _simulate_engine_dispatch(lambda: inst.writeDocuments(docs), lambda: delivered.extend(docs))
    delivered.extend(fake.delivered.get('documents', []))

    assert len(delivered) == 1, f'documents lane delivered {len(delivered)} docs for an input of 1'
    assert delivered[0] is not docs[0], 'the original document was delivered instead of the enriched copy'
    assert delivered[0].metadata.anomaly_severity == 'high'


def test_anomaly_detector_documents_delivered_once_without_detector():
    """The detector-is-None branch forwards documents too, so it needs its own suppression."""
    inst, fake = _anomaly(None)
    docs = [FakeDoc(page_content='a')]

    delivered = []
    _simulate_engine_dispatch(lambda: inst.writeDocuments(docs), lambda: delivered.extend(docs))
    delivered.extend(fake.delivered.get('documents', []))

    assert delivered == docs


# ============================================================================
# ner
# ============================================================================


class _StubRecognizer:
    """Stand-in for the GLiNER-backed recognizer."""

    store_in_metadata = True

    def extract_entities(self, text):
        """Return one fixed entity."""
        return [{'entity_group': 'PER', 'word': 'Obama'}]


def _ner():
    """Build a ner instance with a stub recognizer."""
    return _build('ner', types.SimpleNamespace(recognizer=_StubRecognizer()))


def test_ner_text_delivered_once():
    """This lane passes the original text through, so the only defect is duplication."""
    inst, fake = _ner()

    delivered = []
    _simulate_engine_dispatch(lambda: inst.writeText('Obama'), lambda: delivered.append('Obama'))
    delivered.extend(fake.delivered.get('text', []))

    assert delivered == ['Obama']


def test_ner_documents_delivered_once():
    """
    Only the enriched copy arrives.

    Docs carry no metadata here: that is the path that works today. Assigning into
    DocMetadata by subscript raises TypeError, tracked separately.
    """
    inst, fake = _ner()
    docs = [FakeDoc(page_content='Obama')]

    delivered = []
    _simulate_engine_dispatch(lambda: inst.writeDocuments(docs), lambda: delivered.extend(docs))
    delivered.extend(fake.delivered.get('documents', []))

    assert len(delivered) == 1, (
        f'documents lane delivered {len(delivered)} docs for an input of 1. The README promises '
        f'enriched copies downstream, but the engine default forward also delivers the originals'
    )
    assert delivered[0] is not docs[0]
    assert delivered[0].metadata['entities_per'] == ['Obama']


# ============================================================================
# search_exa: gated passthrough on its own questions lane
# ============================================================================


class _StubAnswer:
    """Stand-in for an Answer carrying text."""

    def getText(self):
        """Return the answer text."""
        return 'exa answer'


class _StubSearch:
    """Stand-in for the Exa search backend."""

    def chat(self, question):
        """Return a fixed answer without calling any service."""
        return _StubAnswer()


def _search_exa(listeners):
    """Build a search_exa instance with the given connected lanes."""
    return _build('search_exa', types.SimpleNamespace(search=_StubSearch()), listeners)


def test_search_exa_question_delivered_once_with_listener():
    """With a questions listener connected, the passthrough must arrive once."""
    inst, fake = _search_exa({'questions', 'answers', 'text'})
    question = FakeQuestion()

    delivered = []
    _simulate_engine_dispatch(lambda: inst.writeQuestions(question), lambda: delivered.append(question))
    delivered.extend(fake.delivered.get('questions', []))

    assert delivered == [question], (
        f'questions lane delivered {len(delivered)} copies. The passthrough at the end of '
        f'writeQuestions is on its own lane, so the engine must be told to skip its forward'
    )


def test_search_exa_question_not_delivered_without_listener():
    """With no questions listener, suppressing costs nothing: the default had nowhere to go."""
    inst, fake = _search_exa({'answers'})
    question = FakeQuestion()

    delivered = []
    _simulate_engine_dispatch(lambda: inst.writeQuestions(question), lambda: delivered.append(question))
    delivered.extend(fake.delivered.get('questions', []))

    assert delivered == []
    assert len(fake.delivered.get('answers', [])) == 1


def test_search_exa_error_suppresses_without_preventdefault():
    """A raised error already suppresses the parent forward, so those paths need nothing."""
    inst, _ = _build('search_exa', types.SimpleNamespace(search=None))

    delivered = []
    try:
        _simulate_engine_dispatch(lambda: inst.writeQuestions(FakeQuestion()), lambda: delivered.append('default'))
    except RuntimeError:
        pass

    assert delivered == []


# ============================================================================
# llamaparse: writeTable only
# ============================================================================


def _llamaparse(listeners):
    """Build a llamaparse instance with the given connected lanes."""
    inst, fake = _build('llamaparse', types.SimpleNamespace(), listeners)
    inst._current_object = None
    return inst, fake


def test_llamaparse_table_delivered_once_with_listener():
    """With a table listener connected, the table must arrive once."""
    inst, fake = _llamaparse({'table'})

    delivered = []
    _simulate_engine_dispatch(lambda: inst.writeTable('| a |'), lambda: delivered.append('| a |'))
    delivered.extend(fake.delivered.get('table', []))

    assert delivered == ['| a |']


def test_llamaparse_table_not_delivered_without_listener():
    """Without a table listener, nothing is delivered and suppression costs nothing."""
    inst, fake = _llamaparse(set())

    delivered = []
    _simulate_engine_dispatch(lambda: inst.writeTable('| a |'), lambda: delivered.append('| a |'))
    delivered.extend(fake.delivered.get('table', []))

    assert delivered == []


# ============================================================================
# llm_vision_mistral: converted docs plus untouched passthrough
# ============================================================================


class _StubChat:
    """Stand-in for the Mistral vision chat backend."""

    _prompt = 'describe'

    def chat(self, question):
        """Return a fixed answer without calling any service."""
        return _StubAnswer()


def _mistral():
    """Build a llm_vision_mistral instance with a stub chat backend."""
    return _build('llm_vision_mistral', types.SimpleNamespace(_chat=_StubChat()))


def test_mistral_converted_document_delivered_once():
    """An image yields one converted Text doc, not the conversion plus the original."""
    inst, fake = _mistral()
    docs = [FakeDoc(type='Image', page_content='aGk=', metadata=FakeMetadata())]

    delivered = []
    with stubbed_modules():
        _simulate_engine_dispatch(lambda: inst.writeDocuments(docs), lambda: delivered.extend(docs))
    delivered.extend(fake.delivered.get('documents', []))

    assert len(delivered) == 1, (
        f'documents lane delivered {len(delivered)} docs for one image. The converted Text doc '
        f'and the original Image doc both arrive unless the default forward is suppressed'
    )
    assert delivered[0].type == 'Text'
    assert delivered[0].page_content == 'exa answer'


def test_mistral_skipped_document_is_not_delivered():
    """Non-Image docs are dropped, matching llm_vision_openai, ollama and gemini."""
    inst, fake = _mistral()
    docs = [FakeDoc(type='Document', page_content='plain text')]

    delivered = []
    with stubbed_modules():
        _simulate_engine_dispatch(lambda: inst.writeDocuments(docs), lambda: delivered.extend(docs))
    delivered.extend(fake.delivered.get('documents', []))

    assert delivered == [], (
        f'a skipped document reached downstream {len(delivered)} times. The other llm_vision_* '
        f'nodes drop what they do not convert, so the original must not flow on'
    )


def test_mistral_mixed_batch_delivers_each_document_once():
    """A mixed batch delivers only the converted doc; the unconvertible one is dropped."""
    inst, fake = _mistral()
    image = FakeDoc(type='Image', page_content='aGk=', metadata=FakeMetadata())
    other = FakeDoc(type='Document', page_content='plain text')
    docs = [image, other]

    delivered = []
    with stubbed_modules():
        _simulate_engine_dispatch(lambda: inst.writeDocuments(docs), lambda: delivered.extend(docs))
    delivered.extend(fake.delivered.get('documents', []))

    assert len(delivered) == 1, f'expected only the converted document, got {len(delivered)}'
    assert [d.type for d in delivered] == ['Text']
