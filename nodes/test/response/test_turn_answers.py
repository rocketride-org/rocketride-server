"""The response node writes a turn-mode answer as one object; text and JSON answers stay as they were.

The end-to-end case runs the server side of ``client.chat()`` offline: the client's JSON is
parsed as data_conn parses it, the real llm_anthropic driver answers over a mocked HTTP
transport, LLMBase writes the answer, and the response node's result is read back with
``Answer.fromResult``, as a client would.
"""

import importlib.util
import json
import sys
from pathlib import Path

import pytest

from ai.common.config import Config
from ai.common.llm_base import LLMBase
from ai.common.schema import Answer, Question

ROOT = Path(__file__).resolve().parents[3]
NODES_SRC = ROOT / 'nodes' / 'src' / 'nodes'
while str(NODES_SRC) in sys.path:
    sys.path.remove(str(NODES_SRC))
sys.path.insert(0, str(NODES_SRC))

from response.IInstance import IInstance  # noqa: E402

FIXTURE = json.loads((ROOT / 'packages/client-python/tests/fixtures/turn_blocks.json').read_text(encoding='utf-8'))


class _Obj:
    def __init__(self):
        self.response = {}


class _Inst:
    def __init__(self):
        self.currentObject = _Obj()


class _Glob:
    laneName = None
    lanes = None


def _response_node() -> IInstance:
    node = IInstance.__new__(IInstance)
    node.instance = _Inst()
    node.IGlobal = _Glob()
    return node


def test_text_and_json_answers_are_written_as_before():
    node = _response_node()
    text, data = Answer(), Answer(expectJson=True)
    text.setAnswer('hello')
    data.setAnswer({'message': 'a JSON answer, not a turn'})

    node.writeAnswers(text)
    node.writeAnswers(data)

    assert node.instance.currentObject.response['answers'] == ['hello', {'message': 'a JSON answer, not a turn'}]


@pytest.mark.parametrize(
    'reasons, expected',
    [([None], None), (['done', 'done'], 'done'), (['done', 'max_steps', 'error'], 'max_steps')],
    ids=['no-agent', 'every-run-finished', 'first-unfinished-run-stands'],
)
def test_the_result_says_why_the_agent_runs_stopped(reasons, expected):
    """The answers keep their shape; stop_reason beside them is done only when every run finished (#3356)."""
    node = _response_node()
    for reason in reasons:
        answer = Answer()
        answer.setAnswer('C = 42')
        answer.agentStopReason = reason
        node.writeAnswers(answer)

    response = node.instance.currentObject.response
    assert response['answers'] == ['C = 42'] * len(reasons)
    assert response.get('stop_reason') == expected


def test_text_answers_keep_their_tokens_beside_them():
    """The entries stay plain strings, their counts are summed under `tokens`, and that key is not a lane."""
    node = _response_node()
    first, second, bare = Answer(), Answer(), Answer()
    first.setAnswer('one')
    first.tokens = {'input': 100, 'output': 10, 'cache_read': 50, 'cache_creation': 0, 'model': 'gpt-5.4'}
    second.setAnswer('two')
    second.tokens = {
        'input': 7,
        'output': 3,
        'cache_read': 0,
        'cache_creation': 20,
        'model': 'gpt-5.4',
        'calls': 2,
        'breakdown': [],
    }
    bare.setAnswer('three')  # no counts: adds nothing

    for answer in (first, second, bare):
        node.writeAnswers(answer)

    response = node.instance.currentObject.response
    assert response['answers'] == ['one', 'two', 'three']
    assert response['tokens'] == {'input': 107, 'output': 13, 'cache_read': 50, 'cache_creation': 20}
    assert 'tokens' not in response['result_types']


def _anthropic_chat(monkeypatch, bodies):
    pytest.importorskip('langchain_anthropic')
    import langchain_anthropic.chat_models as lca

    client = type(lca._get_default_httpx_client(base_url=None))
    lib = importlib.import_module(
        next(c.__module__ for c in client.__mro__ if c.__module__.startswith('httpx')).split('.')[0]
    )

    reply = {
        'id': 'msg_1',
        'type': 'message',
        'role': 'assistant',
        'model': 'claude-sonnet-4-6',
        'content': [
            {'type': 'text', 'text': 'Labelling #42.'},
            {'type': 'tool_use', 'id': 'toolu_03', 'name': 'tool_github_1__create_issue', 'input': {'labels': ['bug']}},
        ],
        'stop_reason': 'tool_use',
        'stop_sequence': None,
        'usage': {'input_tokens': 120, 'output_tokens': 18},
    }

    def transport(request):
        bodies.append(json.loads(request.content))
        return lib.Response(200, headers={'content-type': 'application/json'}, content=json.dumps(reply).encode())

    monkeypatch.setattr(
        lca,
        '_get_default_httpx_client',
        lambda **kw: lib.Client(transport=lib.MockTransport(transport), base_url=kw['base_url']),
    )
    config = {
        'model': 'claude-sonnet-4-6',
        'apikey': 'sk-ant-test',
        'modelTotalTokens': 200000,
        'modelOutputTokens': 8192,
    }
    monkeypatch.setattr(Config, 'getNodeConfig', staticmethod(lambda *a, **k: dict(config)))
    spec = importlib.util.spec_from_file_location('_turn_llm_anthropic', NODES_SRC / 'llm_anthropic' / 'anthropic.py')
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.Chat('llm_anthropic', {}, {})


class _LLMInner:
    """The LLM node's engine instance: its answers go straight to the response node."""

    def __init__(self, response_node: IInstance):
        self.writeAnswers = response_node.writeAnswers

    def sendSSE(self, *a, **k):
        pass


def _run(chat, question_json: str) -> dict:
    response = _response_node()
    llm = LLMBase.__new__(LLMBase)
    llm.IGlobal = type('G', (), {'_chat': chat})()
    llm.instance = _LLMInner(response)
    llm.writeQuestions(Question.model_validate_json(question_json))
    return response.instance.currentObject.response


def test_a_turn_from_client_json_to_result_and_back(monkeypatch):
    bodies = []
    result = _run(_anthropic_chat(monkeypatch, bodies), json.dumps(FIXTURE['question']))

    entry = result['answers'][0]
    assert set(entry) == {'message', 'stopReason', 'tokens'}
    assert bodies[0]['messages'][-1]['content'][0]['tool_use_id'] == 'toolu_01'
    answer = Answer.fromResult(json.loads(json.dumps(result)))
    assert answer.stopReason == 'tool_use'
    assert answer.getText() == 'Labelling #42.'
    assert [(c.id, c.name, c.args) for c in answer.toolCalls()] == [
        ('toolu_03', 'tool_github_1.create_issue', {'labels': ['bug']})
    ]
    assert answer.tokens['output'] == 18


def test_a_refused_turn_reaches_the_client_as_a_typed_error():
    class _NoTools:
        _model = 'some-model'

        def chat(self, question):
            raise AssertionError('the provider must not be called')

    result = _run(_NoTools(), json.dumps(FIXTURE['question']))

    assert Answer.fromResult(result).error.code == 'tools_unsupported'
