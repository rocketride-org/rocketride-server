# =============================================================================
# RocketRide Engine
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

"""
End-to-end guard for the engine's default-forward rule.

When a Python node overrides a lane handler (`writeQuestions`, `writeAnswers`,
`writeDocuments`, ...), the engine still calls the parent implementation after
the override returns - and the parent forwards the same payload downstream a
second time. The only way to suppress it is `preventDefault()`, which raises
`Ec::PreventDefault`; `__checkCallParent` (`engLib/python/call.hpp`) inspects
nothing else. So a node that forwards explicitly *and* returns normally
delivers every payload twice.

That rule lives in compiled C++, so a Python unit test cannot observe it - it
can only re-state the assumption it is trying to verify. This test measures it
instead: the same payload is pushed through two real pipelines, one with a
forwarding node in the middle and one without, and the deliveries counted at a
`response` sink. `response` appends one entry per delivery, so the entry count
IS the number of forwards.

    webhook -> response_<lane>                    (baseline)
    webhook -> guardrails -> response_<lane>      (with a forwarding node)

`guardrails` is the node under observation because it forwards on all three
lanes with no external dependency. Any node that forwards on its own lane would
serve; the rule being measured belongs to the engine, not to guardrails.

The questions and documents runs inject their payload straight onto the lane
(`lane/<name>` MIME), so they involve no model and no network. The answers run
needs a producer, because `Answer` rejects a preset `answer` field on
validation - `llm_openai_api` under `ROCKETRIDE_MOCK` supplies one offline.
"""

from __future__ import annotations

import json
import uuid
from typing import Any, Dict, List, Tuple

# `basic` keeps policy_mode at `warn`, so nothing is ever blocked and every
# payload reaches the sink. A blocking profile would make a missing delivery
# ambiguous: dropped on purpose, or lost?
GUARDRAILS = {'id': 'guard_1', 'provider': 'guardrails', 'config': {'profile': 'basic'}}

# Placeholder credentials only - the mock OpenAI SDK under ROCKETRIDE_MOCK
# answers without a network call. Mirrors _LLM_MOCK_CREDENTIALS in
# framework/pipeline.py.
LLM = {
    'id': 'llm_1',
    'provider': 'llm_openai_api',
    'config': {
        'profile': 'custom',
        'custom': {'apikey': 'sk-mock-placeholder-for-tests', 'model': 'mock-model'},
    },
}

QUESTION_PAYLOAD = json.dumps({'questions': [{'text': 'What is the weather today?'}]}).encode('utf-8')
DOCUMENT_PAYLOAD = json.dumps([{'page_content': 'RocketRide moves data through pipelines.'}]).encode('utf-8')


def _pipeline(components: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Wrap components into a runnable pipeline.

    Args:
        components: The component list, starting with the webhook source.

    Returns:
        A pipeline dict ready for `client.use()`, with a fresh `project_id` so
        repeated runs never collide with a still-registered pipeline.
    """
    return {'project_id': str(uuid.uuid4()), 'source': 'webhook_1', 'components': components}


def _chain(hops: List[Tuple[Dict[str, Any], str]], out_lane: str) -> Dict[str, Any]:
    """
    Build a straight webhook -> [hops] -> response pipeline.

    Each hop is wired to the component declared before it on its own input
    lane, so a hop that changes lane (an LLM consuming questions and producing
    answers) chains as naturally as one that stays on the same lane. Passing
    no hops yields the baseline pipeline for `out_lane`.

    Args:
        hops: Components between the webhook and the sink, each paired with the
            lane it reads from its predecessor.
        out_lane: The lane the response sink listens on.

    Returns:
        A pipeline dict ready for `client.use()`.
    """
    components: List[Dict[str, Any]] = [{'id': 'webhook_1', 'provider': 'webhook', 'config': {}, 'input': []}]

    prev = 'webhook_1'
    for component, in_lane in hops:
        components.append({**component, 'input': [{'lane': in_lane, 'from': prev}]})
        prev = component['id']

    components.append(
        {
            'id': 'response_1',
            'provider': f'response_{out_lane}',
            'config': {},
            'input': [{'lane': out_lane, 'from': prev}],
        }
    )
    return _pipeline(components)


async def _deliveries(client, pipeline: Dict[str, Any], lane: str, mime_type: str, payload: bytes) -> int:
    """
    Run one payload through a pipeline and count what reached the sink.

    The `response` node appends one entry per write it receives on the lane, so
    the length of that list is the number of times the payload was delivered.

    Args:
        client: Connected RocketRide client (fixture).
        pipeline: The pipeline to register and run.
        lane: The lane whose response entries are counted.
        mime_type: MIME type for the input pipe (`lane/<name>` targets a lane
            directly).
        payload: The bytes to write into the pipe.

    Returns:
        The number of entries the response sink captured on `lane`.
    """
    result = await client.use(pipeline=pipeline)
    token = result['token']

    try:
        pipe = await client.pipe(token, objinfo={'name': f'forward_once_{lane}'}, mime_type=mime_type)
        await pipe.open()
        await pipe.write(payload)
        response = await pipe.close()
    finally:
        # Each test runs two pipelines back to back, and the suite runs under
        # xdist. Leaving them registered piles up live tasks on the shared
        # server, which showed up as a refused connection on a later
        # `pipe.open()`. Same teardown as framework/runner.py.
        try:
            await client.terminate(token)
        except Exception:
            pass

    return len(response.get(lane) or [])


async def test_questions_lane_forwarded_once(client):
    """
    A node forwarding on the questions lane must not also emit the default.

    Args:
        client: Connected RocketRide client (fixture).
    """
    baseline = await _deliveries(client, _chain([], 'questions'), 'questions', 'lane/questions', QUESTION_PAYLOAD)
    assert baseline == 1, (
        f'the source itself delivered {baseline} questions, expected 1 - the run is not a valid baseline'
    )

    forwarded = await _deliveries(
        client, _chain([(GUARDRAILS, 'questions')], 'questions'), 'questions', 'lane/questions', QUESTION_PAYLOAD
    )
    assert forwarded == baseline, (
        f'guardrails delivered {forwarded} questions where the source delivered {baseline}. '
        f'Its writeQuestions forwards explicitly, so the engine must be told to skip its own '
        f'forward with preventDefault()'
    )


async def test_documents_lane_forwarded_once(client):
    """
    A node forwarding on the documents lane must not also emit the default.

    Args:
        client: Connected RocketRide client (fixture).
    """
    baseline = await _deliveries(client, _chain([], 'documents'), 'documents', 'lane/documents', DOCUMENT_PAYLOAD)
    assert baseline == 1, (
        f'the source itself delivered {baseline} documents, expected 1 - the run is not a valid baseline'
    )

    forwarded = await _deliveries(
        client, _chain([(GUARDRAILS, 'documents')], 'documents'), 'documents', 'lane/documents', DOCUMENT_PAYLOAD
    )
    assert forwarded == baseline, (
        f'guardrails delivered {forwarded} documents where the source delivered {baseline}. '
        f'Its writeDocuments forwards explicitly, so the engine must be told to skip its own '
        f'forward with preventDefault()'
    )


async def test_answers_lane_forwarded_once(client):
    """
    A node forwarding on the answers lane must not also emit the default.

    The answer comes from a mocked LLM rather than the pipe, because `Answer`
    refuses a preset `answer` field during validation - an injected answer
    would arrive empty and take the node's early-return path instead of the
    evaluated one.

    Args:
        client: Connected RocketRide client (fixture).
    """
    baseline = await _deliveries(
        client, _chain([(LLM, 'questions')], 'answers'), 'answers', 'lane/questions', QUESTION_PAYLOAD
    )
    assert baseline >= 1, 'the mocked LLM produced no answer - nothing to count'

    forwarded = await _deliveries(
        client,
        _chain([(LLM, 'questions'), (GUARDRAILS, 'answers')], 'answers'),
        'answers',
        'lane/questions',
        QUESTION_PAYLOAD,
    )
    assert forwarded == baseline, (
        f'guardrails delivered {forwarded} answers where the LLM alone delivered {baseline}. '
        f'Its writeAnswers forwards explicitly, so the engine must be told to skip its own '
        f'forward with preventDefault()'
    )
