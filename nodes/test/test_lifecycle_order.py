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
End-to-end guard for the pipeline lifecycle dispatch order.

`bindFilters` binds each region's open/closing/close flat onto that region's
root - closing/close upstream-first, open reversed - so a merging (join) node is
flushed only after every upstream branch has flushed. The unit tests
(`store::lifecycleOrder`, `store::lifecycleRegions`) cover the ordering
algorithm; this covers the binding that consumes it, which is where a silent
regression would live: drop the guard in `bindFilters` and every unit test still
passes while a join starts losing a branch's flush-time output.

The pipeline is a diamond of buffer-and-flush nodes - `prompt` forwards what it
is written straight away AND accumulates it, emitting the merged question only
on `closing()`:

    webhook -> branch_a -\\
    webhook -> branch_b --> join -> response

So each branch reaches the join twice: once forwarded at write time, once when
the branch flushes. The join's own merged question therefore holds exactly two
entries per branch. If the join were flushed before a branch (declaration order
instead of dependency order), that branch's flush would land on an
already-flushed join and be dropped, leaving the join's merge one entry short
per late branch.

No LLM, agent or mock is involved: `prompt` merges locally, so the run is
deterministic.
"""

from __future__ import annotations

import json
import uuid

# The whole chain runs on the `questions` lane: `prompt` only produces output
# for a `questions` input.
#
# `join_1` and its response are declared BEFORE the branches that feed them, on
# purpose: dispatching in declaration order would flush the join before either
# branch, so this ordering is what makes the test adversarial.
COMPONENTS = [
    {'id': 'webhook_1', 'provider': 'webhook', 'config': {}, 'input': []},
    {
        'id': 'join_1',
        'provider': 'prompt',
        'config': {'instructions': ['Merge every branch contribution.']},
        'input': [
            {'lane': 'questions', 'from': 'branch_a'},
            {'lane': 'questions', 'from': 'branch_b'},
        ],
    },
    {
        'id': 'response_1',
        'provider': 'response_questions',
        'config': {},
        'input': [{'lane': 'questions', 'from': 'join_1'}],
    },
    {
        'id': 'branch_a',
        'provider': 'prompt',
        'config': {'instructions': ['Contribution from branch A.']},
        'input': [{'lane': 'questions', 'from': 'webhook_1'}],
    },
    {
        'id': 'branch_b',
        'provider': 'prompt',
        'config': {'instructions': ['Contribution from branch B.']},
        'input': [{'lane': 'questions', 'from': 'webhook_1'}],
    },
]

# Each branch reaches the join twice - forwarded when it is written, and again
# when it flushes - so the join's merged question holds two entries per branch.
EXPECTED_JOIN_ENTRIES = 4


def _diamond_pipeline() -> dict:
    """
    Build the buffer-and-flush diamond pipeline.

    Returns:
        A pipeline dict ready for `client.use()`, with a fresh `project_id` so
        repeated runs never collide with a still-registered pipeline.
    """
    return {'project_id': str(uuid.uuid4()), 'source': 'webhook_1', 'components': COMPONENTS}


def _join_merge_size(response: dict) -> int:
    """
    Measure the join's merged question in the response.

    Every question the response captured is one write; the join's own merge is
    the largest of them, since it holds everything that reached the join.

    Args:
        response: The response payload returned for the run.

    Returns:
        The number of entries in the join's merged question, or 0 when the
        response carried no questions at all.
    """
    written = response.get('questions') or []
    return max((len(item.get('questions') or []) for item in written), default=0)


async def test_join_flushes_after_every_branch(client):
    """
    A join must receive every branch's flush-time output before it flushes.

    Args:
        client: Connected RocketRide client (fixture).
    """
    result = await client.use(pipeline=_diamond_pipeline())
    token = result['token']

    payload = json.dumps({'questions': [{'text': 'Summarize both branches.'}]}).encode('utf-8')
    pipe = await client.pipe(token, objinfo={'name': 'lifecycle_diamond'}, mime_type='lane/questions')
    await pipe.open()
    await pipe.write(payload)
    response = await pipe.close()

    merged = _join_merge_size(response)
    assert merged == EXPECTED_JOIN_ENTRIES, (
        f'the join merged {merged} entries, expected {EXPECTED_JOIN_ENTRIES} (two per '
        f'branch: forwarded + flushed) - a branch flushed after the join, so its '
        f'flush-time output was dropped. Response: {response!r}'
    )
