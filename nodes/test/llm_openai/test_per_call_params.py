# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""One LLM control serves calls on different models and temperatures (plan 4.1 rule 4, C.26).

The model, its token limits and the tuning leaves of every LLM node are
per-call parameters: the control's IGlobal builds ONE client from the
environment in ``beginGlobal`` and each request binds its call's values onto
it (``ChatBase.bound_llm``). These tests drive the real ``llm_openai``
IGlobal and IInstance through the two-replica harness, each call a fresh
instance with its caller's params, and the provider replaced by a recorder:

- two calls of one control with two models and two temperatures reach the
  provider with their own values, and the control's IGlobal and client are
  built once;
- the same calls alternating between two replicas answer exactly as one
  replica does (the balancer test);
- a parameter read through the control's ``IGlobal.config`` raises.
"""

from types import SimpleNamespace

import pytest
from rocketlib.config import ConfigError

from ai.common.schema import Question

from test.framework.replicas import NODES_DIR, Call, Owner, Replica, ReplicaServer, run

# ==== The node and its provider ==================================================

NODE_DIR = NODES_DIR / 'llm_openai'
NODE_ID = 'llm_1'
ALICE = Owner(orgId='org-a', userId='alice', config=(('model', 'gpt-4o'), ('apikey', 'sk-test')))

#: Every request the provider received: the values the call bound
SENT: list = []
#: Every LangChain object a replica built
BUILT: list = []


class _Bound:
    """One request's binding: answers with the values it carries."""

    def __init__(self, kwargs):
        self.kwargs = kwargs

    def stream(self, messages, **request):
        SENT.append(dict(self.kwargs))
        text = f'{self.kwargs["model"]} at {self.kwargs.get("temperature")}'
        yield SimpleNamespace(content=text, usage_metadata=None, response_metadata={'finish_reason': 'stop'})


class _ChatOpenAI:
    """Stand-in for langchain_openai.ChatOpenAI: no network, records what it was built with."""

    def __init__(self, **kwargs):
        self.kwargs = kwargs
        BUILT.append(self)

    def bind(self, **kwargs):
        return _Bound(kwargs)

    def stream(self, messages, **request):
        raise AssertionError('a request went out without its call values bound')

    def invoke(self, messages, **request):
        raise AssertionError('a request went out without its call values bound')

    def get_num_tokens(self, text):
        return len(text) // 4


class _OpenAI:
    """Stand-in for the raw openai client (the Responses path of reasoning models)."""

    def __init__(self, **kwargs):
        self.kwargs = kwargs


@pytest.fixture(autouse=True)
def _provider(monkeypatch):
    """The replicas import the node afresh, so the provider modules are patched where it imports from."""
    import langchain_openai
    import openai

    monkeypatch.setattr(langchain_openai, 'ChatOpenAI', _ChatOpenAI)
    monkeypatch.setattr(openai, 'OpenAI', _OpenAI)
    SENT.clear()
    BUILT.clear()


def _ask(owner, **params):
    """One call: a question on the questions lane, with the caller's params for this node."""

    def invoke(instance):
        question = Question()
        question.addQuestion('Say which model you are.')
        instance.writeQuestions(question)

    return Call(owner=owner, params=params, invoke=invoke)


def _answers(outputs):
    """The answer text each call wrote."""
    return [args[0].getText() for call in outputs for name, args in call if name == 'writeAnswers']


def _replica(server):
    """A replica of the node; its IGlobal's endpoint bag is the harness's (the chat never writes it)."""
    replica = Replica(server, NODE_DIR, 'llm_openai', NODE_ID)
    replica._global_class.IEndpoint = SimpleNamespace(endpoint=SimpleNamespace(bag={}))
    return replica


CALLS = [
    _ask(ALICE, temperature=0.2),
    _ask(ALICE, model='gpt-4.1', temperature=1.1),
    _ask(ALICE),
]


# ==== One control, many calls ====================================================


def test_one_control_serves_two_models_and_two_temperatures_without_a_rebuild():
    with ReplicaServer() as server:
        replica = _replica(server)
        try:
            outputs = run(CALLS, [replica])
            assert len(replica._globals) == 1, 'one control, one IGlobal'
        finally:
            replica.end()

    assert _answers(outputs) == ['gpt-4o at 0.2', 'gpt-4.1 at 1.1', 'gpt-4o at 0']
    assert SENT == [
        {'model': 'gpt-4o', 'max_tokens': 16384, 'temperature': 0.2},
        {'model': 'gpt-4.1', 'max_tokens': 32768, 'temperature': 1.1},
        {'model': 'gpt-4o', 'max_tokens': 16384, 'temperature': 0},
    ]
    assert len(BUILT) == 1, 'the client is built once, from the environment'
    assert BUILT[0].kwargs['api_key'] == 'sk-test'


def test_two_replicas_answer_as_one_does():
    with ReplicaServer() as server:
        pair = [_replica(server), _replica(server)]
        try:
            alternating = _answers(run(CALLS, pair))
        finally:
            for replica in pair:
                replica.end()
    with ReplicaServer() as server:
        alone = _replica(server)
        try:
            reference = _answers(run(CALLS, [alone]))
        finally:
            alone.end()

    assert alternating == reference == ['gpt-4o at 0.2', 'gpt-4.1 at 1.1', 'gpt-4o at 0']


def test_a_parameter_read_through_the_control_config_raises():
    with ReplicaServer() as server:
        replica = _replica(server)
        try:
            run(CALLS[:1], [replica])
            (glb,) = replica._globals.values()
            # The selector and the temperature are this branch's parameters; its token
            # limits are the branch's constants
            for key in ('model', 'temperature'):
                with pytest.raises(ConfigError, match=f'"{key}" is a parameter'):
                    glb.config[key]
            # What the environment decides stays the control's
            assert glb.config['apikey'] == 'sk-test'
        finally:
            replica.end()
