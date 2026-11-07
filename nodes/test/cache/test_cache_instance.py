"""
Integration tests for the cache node's IInstance / IGlobal logic.

Exercises the real node code:
- Forwarding contract with preventDefault() and simulated engine dispatch
- Hit skips the LLM (zero LLM calls) and emits answer once
- Miss forwards to LLM once, stores answer, and passes answer once
- JSON typed answer parity (dict/list preservation, expectJson flag)
- Cross-tenant and cross-session isolation (zero collisions across scopes)
- Field boundary and response-shaping collision safety
- Fallback to disabled-cache passthrough on dependency or model initialization failure
"""

from __future__ import annotations

import importlib
import json
import sys
import types
from pathlib import Path

import pytest

_NODES_SRC = Path(__file__).resolve().parents[2] / 'src' / 'nodes'


class _PreventDefaultRaised(Exception):
    """Stand-in for the real preventDefault(), which raises rather than setting a flag."""


def _simulate_engine_dispatch(handler_call, default_forward):
    """Mimic engine checkCallParent: default forward runs if handler returns normally."""
    try:
        handler_call()
    except _PreventDefaultRaised:
        return
    default_forward()


# --- Fakes -----------------------------------------------------------------


class _FakeAnswer:
    def __init__(self, expectJson=False):
        self.expectJson = expectJson
        self.answer = None

    def setAnswer(self, value):
        if self.expectJson:
            if isinstance(value, (dict, list)):
                self.answer = value
                return
            if isinstance(value, str):
                try:
                    self.answer = json.loads(value)
                    return
                except json.JSONDecodeError:
                    raise ValueError('Expected a JSON-compatible answer (dict or list).')
            raise ValueError('Expected a JSON-compatible answer (dict or list).')
        else:
            if isinstance(value, (dict, list)):
                self.answer = json.dumps(value)
                return
            if isinstance(value, str):
                self.answer = value
                return
            raise ValueError('Answer must be text, dict, or list.')

    def getText(self):
        if self.answer is None:
            return ''
        if isinstance(self.answer, (dict, list)):
            return json.dumps(self.answer)
        return str(self.answer)

    def getJson(self):
        if self.answer is None:
            return None
        if isinstance(self.answer, (dict, list)):
            return self.answer
        try:
            return json.loads(self.answer)
        except json.JSONDecodeError:
            raise ValueError('Answer is not in JSON format.')

    def isJson(self):
        return self.expectJson


class _QItem:
    def __init__(self, text):
        self.text = text


class _FakeQuestion:
    def __init__(
        self,
        text=None,
        context=None,
        metadata=None,
        expectJson=False,
        role=None,
        instructions=None,
        history=None,
        examples=None,
        goals=None,
        documents=None,
        filter=None,
    ):
        self.questions = [_QItem(text)] if text is not None else []
        self.context = context or []
        self.metadata = metadata
        self.expectJson = expectJson
        self.role = role
        self.instructions = instructions or []
        self.history = history or []
        self.examples = examples or []
        self.goals = goals or []
        self.documents = documents or []
        self.filter = filter


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
    """Returns a fixed vector per question text or query; records calls."""

    def __init__(self, table=None):
        self._table = table or {}
        self.calls = []

    def embed(self, text):
        self.calls.append(text)
        if callable(self._table):
            return self._table(text)
        if text in self._table:
            return self._table[text]
        # Match by extracted primary question prompt if table keys are plain prompts
        try:
            parsed = json.loads(text)
            q_list = parsed.get('questions', [])
            if q_list and q_list[0] in self._table:
                return self._table[q_list[0]]
        except Exception:
            pass
        return [1.0, 0.0]


@pytest.fixture
def cache_pkg(monkeypatch):
    """Stub engine modules and import the cache package fresh."""
    rl = types.ModuleType('rocketlib')

    class IInstanceBase:
        instance = None

        def preventDefault(self):
            raise _PreventDefaultRaised()

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
    rl.warning = lambda *a, **k: None
    monkeypatch.setitem(sys.modules, 'rocketlib', rl)

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

    monkeypatch.syspath_prepend(str(_NODES_SRC))
    for mod in list(sys.modules):
        if mod == 'cache' or mod.startswith('cache.'):
            monkeypatch.delitem(sys.modules, mod, raising=False)
    pkg = importlib.import_module('cache')
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


def _make_answer(text, expectJson=False):
    """Build a stubbed Answer carrying ``text`` or payload."""
    ans = _FakeAnswer(expectJson=expectJson)
    ans.setAnswer(text)
    return ans


def test_miss_forwards_then_stores_then_hit_skips_llm(cache_pkg):
    """On miss: LLM invoked once. On hit: LLM invoked zero times, cached answer emitted."""
    embedder = _FakeEmbedder({'2+2?': [1.0, 0.0], '2 + 2 ?': [0.999, 0.01]})
    inst, glob = _make_instance(cache_pkg, embedder)
    rec = inst.instance

    engine_default_questions = []
    engine_default_answers = []

    # 1. MISS: Question dispatched through simulated engine
    q1 = _FakeQuestion('2+2?')
    _simulate_engine_dispatch(
        lambda: inst.writeQuestions(q1),
        lambda: engine_default_questions.append(q1),
    )
    # Delivered to downstream LLM exactly once (explicit forward; engine default suppressed)
    assert len(rec.questions) == 1
    assert len(engine_default_questions) == 0
    assert len(rec.answers) == 0
    assert glob.cache.misses == 1

    # 2. LLM responds: dispatched through simulated engine
    a1 = _make_answer('4')
    _simulate_engine_dispatch(
        lambda: inst.writeAnswers(a1),
        lambda: engine_default_answers.append(a1),
    )
    # Delivered downstream exactly once
    assert len(rec.answers) == 1
    assert len(engine_default_answers) == 0
    assert len(glob.cache) == 1

    # 3. New similar question -> HIT: answered from cache, LLM completely skipped!
    inst.open(object())
    q2 = _FakeQuestion('2 + 2 ?')
    _simulate_engine_dispatch(
        lambda: inst.writeQuestions(q2),
        lambda: engine_default_questions.append(q2),
    )
    # Question must NOT reach the LLM: total questions forwarded remains 1
    assert len(rec.questions) == 1
    assert len(engine_default_questions) == 0
    # Cached answer emitted downstream
    assert len(rec.answers) == 2
    assert rec.answers[-1].getText() == '4'
    assert glob.cache.hits == 1


def test_dissimilar_question_misses_and_forwards(cache_pkg):
    embedder = _FakeEmbedder({'cats?': [1.0, 0.0], 'dogs?': [0.0, 1.0]})
    inst, glob = _make_instance(cache_pkg, embedder)
    rec = inst.instance

    engine_defaults = []
    _simulate_engine_dispatch(
        lambda: inst.writeQuestions(_FakeQuestion('cats?')),
        lambda: engine_defaults.append('cats?'),
    )
    _simulate_engine_dispatch(
        lambda: inst.writeAnswers(_make_answer('meow')),
        lambda: engine_defaults.append('meow'),
    )

    inst.open(object())
    _simulate_engine_dispatch(
        lambda: inst.writeQuestions(_FakeQuestion('dogs?')),
        lambda: engine_defaults.append('dogs?'),
    )
    assert len(rec.questions) == 2
    assert len(engine_defaults) == 0
    assert glob.cache.misses == 2


def test_empty_question_is_passthrough_not_embedded(cache_pkg):
    embedder = _FakeEmbedder({})
    inst, glob = _make_instance(cache_pkg, embedder)
    rec = inst.instance

    engine_defaults = []
    q = _FakeQuestion(None)
    _simulate_engine_dispatch(
        lambda: inst.writeQuestions(q),
        lambda: engine_defaults.append(q),
    )
    assert len(rec.questions) == 1
    assert len(engine_defaults) == 0
    assert embedder.calls == []
    assert glob.cache.lookups == 0


def test_passthrough_when_uninitialised(cache_pkg):
    inst = cache_pkg.IInstance()
    glob = cache_pkg.IGlobal()
    glob.cache = None
    glob.embedder = None
    inst.IGlobal = glob
    inst.instance = _Recorder()
    inst.open(object())

    engine_defaults = []
    q = _FakeQuestion('hello')
    _simulate_engine_dispatch(
        lambda: inst.writeQuestions(q),
        lambda: engine_defaults.append(q),
    )
    a = _make_answer('world')
    _simulate_engine_dispatch(
        lambda: inst.writeAnswers(a),
        lambda: engine_defaults.append(a),
    )
    assert len(inst.instance.questions) == 1
    assert len(inst.instance.answers) == 1
    assert len(engine_defaults) == 0


def test_embedder_failure_falls_back_to_llm(cache_pkg):
    class FailingEmbedder:
        def embed(self, text):
            raise RuntimeError('OOM or model crash')

    inst, glob = _make_instance(cache_pkg, FailingEmbedder())
    rec = inst.instance

    engine_defaults = []
    q = _FakeQuestion('prompt')
    _simulate_engine_dispatch(
        lambda: inst.writeQuestions(q),
        lambda: engine_defaults.append(q),
    )
    assert len(rec.questions) == 1
    assert len(engine_defaults) == 0
    assert glob.cache.lookups == 0


def test_json_answer_hit_and_miss_parity(cache_pkg):
    """Structured dict and list answers preserve exact type and expectJson across cache hit."""
    embedder = _FakeEmbedder({'get_metrics': [1.0, 0.0], 'fetch_metrics': [0.999, 0.01]})
    inst, glob = _make_instance(cache_pkg, embedder)
    rec = inst.instance

    # Miss: query with expectJson=True
    q1 = _FakeQuestion('get_metrics', expectJson=True)
    _simulate_engine_dispatch(lambda: inst.writeQuestions(q1), lambda: None)

    # LLM returns structured dict
    dict_payload = {'cpu_percent': 42.5, 'status': 'healthy'}
    a1 = _FakeAnswer(expectJson=True)
    a1.setAnswer(dict_payload)
    _simulate_engine_dispatch(lambda: inst.writeAnswers(a1), lambda: None)

    assert len(rec.answers) == 1
    assert isinstance(rec.answers[0].answer, dict)
    assert rec.answers[0].isJson() is True
    assert rec.answers[0].getJson() == dict_payload

    # Hit: similar query with expectJson=True
    inst.open(object())
    q2 = _FakeQuestion('fetch_metrics', expectJson=True)
    _simulate_engine_dispatch(lambda: inst.writeQuestions(q2), lambda: None)

    assert len(rec.answers) == 2
    cached_ans = rec.answers[1]
    assert cached_ans.expectJson is True
    assert cached_ans.isJson() is True
    assert isinstance(cached_ans.answer, dict)
    assert cached_ans.getJson() == dict_payload


def test_expect_json_mismatch_cannot_collide(cache_pkg):
    """A question expecting JSON must never hit a cached plain text answer."""
    embedder = _FakeEmbedder({'same query': [1.0, 0.0]})
    inst, glob = _make_instance(cache_pkg, embedder)
    rec = inst.instance

    # Prime with plain text (expectJson=False)
    q_plain = _FakeQuestion('same query', expectJson=False)
    _simulate_engine_dispatch(lambda: inst.writeQuestions(q_plain), lambda: None)
    a_plain = _make_answer('plain text answer', expectJson=False)
    _simulate_engine_dispatch(lambda: inst.writeAnswers(a_plain), lambda: None)

    # Query with expectJson=True must NOT hit the plain text answer
    inst.open(object())
    q_json = _FakeQuestion('same query', expectJson=True)
    _simulate_engine_dispatch(lambda: inst.writeQuestions(q_json), lambda: None)

    # Missed and forwarded to LLM
    assert len(rec.questions) == 2
    assert len(rec.answers) == 1  # No cached answer emitted


def test_cross_tenant_isolation_identical_prompt(cache_pkg):
    """Two different tenants with identical prompts must never share cache."""
    embedder = _FakeEmbedder({'balance?': [1.0, 0.0]})
    inst, glob = _make_instance(cache_pkg, embedder)
    rec = inst.instance

    # Tenant A asks and caches answer
    q_alice = _FakeQuestion('balance?', metadata={'tenant_id': 'tenant_alice'})
    _simulate_engine_dispatch(lambda: inst.writeQuestions(q_alice), lambda: None)
    _simulate_engine_dispatch(lambda: inst.writeAnswers(_make_answer('$1,000,000')), lambda: None)

    # Tenant B asks identical question -> MUST MISS!
    inst.open(object())
    q_bob = _FakeQuestion('balance?', metadata={'tenant_id': 'tenant_bob'})
    _simulate_engine_dispatch(lambda: inst.writeQuestions(q_bob), lambda: None)

    assert len(rec.questions) == 2  # Tenant B was forwarded to LLM
    assert len(rec.answers) == 1  # Alice's answer was NOT returned to Bob


def test_cross_session_isolation_identical_prompt(cache_pkg):
    """Two different sessions with identical prompts must never share cache."""
    embedder = _FakeEmbedder({'history?': [1.0, 0.0]})
    inst, glob = _make_instance(cache_pkg, embedder)
    rec = inst.instance

    # Session 1 asks and caches
    q1 = _FakeQuestion('history?', metadata={'session_id': 'sess-1'})
    _simulate_engine_dispatch(lambda: inst.writeQuestions(q1), lambda: None)
    _simulate_engine_dispatch(lambda: inst.writeAnswers(_make_answer('topic 1')), lambda: None)

    # Session 2 asks -> MUST MISS
    inst.open(object())
    q2 = _FakeQuestion('history?', metadata={'session_id': 'sess-2'})
    _simulate_engine_dispatch(lambda: inst.writeQuestions(q2), lambda: None)

    assert len(rec.questions) == 2
    assert len(rec.answers) == 1


def test_field_boundary_collision_prevention(cache_pkg):
    """Adversarial boundary shifts cannot collide under field-delimited identity."""
    inst = cache_pkg.IInstance()
    q1 = _FakeQuestion('foo', context=['bar baz'])
    q2 = _FakeQuestion('foo bar', context=['baz'])

    key1 = inst._question_text(q1)
    key2 = inst._question_text(q2)

    assert key1 != key2
    parsed1 = json.loads(key1)
    parsed2 = json.loads(key2)
    assert parsed1['questions'] == ['foo']
    assert parsed1['context'] == ['bar baz']
    assert parsed2['questions'] == ['foo bar']
    assert parsed2['context'] == ['baz']


def test_response_shaping_fields_change_key(cache_pkg):
    """All response-shaping fields change the key identity."""
    inst = cache_pkg.IInstance()

    base_q = _FakeQuestion('q')
    base_key = inst._question_text(base_q)

    # Role
    q_role = _FakeQuestion('q', role='Financial Analyst')
    assert inst._question_text(q_role) != base_key

    # Instructions
    q_inst = _FakeQuestion('q', instructions=[{'subtitle': 's', 'instructions': 'i'}])
    assert inst._question_text(q_inst) != base_key

    # History
    q_hist = _FakeQuestion('q', history=[{'role': 'user', 'content': 'prev'}])
    assert inst._question_text(q_hist) != base_key

    # Examples
    q_ex = _FakeQuestion('q', examples=[{'given': 'g', 'result': 'r'}])
    assert inst._question_text(q_ex) != base_key

    # Goals
    q_goal = _FakeQuestion('q', goals=['achieve X'])
    assert inst._question_text(q_goal) != base_key

    # Documents
    q_doc = _FakeQuestion('q', documents=['doc content'])
    assert inst._question_text(q_doc) != base_key

    # Filters
    q_filt = _FakeQuestion('q', filter={'limit': 10})
    assert inst._question_text(q_filt) != base_key


def test_begin_global_failure_falls_back_to_passthrough(cache_pkg, monkeypatch):
    """When dependency install or embedder construction fails, fall back to disabled passthrough."""
    glob = cache_pkg.IGlobal()
    glob.IEndpoint = types.SimpleNamespace(endpoint=types.SimpleNamespace(openMode='run'))
    glob.glb = types.SimpleNamespace(
        logicalType='cache',
        connConfig={'model': 'x'},
    )

    # Simulate dependency/model loading failure
    def _exploding_transformer(*a, **k):
        raise RuntimeError('Missing weights or CUDA OOM')

    monkeypatch.setattr('ai.common.models.SentenceTransformer', _exploding_transformer)

    glob.beginGlobal()
    # Must NOT raise, sets cache and embedder to None (disabled passthrough)
    assert glob.cache is None
    assert glob.embedder is None

    # Pipeline remains usable
    inst = cache_pkg.IInstance()
    inst.IGlobal = glob
    inst.instance = _Recorder()
    inst.open(object())

    _simulate_engine_dispatch(lambda: inst.writeQuestions(_FakeQuestion('hello')), lambda: None)
    assert len(inst.instance.questions) == 1


def test_hit_leaves_no_pending_so_answer_not_stored_twice(cache_pkg):
    embedder = _FakeEmbedder({'q': [1.0, 0.0]})
    inst, glob = _make_instance(cache_pkg, embedder)

    # Prime the cache via a miss + answer.
    _simulate_engine_dispatch(lambda: inst.writeQuestions(_FakeQuestion('q')), lambda: None)
    _simulate_engine_dispatch(lambda: inst.writeAnswers(_make_answer('stored')), lambda: None)
    assert len(glob.cache) == 1

    # Hit: emits cached answer; _pending must be None afterwards.
    inst.open(object())
    _simulate_engine_dispatch(lambda: inst.writeQuestions(_FakeQuestion('q')), lambda: None)
    assert inst._pending is None
    assert len(glob.cache) == 1


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
        connConfig={'model': 'x', 'threshold': 0.9, 'max_entries': 5, 'ttl_seconds': 0, 'scope': 'my-pipe'},
    )
    glob.beginGlobal()
    assert glob.cache is not None
    assert glob.cache.threshold == 0.9
    assert glob.cache.max_entries == 5
    assert glob.scope == 'my-pipe'
    assert glob.embedder is not None
    glob.endGlobal()
    assert glob.cache is None and glob.embedder is None
