"""
Grounding through a real engine, from an empty search to what the user receives.

The node-level tests simulate the engine's default-forward rule, which lives in
compiled C++. This runs the same path on a live server instead:

    webhook -> elasticsearch (empty index) -> questions -> llm -> answers -> guardrails -> response
                            \\-> documents ----------------------------------^

Elasticsearch searches an index that holds nothing, so it dispatches an empty
`documents` batch, and only then does the engine forward the question to the
mocked LLM, whose answer states a figure. That order is fixed by the chain, so the
test does not depend on how the engine schedules siblings.

Under Strict the user must receive exactly one answer, the refusal. Under Basic,
which leaves `require_grounding` off, the same pipeline must deliver the model's
answer unchanged, which shows the Strict result comes from grounding and not from
a pipeline that delivers nothing useful either way.
"""

from __future__ import annotations

import json
import uuid
from typing import Any, Dict, List

# The mocked LLM answers this prompt with a figure; see mocks/langchain_openai.
QUESTION_PAYLOAD = json.dumps({'questions': [{'text': 'grounding-probe: what was net income in FY2024?'}]}).encode(
    'utf-8'
)
REFUSAL = "I couldn't find anything in the available documents to answer that."
MODEL_ANSWER = 'Net income was $94.7B in FY2024.'

LLM = {
    'id': 'llm_1',
    'provider': 'llm_openai_api',
    'config': {
        'profile': 'custom',
        'custom': {'apikey': 'sk-mock-placeholder-for-tests', 'model': 'mock-model'},
    },
}


def _pipeline(guardrails_profile: str, judge: bool = False) -> Dict[str, Any]:
    """The chain above, with guardrails on the given profile and a fresh empty index.

    With *judge*, a second LLM node is guardrails' `llm` connection. It has to be a
    node of its own: the engine refuses a pipeline whose answering LLM is also a
    control connection, since a control node's sub-pipeline cannot be shared.
    """
    index = f'grounding-live-{uuid.uuid4().hex}'
    components: List[Dict[str, Any]] = [
        {'id': 'webhook_1', 'provider': 'webhook', 'config': {}, 'input': []},
        {
            'id': 'es_1',
            'provider': 'elasticsearch',
            'config': {'profile': 'self-managed', 'self-managed': {'store_mode': 'index', 'index': index}},
            'input': [{'lane': 'questions', 'from': 'webhook_1'}],
        },
        {**LLM, 'input': [{'lane': 'questions', 'from': 'es_1'}]},
        {
            'id': 'guard_1',
            'provider': 'guardrails',
            'config': {'profile': guardrails_profile},
            'input': [{'lane': 'answers', 'from': 'llm_1'}, {'lane': 'documents', 'from': 'es_1'}],
        },
        {
            'id': 'response_1',
            'provider': 'response_answers',
            'config': {},
            'input': [{'lane': 'answers', 'from': 'guard_1'}],
        },
    ]
    if judge:
        components.append({**LLM, 'id': 'llm_judge', 'control': [{'classType': 'llm', 'from': 'guard_1'}]})
    return {'project_id': str(uuid.uuid4()), 'source': 'webhook_1', 'components': components}


async def _delivered(client, pipeline: Dict[str, Any]) -> List[Any]:
    """Run the question through *pipeline* and return what reached the answers sink."""
    result = await client.use(pipeline=pipeline)
    token = result['token']
    try:
        pipe = await client.pipe(token, objinfo={'name': 'grounding_live'}, mime_type='lane/questions')
        await pipe.open()
        await pipe.write(QUESTION_PAYLOAD)
        response = await pipe.close()
    finally:
        try:
            await client.terminate(token)
        except Exception:
            pass
    return response.get('answers') or []


def _texts(entries: List[Any]) -> List[str]:
    """The answer text of each delivered entry, whatever shape the sink records."""
    texts = []
    for entry in entries:
        if isinstance(entry, dict):
            texts.append(str(entry.get('answer', entry)))
        else:
            texts.append(str(entry))
    return texts


async def test_strict_replaces_a_figure_after_an_empty_search(client):
    delivered = _texts(await _delivered(client, _pipeline('strict')))

    assert delivered == [REFUSAL], f'expected one refusal, the user received {delivered!r}'


async def test_basic_delivers_the_same_answer_unchanged(client):
    delivered = _texts(await _delivered(client, _pipeline('basic')))

    assert delivered == [MODEL_ANSWER], f'expected the model answer once, the user received {delivered!r}'


async def test_a_connected_llm_decides_instead_of_the_figure_rule(client):
    """The check goes through the engine's control plane to the llm connection.

    The mocked check clears every answer, so the model's answer arriving unchanged
    shows the call went through and its verdict was used. The figure-rule fallback
    would have delivered the refusal instead.
    """
    delivered = _texts(await _delivered(client, _pipeline('strict', judge=True)))

    assert delivered == [MODEL_ANSWER], f'expected the cleared answer once, the user received {delivered!r}'
