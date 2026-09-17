# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Standalone unit tests for the Summarization node.

rocketlib and ai.common.* are stubbed, IInstance.py is loaded from source, and the
engine collaborator (self.instance) is a fake that answers the LLM invokes and
records what the node writes. No running server and no model are required.

Asserts:
  (a) text and table input are buffered per object, and ``open`` starts over,
  (b) the lane handlers stop the engine forwarding the raw input,
  (c) ``closing`` formats summary, key points and entities onto the text lane,
  (d) ``closing`` emits one document per section onto the documents lane,
  (e) only the configured number of chunks is summarized, and disabled
      sections are left out.
"""

from __future__ import annotations

import importlib.util
import os
import sys
import types

import pytest

_HERE = os.path.dirname(os.path.abspath(__file__))
_NODE_DIR = os.path.join(_HERE, '..', '..', 'src', 'nodes', 'summarization')

# The fake splitter cuts the text here, so a test controls the chunk count.
_CHUNK_BREAK = '||'


class _PreventDefault(Exception):
    """Raised by the stub preventDefault(); the real one raises APERR(Ec.PreventDefault)."""


class _FakeIInstanceBase:
    """Stand-in for rocketlib.IInstanceBase."""

    IGlobal = None
    instance = None

    def preventDefault(self):
        """Raise, as the real implementation does."""
        raise _PreventDefault()


class _FakeIInvokeLLM:
    """Stand-in for rocketlib.types.IInvokeLLM: each request is a tagged tuple."""

    @staticmethod
    def Ask(question):
        """Build an ask request.

        Args:
            question: The question to ask.

        Returns:
            ('ask', question).
        """
        return ('ask', question)

    @staticmethod
    def GetContextLength():
        """Build a context-length request."""
        return ('context_length',)

    @staticmethod
    def GetTokenCounter():
        """Build a token-counter request."""
        return ('token_counter',)


class _FakeQuestion:
    """Stand-in for ai.common.schema.Question, with the methods the node calls."""

    def __init__(self, **kwargs):
        """Create an empty question.

        Args:
            **kwargs: Model fields; only ``role`` is kept.
        """
        self.role = kwargs.get('role', '')
        self.instructions = []
        self.context = []
        self.expectJson = False

    def addInstruction(self, title, instruction):
        """Record an instruction by its title.

        Args:
            title: The instruction's title.
            instruction: The instruction text (not kept).
        """
        self.instructions.append(title)

    def addContext(self, context):
        """Record a context block.

        Args:
            context: The context text.
        """
        self.context.append(context)

    def getPrompt(self):
        """Render the parts the token counter measures."""
        return ' '.join([self.role, *self.instructions, *self.context])


class _FakeMetadata:
    """Stand-in for ai.common.schema.DocMetadata."""

    def __init__(self, pInstance=None, **kwargs):
        """Keep the metadata fields.

        Args:
            pInstance: The node instance (unused).
            **kwargs: Metadata fields.
        """
        self.__dict__.update(kwargs)


class _FakeDoc:
    """Stand-in for ai.common.schema.Doc."""

    def __init__(self, page_content='', type='Document', metadata=None):
        """Keep the document fields.

        Args:
            page_content: The document text.
            type: The document type.
            metadata: The document metadata.
        """
        self.page_content = page_content
        self.type = type
        self.metadata = metadata


class _FakeSplitter:
    """Stand-in for langchain's RecursiveCharacterTextSplitter."""

    def __init__(self, chunk_size, length_function):
        """Keep the splitter settings.

        Args:
            chunk_size: Maximum chunk size.
            length_function: Callable that measures a chunk.
        """
        self.chunk_size = chunk_size
        self.length_function = length_function

    def split_text(self, text):
        """Split on the test's chunk marker.

        Args:
            text: The text to split.

        Returns:
            The chunks.
        """
        return text.split(_CHUNK_BREAK)


def _load_iinstance_class():
    """Load summarization's IInstance from source with its dependencies stubbed.

    Returns:
        The IInstance class. sys.modules is left as it was found.
    """
    stubs = {
        'rocketlib': types.ModuleType('rocketlib'),
        'rocketlib.types': types.ModuleType('rocketlib.types'),
        'ai': types.ModuleType('ai'),
        'ai.common': types.ModuleType('ai.common'),
        'ai.common.schema': types.ModuleType('ai.common.schema'),
    }
    stubs['rocketlib'].IInstanceBase = _FakeIInstanceBase
    stubs['rocketlib'].Entry = object
    stubs['rocketlib.types'].IInvokeLLM = _FakeIInvokeLLM
    stubs['ai.common.schema'].Question = _FakeQuestion
    stubs['ai.common.schema'].QuestionType = types.SimpleNamespace(QUESTION='question')
    stubs['ai.common.schema'].Answer = object
    stubs['ai.common.schema'].Doc = _FakeDoc
    stubs['ai.common.schema'].DocMetadata = _FakeMetadata

    pkg = 'summarization_node'
    saved = {name: sys.modules.get(name) for name in stubs}
    sys.modules.update(stubs)
    try:
        pkg_spec = importlib.util.spec_from_file_location(
            pkg, os.path.join(_NODE_DIR, '__init__.py'), submodule_search_locations=[_NODE_DIR]
        )
        sys.modules[pkg] = importlib.util.module_from_spec(pkg_spec)

        # Stub the node's own IGlobal so its dependencies are never imported.
        iglobal_stub = types.ModuleType(f'{pkg}.IGlobal')
        iglobal_stub.IGlobal = type('FakeIGlobal', (), {})
        sys.modules[f'{pkg}.IGlobal'] = iglobal_stub

        spec = importlib.util.spec_from_file_location(f'{pkg}.IInstance', os.path.join(_NODE_DIR, 'IInstance.py'))
        mod = importlib.util.module_from_spec(spec)
        sys.modules[f'{pkg}.IInstance'] = mod
        spec.loader.exec_module(mod)
        return mod.IInstance
    finally:
        for name in stubs:
            if saved[name] is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = saved[name]
        for name in [k for k in sys.modules if k == pkg or k.startswith(pkg + '.')]:
            sys.modules.pop(name, None)


class _FakeEngine:
    """The node's self.instance: answers LLM invokes and records every write."""

    def __init__(self, listeners, results):
        """Set up the engine side.

        Args:
            listeners: Output lanes getListeners() reports.
            results: JSON results the LLM returns, one per ask, in order.
        """
        self.listeners = list(listeners)
        self.results = list(results)
        self.asked = []
        self.text = []
        self.documents = []

    def getListeners(self):
        """Return the connected output lanes."""
        return self.listeners

    def invoke(self, request):
        """Answer an IInvokeLLM request.

        Args:
            request: A tuple built by _FakeIInvokeLLM.

        Returns:
            The context length, a token counter, or an answer with getJson().
        """
        kind = request[0]
        if kind == 'context_length':
            return 1000
        if kind == 'token_counter':
            return lambda text: len(text.split())
        self.asked.append(request[1])
        result = self.results[len(self.asked) - 1]
        return types.SimpleNamespace(getJson=lambda: result)

    def writeText(self, text):
        """Record a write on the text lane.

        Args:
            text: The text written.
        """
        self.text.append(text)

    def writeDocuments(self, documents):
        """Record a write on the documents lane.

        Args:
            documents: The documents written.
        """
        self.documents.extend(documents)


def _config(**overrides):
    """Build IGlobal settings with the node's defaults.

    Args:
        **overrides: Settings to change.

    Returns:
        A namespace with the four summarization settings.
    """
    values = {
        'numberOfSummaries': 2,
        'numberOfSummaryWords': 1500,
        'numberOfKeyPointWords': 250,
        'numberOfEntities': 25,
    }
    values.update(overrides)
    return types.SimpleNamespace(**values)


@pytest.fixture
def build():
    """Return a factory for an opened IInstance wired to a fake engine."""

    def _build(listeners=('text',), results=(), **config):
        """Build an opened instance.

        Args:
            listeners: Output lanes the engine reports.
            results: JSON results the LLM returns, in order.
            **config: IGlobal settings to change.

        Returns:
            (inst, engine).
        """
        inst = _load_iinstance_class()()
        inst.IGlobal = _config(**config)
        inst.instance = _FakeEngine(listeners, results)
        inst.beginInstance()
        inst.open(None)
        return inst, inst.instance

    return _build


@pytest.fixture
def splitter():
    """Make ``from langchain_text_splitters import ...`` inside closing() load the fake."""
    saved = sys.modules.get('langchain_text_splitters')
    module = types.ModuleType('langchain_text_splitters')
    module.RecursiveCharacterTextSplitter = _FakeSplitter
    sys.modules['langchain_text_splitters'] = module
    yield
    if saved is None:
        sys.modules.pop('langchain_text_splitters', None)
    else:
        sys.modules['langchain_text_splitters'] = saved


def _write(handler, value):
    """Call a buffering lane handler, which must end in preventDefault().

    Args:
        handler: The bound handler, e.g. inst.writeText.
        value: The value to write.
    """
    with pytest.raises(_PreventDefault):
        handler(value)


_RESULT = {'summary': 'A short summary.', 'keyPoints': ['first point', 'second point'], 'entities': ['Acme', 'Bob']}


# ---------------------------------------------------------------------------
# Lane handlers
# ---------------------------------------------------------------------------


def test_text_and_table_are_buffered_and_not_passed_through(build):
    """Text and table input join one buffer, and each write suppresses the raw forward.

    Args:
        build: Instance factory fixture.
    """
    inst, _ = build()
    _write(inst.writeText, 'Hello ')
    _write(inst.writeTable, '| a | b |')
    _write(inst.writeText, ' world')
    assert inst.text == 'Hello | a | b | world'


def test_open_starts_a_new_document(build):
    """Opening the next object drops the previous object's text.

    Args:
        build: Instance factory fixture.
    """
    inst, _ = build()
    _write(inst.writeText, 'first object')
    inst.open(None)
    assert inst.text == ''


# ---------------------------------------------------------------------------
# closing()
# ---------------------------------------------------------------------------


def test_closing_writes_all_sections_to_the_text_lane(build, splitter):
    """Summary, key points (plain and titled) and entities are written as one text.

    Args:
        build: Instance factory fixture.
        splitter: Fixture that installs the fake text splitter.
    """
    result = {**_RESULT, 'keyPoints': ['plain point', {'title': 'Titled', 'summary': 'with detail'}]}
    inst, engine = build(listeners=['text'], results=[result])
    _write(inst.writeText, 'the whole document')

    inst.closing()

    assert len(engine.text) == 1
    text = engine.text[0]
    assert '    A short summary.' in text
    assert '   - plain point\n' in text
    assert '   - Titled: with detail\n' in text
    assert '   -Acme\n' in text and '   -Bob\n' in text
    assert text.index('A short summary.') < text.index('plain point') < text.index('Acme')
    assert engine.documents == []
    assert engine.asked[0].context == ['the whole document']
    assert engine.asked[0].expectJson is True


def test_closing_writes_one_document_per_section(build, splitter):
    """The documents lane gets a summary, a key-points and an entities document.

    Args:
        build: Instance factory fixture.
        splitter: Fixture that installs the fake text splitter.
    """
    inst, engine = build(listeners=['documents'], results=[_RESULT])
    _write(inst.writeText, 'the whole document')

    inst.closing()

    assert engine.text == []
    summary, key_points, entities = [doc.page_content for doc in engine.documents]
    assert summary == 'Summary:\nA short summary.\n'
    assert key_points.startswith('Key Points:')
    assert '- first point\n' in key_points and '- second point\n' in key_points
    assert entities == 'Entities:\n- Acme\n- Bob\n'
    assert all(doc.type == 'Document' for doc in engine.documents)


def test_closing_summarizes_only_the_configured_number_of_chunks(build, splitter):
    """Chunks past numberOfSummaries are never sent to the LLM.

    Args:
        build: Instance factory fixture.
        splitter: Fixture that installs the fake text splitter.
    """
    inst, engine = build(listeners=['text'], results=[_RESULT, _RESULT], numberOfSummaries=2)
    _write(inst.writeText, _CHUNK_BREAK.join(['chunk one', 'chunk two', 'chunk three']))

    inst.closing()

    assert [q.context for q in engine.asked] == [['chunk one'], ['chunk two']]
    assert engine.text[0].count('A short summary.') == 2


def test_closing_leaves_out_disabled_sections(build, splitter):
    """A section set to 0 is neither requested from the LLM nor written.

    Args:
        build: Instance factory fixture.
        splitter: Fixture that installs the fake text splitter.
    """
    inst, engine = build(listeners=['text'], results=[_RESULT], numberOfKeyPointWords=0, numberOfEntities=0)
    _write(inst.writeText, 'the whole document')

    inst.closing()

    text = engine.text[0]
    assert 'A short summary.' in text
    assert 'Key Points' not in text
    assert 'Entities' not in text
    assert engine.asked[0].instructions == ['Summary', 'Important Guidelines', 'Result Example']


def test_closing_writes_nothing_without_listeners(build, splitter):
    """With no output lane connected, nothing is written.

    Args:
        build: Instance factory fixture.
        splitter: Fixture that installs the fake text splitter.
    """
    inst, engine = build(listeners=[], results=[_RESULT])
    _write(inst.writeText, 'the whole document')

    inst.closing()

    assert engine.text == []
    assert engine.documents == []
