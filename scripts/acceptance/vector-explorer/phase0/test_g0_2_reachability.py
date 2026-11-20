# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""G0-2: which template nodes a tool call on the Tools token reaches.

A tool call names a node; the engine looks for it in the calling task's
pipeline chain. On the Tools token, ``store_1``, ``store_2``, ``embed_1`` and
``llm_1`` are in the chain (a tool they do not have answers "No handler found"),
while ``parse_1`` and ``chunk_1`` are not ("not found in pipeline"). The Chat
token reaches the same nodes as the Tools token, ``store_1`` included.
"""

from __future__ import annotations

from typing import Dict

import pytest

from phase0_lib import FIXTURES, client, record, run

pytestmark = pytest.mark.timeout(1800)

NO_SUCH_TOOL = 'vx_phase0_no_such_tool'

IN_CHAIN = ('store_1', 'store_2', 'embed_1', 'llm_1')
NOT_IN_CHAIN = ('parse_1', 'chunk_1')


async def _probe(token: str, nodes) -> Dict[str, str]:
    answers: Dict[str, str] = {}
    async with client(timeout_ms=120_000) as c:
        for node in nodes:
            try:
                await c.tool(token=token, tool=NO_SUCH_TOOL, node_id=node, input={})
                answers[node] = 'answered'
            except Exception as e:  # noqa: BLE001 - the error text is what is pinned
                answers[node] = str(e).splitlines()[0]
    return answers


@pytest.mark.parametrize('source_id', ['tools_1', 'chat_1'])
def test_tool_token_reach(vx_fixtures, source_id):
    """store_1/store_2/embed_1/llm_1 are reachable from the Tools and Chat tokens; parse_1/chunk_1 are not."""
    observed = {}
    for key in FIXTURES:
        token = vx_fixtures['tasks'][key][source_id]['token']
        answers = run(_probe(token, IN_CHAIN + NOT_IN_CHAIN))
        observed[key] = answers
        for node in IN_CHAIN:
            assert answers[node] == f'No handler found for tool "{NO_SUCH_TOOL}" on node "{node}"', (key, node)
        for node in NOT_IN_CHAIN:
            assert answers[node] == f'Node "{node}" not found in pipeline', (key, node)
    record(f'g0_2_reach_{source_id}', observed)
