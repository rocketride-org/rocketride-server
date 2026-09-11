"""
Integration tests for the cache node's IInstance / IGlobal logic.

Exercises the real node code (hit skips the LLM, miss forwards + stores, Q->A
correlation, passthrough when uninitialised) with the engine modules stubbed and
a deterministic fake embedder. No engine, no ML model, no network.

Run: pytest nodes/test/cache/test_cache_instance.py
"""

from __future__ import annotations

import importlib
import sys
import types
from pathlib import Path

import pytest

_NODES_SRC = Path(__file__).resolve().parents[2] / 'src' / 'nodes'


# --- Fakes -----------------------------------------------------------------


class _FakeAnswer:
    def __init__(self):
        self._text = ''

    def setAnswer(self, text):
        self._text = text

    def getText(self):
        return self._text


class _QItem:
    def __init__(self, text):
        self.text = text


class _FakeQuestion:
    def __init__(self, text, context=None):
        self.questions = [_QItem(text)] if text is not None else []
        self.context = context


class _Recorder:
    """Stands in for self.instance — records forwarded questions/answers."""

    def __init__(self):
        self.questions = []
        self.answers = []

    def writeQuestions(self, question):
        self.questions.append(question)

    def writeAnswers(self, answer):
        self.answers.append(answer)


class _FakeEmbedder:
    """Returns a fixed vector per question text; records calls."""

    def __init__(self, table):
        self._table = table
        self.calls = []

    def embed(self, text):
        self.calls.append(text)
        return self._table[text]


@pytest.fixture
def cache_pkg(monkeypatch):
    """Stub engine modules and import the cache package fresh."""
    # rocketlib
    rl = types.ModuleType('rocketlib')

    class IInstanceBase:
        instance = None

        def preventDefault(self):
            pass

    class IGlobalBase:
        pass

    class Entry:
        pass

    class OPEN_MODE:
        CONFIG = 'config'
        RUN = 'run'

    rl.IInstanceBase = IInstanceBase
    rl.IGlobalBase = IGlobalBase
    rl.Entry = Entry
    rl.OPEN_MODE = OPEN_MODE
    rl.debug = lambda *a, **k: None
    monkeypatch.setitem(sys.modules, 'rocketlib', rl)

    # ai.common.config / schema / models
    ai = types.ModuleType('ai')
    ai_common = types.ModuleType('ai.common')
    cfg = types.ModuleType('ai.common.config')

    class Config:
        @staticmethod
        def getNodeConfig(provider, connConfig):
            return connConfig

    cfg.Config = Config

    schema = types.ModuleType('ai.common.schema')
    schema.Answer = _FakeAnswer
    schema.Question = _FakeQuestion

    models = types.ModuleType('ai.common.models')

    class SentenceTransformer:
        def __init__(self, *a, **k):
            pass

        def encode(self, texts, show_progress_bar=False):
            return [[0.0, 0.0]]

    models.SentenceTransformer = SentenceTransformer

    ai.common = ai_common
    ai_common.config = cfg
    ai_common.schema = schema
    ai_common.models = models
    for name, mod in {
        'ai': ai,
        'ai.common': ai_common,
        'ai.common.config': cfg,
        'ai.common.schema': schema,
        'ai.common.models': models,
    }.items():
        monkeypatch.setitem(sys.modules, name, mod)

    depends_mod = types.ModuleType('depends')
    depends_mod.depends = lambda *a, **k: None
    monkeypatch.setitem(sys.modules, 'depends', depends_mod)

    # Import the cache package fresh from nodes/src/nodes.
    monkeypatch.syspath_prepend(str(_NODES_SRC))
    for mod in list(sys.modules):
        if mod == 'cache' or mod.startswith('cache.'):
            monkeypatch.delitem(sys.modules, mod, raising=False)
    pkg = importlib.import_module('cache')
    # Ensure the (lazily-imported) core module is available as pkg.semantic_cache.
    importlib.import_module('cache.semantic_cache')
    return pkg


def _make_instance(cache_pkg, embedder, threshold=0.92, max_entries=1000, ttl_seconds=0.0):
    """Build an IInstance wired to a real SemanticCache + fake embedder + recorder."""
    glob = cache_pkg.IGlobal()
    glob.cache = cache_pkg.semantic_cache.SemanticCache(
        threshold=threshold, max_entries=max_entries, ttl_seconds=ttl_seconds
    )
    glob.embedder = embedder
    inst = cache_pkg.IInstance()
    inst.IGlobal = glob
    inst.instance = _Recorder()
    inst.open(object())
    return inst, glob


def test_miss_forwards_then_stores_then_hit_skips_llm(cache_pkg):
    embedder = _FakeEmbedder({'2+2?': [1.0, 0.0], '2 + 2 ?': [0.999, 0.01]})
    inst, glob = _make_instance(cache_pkg, embedder)
    rec = inst.instance

    # MISS: question forwarded to the LLM, nothing answered yet.
    inst.writeQuestions(_FakeQuestion('2+2?'))
    assert len(rec.questions) == 1
    assert len(rec.answers) == 0
    assert glob.cache.misses == 1

    # LLM answers -> stored and passed through.
    inst.writeAnswers(_make_answer('4'))
    assert len(rec.answers) == 1
    assert len(glob.cache) == 1

    # New, semantically-similar question -> HIT: answered from cache, LLM skipped.
    inst.open(object())
    inst.writeQuestions(_FakeQuestion('2 + 2 ?'))
    assert len(rec.questions) == 1  # NOT forwarded again
    assert len(rec.answers) == 2  # cached answer emitted
    assert rec.answers[-1].getText() == '4'
    assert glob.cache.hits == 1


def test_dissimilar_question_misses_and_forwards(cache_pkg):
    embedder = _FakeEmbedder({'cats?': [1.0, 0.0], 'dogs?': [0.0, 1.0]})
    inst, glob = _make_instance(cache_pkg, embedder)
    rec = inst.instance

    inst.writeQuestions(_FakeQuestion('cats?'))
    inst.writeAnswers(_make_answer('meow'))

    inst.open(object())
    inst.writeQuestions(_FakeQuestion('dogs?'))  # orthogonal vector -> miss
    assert len(rec.questions) == 2  # forwarded to LLM
    assert glob.cache.misses == 2


def test_empty_question_is_passthrough_not_embedded(cache_pkg):
    embedder = _FakeEmbedder({})
    inst, glob = _make_instance(cache_pkg, embedder)
    rec = inst.instance

    inst.writeQuestions(_FakeQuestion(None))  # no question text
    assert len(rec.questions) == 1
    assert embedder.calls == []  # never embedded
    assert glob.cache.lookups == 0


def test_passthrough_when_uninitialised(cache_pkg):
    inst = cache_pkg.IInstance()
    glob = cache_pkg.IGlobal()
    glob.cache = None
    glob.embedder = None
    inst.IGlobal = glob
    inst.instance = _Recorder()
    inst.open(object())

    inst.writeQuestions(_FakeQuestion('hello'))
    inst.writeAnswers(_make_answer('world'))
    assert len(inst.instance.questions) == 1
    assert len(inst.instance.answers) == 1


def test_hit_leaves_no_pending_so_answer_not_stored_twice(cache_pkg):
    embedder = _FakeEmbedder({'q': [1.0, 0.0]})
    inst, glob = _make_instance(cache_pkg, embedder)

    # Prime the cache via a miss + answer.
    inst.writeQuestions(_FakeQuestion('q'))
    inst.writeAnswers(_make_answer('stored'))
    assert len(glob.cache) == 1

    # Hit: emits cached answer; _pending must be None afterwards.
    inst.open(object())
    inst.writeQuestions(_FakeQuestion('q'))
    assert inst._pending is None
    assert len(glob.cache) == 1  # unchanged


def test_context_changes_key(cache_pkg):
    # Same question text, different context -> different embed input -> miss.
    embedder = _FakeEmbedder({'q ctxA': [1.0, 0.0], 'q ctxB': [0.0, 1.0]})
    inst, glob = _make_instance(cache_pkg, embedder)
    rec = inst.instance

    inst.writeQuestions(_FakeQuestion('q', context=['ctxA']))
    inst.writeAnswers(_make_answer('A'))

    inst.open(object())
    inst.writeQuestions(_FakeQuestion('q', context=['ctxB']))
    assert len(rec.questions) == 2  # different context forwarded (miss)
    assert embedder.calls == ['q ctxA', 'q ctxB']


def test_begin_global_config_mode_builds_nothing(cache_pkg):
    glob = cache_pkg.IGlobal()
    glob.IEndpoint = types.SimpleNamespace(endpoint=types.SimpleNamespace(openMode='config'))
    glob.beginGlobal()
    assert glob.cache is None
    assert glob.embedder is None


def test_begin_global_run_mode_builds_cache_and_embedder(cache_pkg):
    glob = cache_pkg.IGlobal()
    glob.IEndpoint = types.SimpleNamespace(endpoint=types.SimpleNamespace(openMode='run'))
    glob.glb = types.SimpleNamespace(
        logicalType='cache',
        connConfig={'model': 'x', 'threshold': 0.9, 'max_entries': 5, 'ttl_seconds': 0},
    )
    glob.beginGlobal()
    assert glob.cache is not None
    assert glob.cache.threshold == 0.9
    assert glob.cache.max_entries == 5
    assert glob.embedder is not None
    glob.endGlobal()
    assert glob.cache is None and glob.embedder is None


def _make_answer(text):
    """Build a stubbed Answer carrying ``text`` (mirrors the LLM's output)."""
    ans = _FakeAnswer()
    ans.setAnswer(text)
    return ans
