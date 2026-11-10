# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Live evaluation of on-demand tool schemas in RocketRide Wave (opt-in).

Eight tasks against the stub MCP server serving 30 and 200 generated tools, with
every schema in the prompt (budget 0) and with schemas loaded on demand (budget 1),
through a running engine and a real LLM node. Each task runs the agent as a tool
(``Pipe.tool``), so the envelope carries the trace and ``meta.usage``.
``agent_rocketride/live_eval.py`` scores each task from the stub's call log and the
answer, and reads the usage.

Skipped unless all of these are set:

    RR_LIVE_TOOL_CATALOG=1
    RR_LIVE_LLM=llm_openai | llm_anthropic | llm_openai_api
    ROCKETRIDE_URI (a reachable engine)

``llm_openai`` and ``llm_anthropic`` read ``${ROCKETRIDE_OPENAI_KEY}`` and
``${ROCKETRIDE_ANTHROPIC_KEY}`` on the engine side; RR_LIVE_LLM_PROFILE picks the
model profile. ``llm_openai_api`` (an OpenAI-compatible server) also needs
RR_LIVE_LLM_URL and RR_LIVE_LLM_MODEL, and reads RR_LIVE_LLM_KEY. RR_LIVE_CELLS
picks cells, as ``tools:budget`` pairs separated by commas (default
``30:0,30:1,200:0,200:1``). RR_LIVE_STUB_PYTHON is the interpreter that runs the
stub server (default: this test's).

    RR_LIVE_TOOL_CATALOG=1 RR_LIVE_LLM=llm_openai ROCKETRIDE_URI=http://localhost:5565 \\
        ./builder nodes:test-full --pytest-pattern="tool_catalog_full" --pytest="-s"

The pipelines it starts are terminated when it ends. The report is printed, and
every task's record is written to RR_LIVE_REPORT (default: tool_catalog_live.json
in the temp directory).
"""

import datetime
import importlib.util
import json
import os
import sys
import tempfile
import uuid
from pathlib import Path

import pytest

_HERE = Path(__file__).resolve().parent
_STUB = _HERE / 'tool_mcp_client' / 'stub_mcp_server.py'
_REPORT = Path(os.environ.get('RR_LIVE_REPORT') or Path(tempfile.gettempdir()) / 'tool_catalog_live.json')

_spec = importlib.util.spec_from_file_location('_rr_live_eval', _HERE / 'agent_rocketride' / 'live_eval.py')
live_eval = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = live_eval
_spec.loader.exec_module(live_eval)

_LLM = os.environ.get('RR_LIVE_LLM', '')

pytestmark = pytest.mark.skipif(
    os.environ.get('RR_LIVE_TOOL_CATALOG') != '1' or _LLM not in ('llm_openai', 'llm_anthropic', 'llm_openai_api'),
    reason='live evaluation: set RR_LIVE_TOOL_CATALOG=1 and RR_LIVE_LLM (see the module docstring)',
)

AGENT = 'agent_rocketride_1'
MCP = 'tool_mcp_client_1'


def _llm_component():
    if _LLM == 'llm_openai':
        profile = os.environ.get('RR_LIVE_LLM_PROFILE', 'openai-5-mini')
        config = {'profile': profile, profile: {'apikey': '${ROCKETRIDE_OPENAI_KEY}'}, 'parameters': {}}
    elif _LLM == 'llm_anthropic':
        profile = os.environ.get('RR_LIVE_LLM_PROFILE', 'claude-haiku-4-5')
        config = {'profile': profile, profile: {'apikey': '${ROCKETRIDE_ANTHROPIC_KEY}'}, 'parameters': {}}
    else:
        custom = {
            'model': os.environ['RR_LIVE_LLM_MODEL'],
            'base_url': os.environ['RR_LIVE_LLM_URL'],
            'apikey': os.environ.get('RR_LIVE_LLM_KEY', 'unused'),
            'modelTotalTokens': 400000,
            'modelOutputTokens': 4096,
        }
        config = {'profile': 'custom', 'custom': custom, 'parameters': {}}
    return {'id': 'llm_1', 'provider': _LLM, 'config': config, 'control': [{'classType': 'llm', 'from': AGENT}]}


def _pipeline(tools_file: Path, calls_log: Path, budget: int, verify_tool: str = ''):
    python = os.environ.get('RR_LIVE_STUB_PYTHON') or sys.executable
    command = f'{python} {_STUB} --tools-file {tools_file} --calls-log {calls_log}'
    agent_config = {'instructions': [], 'parameters': {}, 'max_waves': 8, 'tool_catalog_budget': budget}
    if verify_tool:
        agent_config['verify_tool'] = f'{MCP}.stub.{verify_tool}'
    return {
        'components': [
            {
                'id': 'chat_1',
                'provider': 'chat',
                'config': {'hideForm': True, 'mode': 'Source', 'parameters': {}, 'type': 'chat'},
            },
            {
                'id': AGENT,
                'provider': 'agent_rocketride',
                'config': agent_config,
                'input': [{'lane': 'questions', 'from': 'chat_1'}],
            },
            _llm_component(),
            {
                'id': MCP,
                'provider': 'mcp_client',
                'config': {'serverName': 'stub', 'transport': 'stdio', 'stdio': {'commandLine': command}},
                'control': [{'classType': 'tool', 'from': AGENT}],
            },
            {
                'id': 'memory_1',
                'provider': 'memory_internal',
                'config': {'type': 'memory_internal'},
                'control': [{'classType': 'memory', 'from': AGENT}],
            },
            {
                'id': 'response_1',
                'provider': 'response_answers',
                'config': {'laneName': 'answers'},
                'input': [{'lane': 'answers', 'from': AGENT}],
            },
        ],
        'source': 'chat_1',
        'project_id': str(uuid.uuid4()),
        'version': 1,
    }


def _log_lines(path: Path):
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding='utf-8').splitlines() if line.strip()]


def _cells():
    raw = os.environ.get('RR_LIVE_CELLS', '30:0,30:1,200:0,200:1')
    return [tuple(int(x) for x in cell.split(':')) for cell in raw.split(',') if cell.strip()]


async def _run_task(client, token, task):
    pipe = await client.pipe(token, {'name': f'task-{task.id}'}, 'application/rocketride-question')
    await pipe.open()
    try:
        return await pipe.tool(tool='run_agent', node_id=AGENT, input={'query': task.prompt})
    finally:
        await pipe.close()


async def _run_cell(client, n_tools: int, budget: int, workdir: Path):
    tools_file, calls_log = workdir / f'tools_{n_tools}.json', workdir / f'calls_{n_tools}_{budget}.jsonl'
    tools_file.write_text(json.dumps(live_eval.generate_catalog(n_tools)), encoding='utf-8')
    calls_log.write_text('', encoding='utf-8')
    runs = []
    # verify_tool is node config, so the task that sets one runs on its own pipeline.
    groups = {}
    for task in live_eval.TASKS:
        groups.setdefault(task.verify_tool, []).append(task)
    for verify_tool, tasks in groups.items():
        token = (await client.use(pipeline=_pipeline(tools_file, calls_log, budget, verify_tool), ttl=900))['token']
        try:
            for task in tasks:
                mark = len(_log_lines(calls_log))
                envelope = await _run_task(client, token, task)
                envelope = envelope if isinstance(envelope, dict) else {}
                log = _log_lines(calls_log)[mark:]
                stack = envelope.get('stack') or [{}]
                payload = stack[0].get('payload') if isinstance(stack[0], dict) else {}
                payload = payload if isinstance(payload, dict) else {}
                skipped = sum(
                    1
                    for w in payload.get('waves') or []
                    for r in w.get('results') or []
                    if r.get('tool') == 'reply-check' and str(r.get('error', '')).startswith('Skipped:')
                )
                solved, reasons = live_eval.score(task, log, payload.get('stop_reason'), envelope.get('content', ''))
                catalog = payload.get('tool_catalog') or {}
                runs.append(
                    {
                        'task': task.id,
                        'solved': solved,
                        'reasons': reasons,
                        'stop_reason': payload.get('stop_reason'),
                        'planning_steps': payload.get('planning_steps'),
                        'skipped': skipped,
                        'usage': live_eval.normalize_usage((envelope.get('meta') or {}).get('usage')),
                        'mode': catalog.get('mode'),
                        'fallback_step': catalog.get('fallback_step'),
                        'loaded_tools': payload.get('loaded_tools'),
                        'log': log,
                        'answer': envelope.get('content', ''),
                    }
                )
        finally:
            await client.terminate(token)
    return {
        'tools': n_tools,
        'budget': budget,
        'model': os.environ.get('RR_LIVE_LLM_MODEL') or os.environ.get('RR_LIVE_LLM_PROFILE') or _LLM,
        'date': datetime.date.today().isoformat(),
        'runs': runs,
    }


async def test_tool_catalog_live_evaluation(client):
    cells = []
    with tempfile.TemporaryDirectory() as tmp:
        for n_tools, budget in _cells():
            cells.append(await _run_cell(client, n_tools, budget, Path(tmp)))
    _REPORT.write_text(live_eval.dumps(cells), encoding='utf-8')
    print('\n' + live_eval.format_report(cells))
    print(f'records: {_REPORT}')

    by_cell = {(c['tools'], c['budget']): c for c in cells}
    for (n_tools, budget), cell in by_cell.items():
        if budget != 0:
            continue
        failed = {r['task']: r['reasons'] for r in cell['runs'] if not r['solved']}
        assert not failed, f'every schema in the prompt ({n_tools} tools) must solve all tasks first: {failed}'
    for (n_tools, budget), cell in by_cell.items():
        if budget == 0:
            continue
        failed = {r['task']: r['reasons'] for r in cell['runs'] if not r['solved']}
        assert not failed, f'compact catalog, {n_tools} tools, budget {budget}: {failed}'
        eager = by_cell.get((n_tools, 0))
        if eager:
            steps = sum(r['planning_steps'] or 0 for r in cell['runs']) / len(cell['runs'])
            eager_steps = sum(r['planning_steps'] or 0 for r in eager['runs']) / len(eager['runs'])
            assert steps <= eager_steps + 1, f'{n_tools} tools: {steps:.1f} planning steps against {eager_steps:.1f}'
        if n_tools == 200 and eager:
            both = cell['runs'] + eager['runs']
            assert all(r['usage'] for r in both), 'usage unavailable for some runs; no token claim can be made'
            compact_tokens = sum(r['usage']['prompt_tokens'] for r in cell['runs']) / len(cell['runs'])
            eager_tokens = sum(r['usage']['prompt_tokens'] for r in eager['runs']) / len(eager['runs'])
            assert compact_tokens < eager_tokens, (
                f'prompt tokens: compact {compact_tokens:,.0f}, eager {eager_tokens:,.0f}'
            )
