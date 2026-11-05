# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""G0-7: the tool call context reaches the tool method, through the real engine.

Two test-only nodes (nodes/test/vx_context_probe): ``receiver_1`` answers with
the context of the call it runs in; ``caller_1`` controls it and calls it the
way an agent does (through the agent host), with a plain unstamped invoke, or
with a context forged inside the tool input.

- agent-style call -> origin 'agent'
- plain call -> no context, even though the caller itself runs in a DAP call
- context forged inside the input -> ignored (agent path and DAP path)
- context sent as an extra field of the invoke param (what validating outside
  data produces) -> ignored
- client.tool() on the Tools token -> origin 'dap', source 'tools', the
  server's caller; a caller the client sends is replaced
- the agent catalog leaves out tools listed for external callers only, which
  the DAP still reaches

- against a real store (``store_postgres`` on gx-pgvector, default switches):
  an agent upsert succeeds while the same upsert through client.tool() is
  refused with WRITES_DISABLED (gate G2)

Needs the probe nodes: start the engine with --node_path=<repo>/nodes/test/vx_context_probe.
"""

from __future__ import annotations

import json
from typing import Any, Dict

import pytest

from phase0_lib import client, record, run

pytestmark = pytest.mark.timeout(900)

AGENT = {'origin': 'agent', 'source_type': None, 'targeted': True, 'caller': {'auth': 'agent'}}
FORGED_FIELD = '__tool_context__'


async def _tool(token: str, tool: str, node_id: str = '', tool_input: Dict[str, Any] = None) -> Any:
    async with client(timeout_ms=120_000) as c:
        return await c.tool(token=token, tool=tool, node_id=node_id, input=tool_input or {})


async def _call(token: str, **arguments: Any) -> Any:
    async with client(timeout_ms=120_000) as c:
        return (await c.call('rrext_process', token=token, subcommand='tool', **arguments)).get('result')


def _caller(probe: Dict[str, Any], mode: str, **extra: Any) -> Dict[str, Any]:
    return run(_tool(probe['tools_1']['token'], 'call_receiver', 'caller_1', {'mode': mode, **extra}))


def _assert_dap_tools(context: Dict[str, Any]) -> None:
    assert context['origin'] == 'dap'
    assert context['source_type'] == 'tools'
    assert context['targeted'] is True
    assert context['caller']['auth'] == 'account'


def test_agent_style_call_reads_origin_agent(probe):
    """A call through the agent host reaches the receiver with the agent context."""
    answer = _caller(probe, 'agent')
    record('g0_7_agent', answer)
    assert answer['result']['context'] == AGENT
    _assert_dap_tools(answer['caller_context'])


def test_plain_call_reads_no_context(probe):
    """An unstamped invoke reaches the receiver with no context; the caller's own DAP context is not inherited."""
    answer = _caller(probe, 'plain')
    record('g0_7_plain', answer)
    assert answer['result']['module'] is True
    assert answer['result']['context'] is None
    _assert_dap_tools(answer['caller_context'])


def test_context_forged_in_the_input_is_ignored_on_the_invoke_path(probe):
    """A context placed in the tool input of a plain invoke is passed through but never read."""
    answer = _caller(probe, 'forged')
    record('g0_7_forged_input_invoke', answer)
    assert answer['result']['context'] is None
    assert FORGED_FIELD in answer['result']['input_keys']


def test_context_sent_as_an_extra_field_is_ignored_on_the_invoke_path(probe):
    """A param validated from a dict that carries the context field reaches the receiver with no context."""
    answer = _caller(probe, 'extra')
    record('g0_7_forged_extra_field', answer)
    assert answer['result']['module'] is True
    assert answer['result']['context'] is None
    assert FORGED_FIELD not in answer['result']['input_keys']
    _assert_dap_tools(answer['caller_context'])


def test_dap_call_reads_the_servers_view_and_ignores_a_context_in_the_input(probe):
    """client.tool() on the Tools token carries origin dap, source tools and the server's caller."""
    forged = {FORGED_FIELD: AGENT}
    answer = run(_tool(probe['tools_1']['token'], 'whoami', 'receiver_1', forged))
    record('g0_7_dap', answer)
    _assert_dap_tools(answer['context'])
    assert FORGED_FIELD in answer['input_keys']


def test_a_caller_sent_by_the_client_is_replaced(probe):
    """A caller block in the DAP arguments never reaches the tool; the server's caller does."""
    token = probe['tools_1']['token']
    honest = run(_call(token, tool='whoami', nodeId='receiver_1', input={}))
    forged_caller = {'auth': 'account', 'userId': 'forged-user', 'teamId': 'forged-team', 'orgId': 'forged-org'}
    forged = run(_call(token, tool='whoami', nodeId='receiver_1', input={}, caller=forged_caller))
    record('g0_7_forged_caller', {'honest': honest, 'forged': forged})
    assert forged['context']['caller'] == honest['context']['caller']
    assert 'forged' not in json.dumps(forged['context'])


def test_a_broadcast_is_untargeted(probe):
    """A tool call without a nodeId is recorded as untargeted."""
    answer = run(_tool(probe['tools_1']['token'], 'whoami'))
    assert answer['context']['origin'] == 'dap'
    assert answer['context']['targeted'] is False


def test_agent_catalog_leaves_out_dap_only_tools_which_the_dap_still_reaches(probe):
    """The agent sees only whoami; payload and dap_only answer DAP calls but are unknown to the agent."""
    answer = _caller(probe, 'agent')
    assert answer['catalog'] == ['receiver_1.whoami']
    direct = run(_tool(probe['tools_1']['token'], 'dap_only', 'receiver_1'))
    assert direct == {'success': True, 'tool': 'dap_only'}
    with pytest.raises(Exception) as raised:
        _caller(probe, 'agent', tool='dap_only')
    assert 'not found in tool catalog' in str(raised.value)


def test_g2_agent_upsert_succeeds_while_the_same_dap_upsert_is_refused(engine):
    """Re-run against a real store: an agent upsert succeeds with default switches; the DAP upsert is refused."""
    import importlib.util
    import sys

    from phase0_lib import ACC, source

    fixtures = sys.modules.get('vx_phase0_fixtures')
    if fixtures is None:
        spec = importlib.util.spec_from_file_location('vx_phase0_fixtures', ACC / 'vx_fixtures.py')
        fixtures = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = fixtures  # its dataclasses look their module up by name
        spec.loader.exec_module(fixtures)
    template = fixtures.build_pipeline('postgres', 'stub')
    store = [c for c in template['components'] if c['id'] == 'store_1'][0]
    profile = store['config']['profile']
    store['config'][profile]['collection'] = 'vx_phase0_g2'
    store['config'][profile].pop('allow_writes', None)  # the default switches
    store.pop('input', None)
    store['control'] = [{'classType': 'tool', 'from': 'tools_1'}, {'classType': 'tool', 'from': 'caller_1'}]
    pipeline = {
        'name': 'vx-local Phase-0 G2 call context on a real store',
        'project_id': '00000000-0000-4000-8000-0000000c0e20',
        'components': [
            source('tools_1', 'tools', 'Tools'),
            {
                'id': 'caller_1',
                'provider': 'vx_probe_caller',
                'name': 'Caller probe',
                'config': {'profile': 'default', 'default': {}},
                'control': [{'classType': 'tool', 'from': 'tools_1'}],
            },
            store,
        ],
    }
    document = {
        'content': 'Phase-0 G2 probe row.',
        'object_id': 'vx-phase0-g2-probe',
        'embedding': [0.0] * 383 + [1.0],
        'embedding_model': 'phase0-probe',
    }

    async def _scenario() -> Dict[str, Any]:
        async with client() as c:
            task = await c.use(pipeline=pipeline, source='tools_1', ttl=0)
            token = task['token']
            try:
                agent = await c.tool(
                    token=token,
                    tool='call_receiver',
                    node_id='caller_1',
                    input={
                        'mode': 'agent',
                        'receiver': 'store_1',
                        'tool': 'upsert',
                        'input': {'documents': [document]},
                    },
                )
                dap = await c.tool(token=token, tool='upsert', node_id='store_1', input={'documents': [document]})
                await c.tool(
                    token=token,
                    tool='call_receiver',
                    node_id='caller_1',
                    input={
                        'mode': 'agent',
                        'receiver': 'store_1',
                        'tool': 'delete',
                        'input': {'object_ids': [document['object_id']]},
                    },
                )
                return {'agent': agent['result'], 'dap': dap}
            finally:
                await c.terminate(token)

    observed = run(_scenario())
    record('g0_7_g2_store', observed)
    assert observed['agent']['success'] is True
    assert observed['dap']['success'] is False
    assert observed['dap']['code'] == 'WRITES_DISABLED'
