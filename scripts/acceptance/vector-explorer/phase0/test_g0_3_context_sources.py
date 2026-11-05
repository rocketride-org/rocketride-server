# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""G0-3: what the call context says about the calling task and key, through the real engine.

- ``source_type`` is the provider of the task's source component: ``'tools'``,
  ``'chat'`` or ``'dropper'`` for the three VX sources. (The data connection's
  target endpoint is the pipeline's Null endpoint, whose logical type is
  ``'null'`` for every task, so it is not what the context reports.)
- ``caller.auth`` follows the key the connection signed in with: an account key
  is ``'account'``, a task token (``tk_``) is ``'task'``, a public task key
  (``pk_``) is ``'public'``. The key itself never appears in the context.

Needs the probe nodes: start the engine with --node_path=<repo>/nodes/test/vx_context_probe.
"""

from __future__ import annotations

import json
from typing import Any, Dict

import pytest

from phase0_lib import PROBE_SOURCES, client, record, run

pytestmark = pytest.mark.timeout(900)


async def _whoami(token: str, *, auth: str = None) -> Dict[str, Any]:
    async with client(auth=auth, timeout_ms=120_000) as c:
        return await c.tool(token=token, tool='whoami', node_id='receiver_1', input={})


def test_source_type_is_the_calling_tasks_source_provider(probe):
    """Each source task's tool calls carry its own source provider as source_type."""
    observed = {}
    for source_id, provider in PROBE_SOURCES.items():
        context = run(_whoami(probe[source_id]['token']))['context']
        observed[source_id] = context
        assert context['origin'] == 'dap'
        assert context['source_type'] == provider, (source_id, context)
        assert context['source_type'] != 'null'
    record('g0_3_source_types', observed)


def test_caller_kind_follows_the_key(probe):
    """Account key -> 'account', task token -> 'task', public task key -> 'public'; the key is never echoed."""
    tools = probe['tools_1']
    token = tools['token']
    public_key = tools['publicToken']
    assert token.startswith('tk_') and public_key.startswith('pk_')

    observed = {
        'account': run(_whoami(token))['context'],
        'task': run(_whoami(token, auth=token))['context'],
        'public': run(_whoami(token, auth=public_key))['context'],
    }
    for kind, context in observed.items():
        assert context['origin'] == 'dap'
        assert context['source_type'] == 'tools'
        assert context['caller']['auth'] == kind, (kind, context)
        assert set(context['caller']) == {'auth', 'userId', 'teamId', 'orgId'}
        flat = json.dumps(context)
        assert token not in flat and public_key not in flat
    record('g0_3_caller_kinds', observed)
