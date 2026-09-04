# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""Cross-node tests for the Cobalt evaluation pipeline.

Every other Cobalt test drives one node in isolation behind mocks. That is
exactly why a reference-plumbing break survived four review rounds: each round
fixed the layer that was reported, and the next hop stayed invisible. These
tests wire the real nodes of ``examples/cobalt-evaluation.pipe`` together —

    dataset_cobalt -> prompt -> LLM (ai.common.llm_base) -> eval_cobalt

— and assert on the score that comes out the far end.

Two deliberate choices make this a real regression net rather than a
restatement of the mocks:

* ``Question`` and ``Answer`` are the **real** Pydantic models from
  ``rocketride.schema``, the same objects the engine hands between nodes, so a
  field that is not declared on the schema cannot silently pass.
* The LLM hop is the **real** ``ai.common.llm_base.LLMBase.writeQuestions``,
  loaded from source with only its provider ``chat`` stubbed. The metadata
  merge under test is the shipped one, not a re-implementation.

Only the engine boundary (``rocketlib``), the dependency installer
(``depends``), and the provider network call are substituted. No API key and no
``basalt-ai-cobalt`` install are needed: the evaluator runs its offline
similarity path.

Run with:

    pytest nodes/test/cobalt/test_pipeline_metadata_hop.py
"""

import contextlib
import contextvars
import importlib.util
import pathlib
import sys
from types import ModuleType
from unittest.mock import MagicMock

import pytest

_REPO_ROOT = pathlib.Path(__file__).resolve().parents[3]
_CLIENT_SRC = str(_REPO_ROOT / 'packages' / 'client-python' / 'src')
_NODES_DIR = str(_REPO_ROOT / 'nodes' / 'src' / 'nodes')
_AI_COMMON = _REPO_ROOT / 'packages' / 'ai' / 'src' / 'ai' / 'common'

# Module trees this file owns for the duration of its tests: the engine
# boundary it stubs, the schema package it pins to this repo's source, and the
# node packages it imports under both.
#
# The fixture purges these on the way IN as well as on the way out. Purging on
# entry is what makes the tests order-independent: sibling modules such as
# test_dataset_cobalt.py install their own, differently-shaped mocks for the
# same names, and a `rocketride` or `prompt` left in sys.modules by an earlier
# module would otherwise be handed back by `import` still bound to those mocks —
# a Question class with no `metadata` field, for instance. Everything purged is
# snapshotted first and put back verbatim on teardown.
_OWNED_MODULE_PREFIXES = (
    'ai',
    'cobalt',
    'dataset_cobalt',
    'depends',
    'eval_cobalt',
    'prompt',
    'rocketlib',
    'rocketride',
)


# ---------------------------------------------------------------------------
# Engine-boundary stubs
# ---------------------------------------------------------------------------


class _IInstanceBase:
    """Stand-in for the engine's instance base class."""

    IEndpoint = None
    IGlobal = None
    instance = None

    def preventDefault(self):
        """Mimic the engine's "no default behaviour to prevent" error."""
        raise RuntimeError('No default to prevent')


class _IGlobalBase:
    """Stand-in for the engine's global base class."""

    IEndpoint = None
    glb = None


def _install_mocks():
    """Replace the engine boundary so real node code can be imported."""
    rocketlib = ModuleType('rocketlib')
    rocketlib.IInstanceBase = _IInstanceBase
    rocketlib.IGlobalBase = _IGlobalBase
    rocketlib.IEndpointBase = type('IEndpointBase', (), {})
    rocketlib.Entry = MagicMock
    rocketlib.OPEN_MODE = type('OPEN_MODE', (), {'CONFIG': 'CONFIG'})()
    rocketlib.IJson = MagicMock()
    rocketlib.debug = lambda *a, **kw: None
    rocketlib.warning = lambda *a, **kw: None
    rocketlib.monitorStatus = lambda *a, **kw: None
    rocketlib.monitorCompleted = lambda *a, **kw: None
    rocketlib.monitorFailed = lambda *a, **kw: None
    rocketlib.getObject = lambda obj: MagicMock()
    rocketlib.getServiceDefinition = MagicMock(return_value={})
    rocketlib.invoke_function = lambda fn: fn
    sys.modules['rocketlib'] = rocketlib

    depends = ModuleType('depends')
    depends.depends = lambda *a, **kw: None
    sys.modules['depends'] = depends

    # An empty `cobalt` module keeps the evaluator and the loader on their
    # offline paths, so the assertions below describe behaviour a contributor
    # without basalt-ai-cobalt installed also gets.
    sys.modules['cobalt'] = ModuleType('cobalt')

    # The real schema. `ai.common.schema` re-exports these from `rocketride`,
    # so importing the client package gives the nodes the same classes the
    # engine does.
    if _CLIENT_SRC not in sys.path:
        sys.path.insert(0, _CLIENT_SRC)
    import rocketride

    ai = ModuleType('ai')
    ai_common = ModuleType('ai.common')
    ai_schema = ModuleType('ai.common.schema')
    ai_config = ModuleType('ai.common.config')
    ai_utils = ModuleType('ai.common.utils')
    ai_stream = ModuleType('ai.common.llm_native_stream')

    ai_schema.Question = rocketride.Question
    ai_schema.Answer = rocketride.Answer
    ai_schema.QuestionText = rocketride.QuestionText
    ai_schema.QuestionType = rocketride.QuestionType
    for _name in ('Doc', 'DocFilter', 'DocGroup', 'DocMetadata'):
        setattr(ai_schema, _name, getattr(rocketride, _name, MagicMock))

    ai_config.Config = type(
        'Config',
        (),
        {'getNodeConfig': staticmethod(lambda logical_type, conn_config: conn_config)},
    )

    # ai.common.utils' package __init__ pulls torch/cv2, which this environment
    # does not have. Load the dependency-free helper straight from its file so
    # the shipped merge logic is what runs.
    ai_utils.merge_metadata = _load_from_source(
        'ai.common.utils.metadata_utils',
        _AI_COMMON / 'utils' / 'metadata_utils.py',
    ).merge_metadata

    # llm_base reads this contextvar; the real module also imports rocketlib,
    # so a two-line stub avoids ordering surprises without changing behaviour.
    ai_stream.STOP_SEQUENCES_VAR = contextvars.ContextVar('rocketride_llm_stop_sequences', default=None)

    # llm_base wraps its provider call in `with turn_usage() as read_usage:` to
    # collect per-turn token usage. The real ai.common.llm_adapter imports
    # ai.common.utils.flatten_content_blocks, which the stub above does not
    # carry, so stand in a no-op scope: this suite asserts on metadata, and a
    # None usage read simply leaves `answer.tokens` unset.
    ai_adapter = ModuleType('ai.common.llm_adapter')

    @contextlib.contextmanager
    def _turn_usage():
        yield lambda: None

    ai_adapter.turn_usage = _turn_usage

    ai.common = ai_common
    ai_common.config = ai_config
    ai_common.llm_adapter = ai_adapter
    ai_common.llm_native_stream = ai_stream
    ai_common.schema = ai_schema
    ai_common.utils = ai_utils

    sys.modules.update(
        {
            'ai': ai,
            'ai.common': ai_common,
            'ai.common.config': ai_config,
            'ai.common.llm_adapter': ai_adapter,
            'ai.common.llm_native_stream': ai_stream,
            'ai.common.schema': ai_schema,
            'ai.common.utils': ai_utils,
        }
    )

    if _NODES_DIR not in sys.path:
        sys.path.insert(0, _NODES_DIR)


def _load_from_source(module_name, path):
    """Import a module directly from ``path``, bypassing its package __init__."""
    spec = importlib.util.spec_from_file_location(module_name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _owned_module_names():
    """List the currently loaded modules that fall under an owned prefix."""
    return [
        name
        for name in list(sys.modules)
        if any(name == prefix or name.startswith(prefix + '.') for prefix in _OWNED_MODULE_PREFIXES)
    ]


def _purge_owned_modules():
    """Drop every owned module so the next import rebuilds it."""
    for name in _owned_module_names():
        del sys.modules[name]


@pytest.fixture(scope='module', autouse=True)
def _engine_mocks():
    """Install the engine stubs for this module and undo them afterwards."""
    saved_modules = {name: sys.modules[name] for name in _owned_module_names()}
    saved_path = list(sys.path)

    _purge_owned_modules()
    _install_mocks()
    yield

    _purge_owned_modules()
    sys.modules.update(saved_modules)
    sys.path[:] = saved_path


# ---------------------------------------------------------------------------
# Fake engine: lane routing between node instances
# ---------------------------------------------------------------------------


class _Lane:
    """Collects what a node writes, standing in for the engine's lanes.

    A node's ``self.instance`` is the engine handle it writes downstream
    through. Capturing instead of forwarding lets each test drive one hop at a
    time and assert on what crossed it.
    """

    def __init__(self):
        self.questions = []
        self.answers = []
        self.sse = []

    def writeQuestions(self, question):
        """Record a question emitted on the questions lane."""
        self.questions.append(question)

    def sendQuestions(self, question):
        """Record a question emitted from source mode."""
        self.questions.append(question)

    def writeAnswers(self, answer):
        """Record an answer emitted on the answers lane."""
        self.answers.append(answer)

    def sendSSE(self, channel, **kwargs):
        """Record a server-sent event (llm_base streams reasoning through this)."""
        self.sse.append((channel, kwargs))


def _dataset_node(items):
    """Build a dataset_cobalt instance preloaded with ``items``."""
    from dataset_cobalt.IInstance import IInstance

    node = IInstance()
    node.IGlobal = MagicMock()
    node.IGlobal._questions = items
    node.instance = _Lane()
    return node


def _prompt_node(instructions):
    """Build a prompt instance configured with ``instructions``."""
    from prompt.IInstance import IInstance

    node = IInstance()
    node.IGlobal = MagicMock()
    node.IGlobal.config = {'instructions': instructions}
    node.instance = _Lane()
    return node


def _llm_node(reply):
    """Build a real ``LLMBase`` whose provider call returns ``reply``.

    Loads ``ai/common/llm_base.py`` from source so the metadata merge exercised
    here is the shipped one. Only the provider ``chat`` is stubbed — it is the
    single boundary that would otherwise need a network call and a key.
    """
    from ai.common.schema import Answer

    llm_base = _load_from_source('ai.common.llm_base', _AI_COMMON / 'llm_base.py')

    def _chat(question, **kwargs):
        answer = Answer()
        answer.setAnswer(reply(question) if callable(reply) else reply)
        return answer

    node = llm_base.LLMBase()
    node.IGlobal = MagicMock()
    node.IGlobal._chat = MagicMock(chat=_chat)
    node.instance = _Lane()
    return node


def _eval_node(eval_type='similarity', threshold=0.6):
    """Build an eval_cobalt instance with a live offline evaluator."""
    from eval_cobalt.cobalt_evaluator import CobaltEvaluator
    from eval_cobalt.IInstance import IInstance

    node = IInstance()
    node.IGlobal = MagicMock()
    node.IGlobal._evaluator = CobaltEvaluator({'eval_type': eval_type, 'threshold': threshold}, {})
    node.instance = _Lane()
    return node


def _scores(lane):
    """Extract the ``cobalt_score`` payloads from an answers lane."""
    return [answer.getJson() for answer in lane.answers if answer.isJson()]


def _run_pipeline(items, reply, instructions=None, with_prompt=True, threshold=0.6):
    """Run dataset -> [prompt] -> LLM -> eval and return the collected lanes.

    Mirrors ``examples/cobalt-evaluation.pipe``. In source mode the engine gives
    each dataset row its own instance chain, so the prompt and LLM nodes are
    rebuilt per question rather than shared — which is also what keeps the
    prompt node's ``closing()`` merge from collapsing N items into one.

    Args:
        items: Dataset items as ``dataset_cobalt`` would have loaded them.
        reply: The LLM's answer text, or a callable taking the Question.
        instructions: Prompt-node instructions; ignored when ``with_prompt``
            is False.
        with_prompt: Whether to include the prompt hop.
        threshold: Pass/fail threshold for the evaluator.

    Returns:
        Tuple of (dataset lane, list of prompt lanes, list of LLM lanes,
        eval lane).
    """
    from ai.common.schema import Question

    dataset = _dataset_node(items)
    dataset.writeQuestions(Question())

    evaluator = _eval_node(threshold=threshold)
    prompt_lanes = []
    llm_lanes = []

    for question in dataset.instance.questions:
        if with_prompt:
            prompt = _prompt_node(instructions or ['Answer the question concisely in one sentence.'])
            prompt.writeQuestions(question)
            prompt.closing()
            prompt_lanes.append(prompt.instance)
            downstream = prompt.instance.questions
        else:
            downstream = [question]

        for staged in downstream:
            llm = _llm_node(reply)
            llm.writeQuestions(staged)
            llm_lanes.append(llm.instance)
            for answer in llm.instance.answers:
                evaluator.writeAnswers(answer)

    return dataset.instance, prompt_lanes, llm_lanes, evaluator.instance


_PARIS = {
    'text': 'What is the capital of France?',
    'metadata': {'expected': 'The capital of France is Paris.'},
}
_MATH = {'text': 'What is 2 + 2?', 'metadata': {'expected': '2 + 2 equals 4.'}}
_OCEAN = {
    'text': 'Name the largest ocean on Earth.',
    'metadata': {'expected': 'The Pacific Ocean is the largest ocean on Earth.'},
}


class TestReferenceSurvivesEveryHop:
    """The reference value must reach the evaluator through every node."""

    def test_dataset_attaches_the_reference(self):
        """dataset_cobalt puts `expected` on Question.metadata."""
        from ai.common.schema import Question

        dataset = _dataset_node([_PARIS])
        dataset.writeQuestions(Question())

        emitted = dataset.instance.questions
        assert len(emitted) == 1
        assert emitted[0].metadata['expected'] == 'The capital of France is Paris.'

    def test_prompt_forwards_the_reference(self):
        """The prompt node must not drop metadata when it rebuilds the question.

        This is the hop that made every score 0.0: the prompt node builds its
        own Question and used to copy only the text across.
        """
        from ai.common.schema import Question

        dataset = _dataset_node([_PARIS])
        dataset.writeQuestions(Question())

        prompt = _prompt_node(['Answer concisely.'])
        prompt.writeQuestions(dataset.instance.questions[0])
        prompt.closing()

        emitted = prompt.instance.questions
        assert len(emitted) == 1
        assert emitted[0].metadata.get('expected') == 'The capital of France is Paris.'

    def test_llm_carries_the_reference_onto_the_answer(self):
        """llm_base merges Question.metadata onto the Answer it emits."""
        from ai.common.schema import Question

        question = Question()
        question.addQuestion('What is the capital of France?')
        question.metadata = {'expected': 'The capital of France is Paris.'}

        llm = _llm_node('The capital of France is Paris.')
        llm.writeQuestions(question)

        answers = llm.instance.answers
        assert len(answers) == 1
        assert answers[0].metadata.get('expected') == 'The capital of France is Paris.'


class TestFullPipelineScores:
    """End-to-end scores for the shape in examples/cobalt-evaluation.pipe."""

    def test_correct_answer_scores_above_threshold(self):
        """A correct answer must score non-zero and pass.

        The regression this pins: before the prompt node forwarded metadata,
        this exact pipeline returned score 0.0 / passed False for an answer
        that matched the reference word for word.
        """
        _, _, _, eval_lane = _run_pipeline([_PARIS], 'The capital of France is Paris.')

        scores = _scores(eval_lane)
        assert len(scores) == 1
        assert scores[0]['cobalt_score'] > 0.0, 'reference did not survive the pipeline'
        assert scores[0]['cobalt_passed'] is True

    def test_wrong_answer_scores_below_threshold(self):
        """A wrong answer must still fail, so the test above is not vacuous."""
        _, _, _, eval_lane = _run_pipeline([_PARIS], 'Bananas are yellow and grow on trees.')

        scores = _scores(eval_lane)
        assert len(scores) == 1
        assert scores[0]['cobalt_passed'] is False
        assert scores[0]['cobalt_score'] < 0.6

    def test_every_item_is_scored_one_to_one(self):
        """Three dataset items produce three scores, each above threshold."""
        items = [_PARIS, _MATH, _OCEAN]
        expected_by_question = {item['text']: item['metadata']['expected'] for item in items}

        def reply(question):
            for text in question.questions:
                if text.text in expected_by_question:
                    return expected_by_question[text.text]
            return 'I do not know.'

        dataset_lane, prompt_lanes, llm_lanes, eval_lane = _run_pipeline(items, reply)

        assert len(dataset_lane.questions) == 3
        assert len(prompt_lanes) == 3
        assert len(llm_lanes) == 3

        scores = _scores(eval_lane)
        assert len(scores) == 3
        assert all(score['cobalt_score'] > 0.0 for score in scores)
        assert all(score['cobalt_passed'] is True for score in scores)

    def test_pipeline_without_a_prompt_node_also_scores(self):
        """A dataset -> LLM -> eval chain scores too, so the fix is not prompt-only."""
        _, prompt_lanes, _, eval_lane = _run_pipeline(
            [_PARIS],
            'The capital of France is Paris.',
            with_prompt=False,
        )

        assert prompt_lanes == []
        scores = _scores(eval_lane)
        assert len(scores) == 1
        assert scores[0]['cobalt_score'] > 0.0


class TestReferenceNeverReachesTheModel:
    """Carrying the reference must not leak it into the prompt or the score."""

    def test_expected_is_absent_from_the_rendered_prompt(self):
        """The gold answer must not appear in what the LLM is asked.

        metadata exists precisely so the reference can travel beside the
        prompt instead of inside it. If it leaked into the rendered prompt the
        model would be handed the answer and every score would be meaningless.
        """
        seen_prompts = []

        def reply(question):
            seen_prompts.append(question.getPrompt())
            return 'The capital of France is Paris.'

        _, prompt_lanes, _, _ = _run_pipeline([_PARIS], reply)

        assert seen_prompts, 'the LLM hop never ran'
        for rendered in seen_prompts:
            assert 'Paris' not in rendered, 'reference answer leaked into the prompt'

        # Same guarantee on the question object itself, not just its rendering.
        for lane in prompt_lanes:
            for question in lane.questions:
                assert not any('Paris' in repr(entry) for entry in question.context)

    def test_reference_travels_only_on_metadata(self):
        """The question carries `expected` on metadata and nowhere else."""
        from ai.common.schema import Question

        dataset = _dataset_node([_PARIS])
        dataset.writeQuestions(Question())
        question = dataset.instance.questions[0]

        assert question.metadata['expected'] == 'The capital of France is Paris.'
        assert not any('Paris' in repr(entry) for entry in question.context)
        assert not any('Paris' in repr(entry) for entry in question.questions)


class TestPromptNodePreservesExistingBehaviour:
    """Forwarding metadata must not change what the prompt node already did."""

    def test_instructions_are_still_applied(self):
        """Configured instructions still land on the emitted question."""
        from ai.common.schema import Question

        question = Question()
        question.addQuestion('What is the capital of France?')

        prompt = _prompt_node(['Answer concisely.', 'Stay factual.'])
        prompt.writeQuestions(question)
        prompt.closing()

        emitted = prompt.instance.questions[0]
        rendered = emitted.getPrompt()
        assert 'Answer concisely.' in rendered
        assert 'Stay factual.' in rendered
        assert 'What is the capital of France?' in rendered

    def test_question_without_metadata_still_works(self):
        """A question carrying no metadata passes through unharmed."""
        from ai.common.schema import Question

        question = Question()
        question.addQuestion('What is the capital of France?')

        prompt = _prompt_node(['Answer concisely.'])
        prompt.writeQuestions(question)
        prompt.closing()

        emitted = prompt.instance.questions[0]
        assert emitted.metadata == {}
        assert 'What is the capital of France?' in emitted.getPrompt()

    def test_open_resets_state_between_objects(self):
        """A reused instance must not carry state from the previous object.

        The engine builds one IInstance per filter instance and calls open()
        once per object. Without a reset in open(), object 2 inherits object
        1's collected text, a second copy of the instructions, and object 1's
        metadata keys — so a dataset row gets evaluated against a merged prompt
        and the wrong reference. That is worse than the 0.0 score this file's
        other tests pin, because the resulting score looks plausible.
        """
        from ai.common.schema import Question

        node = _prompt_node(['Answer concisely.'])
        emitted = []

        for text, metadata in (
            ('What is the capital of France?', {'expected': 'The capital of France is Paris.'}),
            ('What is 2 + 2?', {'expected': '2 + 2 equals 4.'}),
        ):
            node.instance = _Lane()
            node.open(object())

            question = Question()
            question.addQuestion(text)
            question.metadata = dict(metadata)
            node.writeQuestions(question)
            node.closing()

            emitted.append(node.instance.questions[0])

        first, second = emitted
        assert [t.text for t in first.questions] == ['What is the capital of France?']
        assert [t.text for t in second.questions] == ['What is 2 + 2?']
        assert first.metadata == {'expected': 'The capital of France is Paris.'}
        assert second.metadata == {'expected': '2 + 2 equals 4.'}
        assert len(second.instructions) == len(first.instructions) == 1

    def test_later_questions_do_not_overwrite_earlier_metadata(self):
        """Merging N questions unions their metadata instead of clobbering it."""
        from ai.common.schema import Question

        first = Question()
        first.addQuestion('Q1')
        first.metadata = {'expected': 'A1', 'dataset_id': 'ds'}

        second = Question()
        second.addQuestion('Q2')
        second.metadata = {'item_index': 1}

        prompt = _prompt_node(['Answer concisely.'])
        prompt.writeQuestions(first)
        prompt.writeQuestions(second)
        prompt.closing()

        merged = prompt.instance.questions[0].metadata
        assert merged['dataset_id'] == 'ds'
        assert merged['item_index'] == 1
