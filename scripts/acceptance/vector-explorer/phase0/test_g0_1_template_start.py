# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""G0-1 and G0-1b: the Vector Explorer templates start, and what the raw template does.

G0-1: a template started through ``start_fixtures.py --llm stub`` runs its three
sources (``tools_1``, ``chat_1``, ``ingest_1``) under the fixture's project id,
with no idle timeout, and the parser excludes a file over the template's size cap.
The parser does not fail such an object: the upload answers ``complete`` and the
ingest task's status gains an ``Excluded`` warning naming the file and the limit,
which is what the pin checks.

G0-1b: the raw template (placeholder LLM key, empty ``base_url``) starts its chat
source, and a chat answers with the LLM error as its answer text instead of
failing the call. The exact text is recorded in out/phase0/g0_1b_raw_template_chat.json.
"""

from __future__ import annotations

import ast
import asyncio
import importlib.util
import os
import sys
import time
from typing import Any, Dict

import pytest

from phase0_lib import (
    ACC,
    FIXTURE_PROJECT_IDS,
    FIXTURES,
    OUT_DIR,
    TEMPLATE_SOURCES,
    client,
    record,
    run,
)

pytestmark = pytest.mark.timeout(1800)

# The size cap every template pins on parse_1 (bytes).
TEMPLATE_MAX_FILE_SIZE = 52_428_800

RAW_PROJECT_ID = '00000000-0000-4000-8000-0000000d1b01'
RAW_COLLECTION = os.environ.get('VX_PHASE0_RAW_COLLECTION', 'vx_phase0_raw')


def _load_fixtures() -> Any:
    """vx_fixtures.py: the pipelines start_fixtures.py starts and the call that starts them."""
    if 'vx_phase0_fixtures' in sys.modules:
        return sys.modules['vx_phase0_fixtures']
    spec = importlib.util.spec_from_file_location('vx_phase0_fixtures', ACC / 'vx_fixtures.py')
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module  # its dataclasses look their module up by name
    spec.loader.exec_module(module)
    return module


def test_every_fixture_runs_its_three_sources_under_its_project_id(vx_fixtures):
    """Each started template has tools_1, chat_1 and ingest_1 running under the fixture's project id."""
    observed: Dict[str, Any] = {}
    for key in FIXTURES:
        tasks = vx_fixtures['tasks'][key]
        observed[key] = sorted(tasks)
        assert set(TEMPLATE_SOURCES) <= set(tasks), f'{key}: running sources {sorted(tasks)}'
        for source_id in TEMPLATE_SOURCES:
            pipeline = tasks[source_id].get('pipeline') or {}
            assert pipeline.get('project_id') == FIXTURE_PROJECT_IDS[key]
            assert tasks[source_id].get('token', '').startswith('tk_')
    record('g0_1_sources', {'fixtures': observed, 'start_output': vx_fixtures['output']})


def _calls(tree: ast.AST, name: str) -> list:
    return [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and (getattr(node.func, 'attr', None) == name or getattr(node.func, 'id', None) == name)
    ]


def test_start_fixtures_starts_every_source_without_an_idle_timeout():
    """start_fixtures.py starts each source with ttl=0, so the engine never stops it as idle.

    It starts them through vx_fixtures.ensure_started, whose one client.use() call passes
    its ``ttl`` argument (default 0); start_fixtures.py never passes another.
    """
    fixtures = ast.parse((ACC / 'vx_fixtures.py').read_text(encoding='utf-8'))
    ensure = [n for n in ast.walk(fixtures) if isinstance(n, ast.AsyncFunctionDef) and n.name == 'ensure_started']
    assert len(ensure) == 1, 'vx_fixtures.py no longer defines ensure_started()'
    args = ensure[0].args
    defaults = dict(zip([a.arg for a in args.args][-len(args.defaults) :], args.defaults))
    assert isinstance(defaults.get('ttl'), ast.Constant) and defaults['ttl'].value == 0
    use_calls = _calls(fixtures, 'use')
    assert use_calls and all(c in list(ast.walk(ensure[0])) for c in use_calls), 'client.use() outside ensure_started'
    for call in use_calls:
        ttl = [kw.value for kw in call.keywords if kw.arg == 'ttl']
        assert ttl and isinstance(ttl[0], ast.Name) and ttl[0].id == 'ttl'
    starter = ast.parse((ACC / 'start_fixtures.py').read_text(encoding='utf-8'))
    starts = _calls(starter, 'ensure_started')
    assert starts, 'start_fixtures.py no longer starts its sources through ensure_started()'
    for call in starts:
        assert all(
            kw.arg != 'ttl' or (isinstance(kw.value, ast.Constant) and kw.value.value == 0) for kw in call.keywords
        )
        assert len(call.args) <= 3, 'ttl passed positionally'


def test_templates_pin_the_parser_size_cap():
    """Every template's parse_1 carries index.maxFileSize (the cap the next test expects to be enforced)."""
    module = _load_fixtures()
    for key in FIXTURES:
        pipeline = module.build_pipeline(key, 'stub')
        parse = [c for c in pipeline['components'] if c['id'] == 'parse_1'][0]
        assert parse['config']['index']['maxFileSize'] == TEMPLATE_MAX_FILE_SIZE


# The parser's warning for a file over the cap (parse-instance.cpp, Ec::Excluded).
OVERSIZE_WARNING = 'exceeds processing configured limit'


async def _upload_oversize(ingest_token: str, key: str) -> Dict[str, Any]:
    """Upload a file just over the cap; return the upload rows and the status warnings that name it."""
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    # A name unique to this upload, so an earlier run's warning cannot match.
    path = OUT_DIR / f'g0_1_oversize_{key}_{time.time_ns()}.bin'
    # Zero bytes: even when no cap applies there is no text to chunk or embed.
    with open(path, 'wb') as f:
        f.write(b'\0' * (TEMPLATE_MAX_FILE_SIZE + 1024 * 1024))
    try:
        async with client() as c:
            started = time.time()
            result = await c.send_files([(str(path), {'name': path.name}, 'application/octet-stream')], ingest_token)
            seconds = round(time.time() - started, 2)
            warnings: list = []
            for _ in range(20):  # the status can trail the upload answer by a moment
                status = await c.get_task_status(ingest_token)
                warnings = [w for w in status.get('warnings') or [] if isinstance(w, str) and path.name in w]
                if warnings:
                    break
                await asyncio.sleep(0.5)
            return {'result': result, 'seconds': seconds, 'warnings': warnings}
    finally:
        path.unlink(missing_ok=True)


def test_the_parser_does_not_apply_the_template_size_cap(vx_fixtures):
    """An upload over the template's maxFileSize is parsed, not excluded: the app's limit is the only one.

    The parser reads ``index.maxFileSize`` from a task configuration section the
    engine does not build from a ``.pipe``, so ``parse_1.config.index`` in the
    templates is not applied. Vector Explorer therefore excludes a file over its
    limit before sending it (``apps/vector-ui/src/vector/uploads.ts``), and the
    docs say such a file is excluded, not ingested. When this pin fails the engine
    has started applying the cap: update contract rule 5, the app README, the user
    guide and this pin together.
    """
    for key in FIXTURES:
        ingest = vx_fixtures['tasks'][key]['ingest_1']['token']
        observed = run(_upload_oversize(ingest, key))
        record(f'g0_1_oversize_{key}', observed)
        rows = observed['result']
        assert rows and rows[0].get('action') == 'complete', f'{key}: oversize upload answered {rows}'
        assert not any(OVERSIZE_WARNING in w for w in observed['warnings']), (
            f'{key}: the parser now excludes a file over the template cap ({observed["warnings"]}); '
            'the docs and the app still say that the app limit is the only one'
        )


async def _raw_template_chat() -> Dict[str, Any]:
    module = _load_fixtures()
    pipeline = module.build_pipeline('postgres', 'template')
    pipeline['project_id'] = RAW_PROJECT_ID
    pipeline['name'] = 'vx-local Phase-0 raw template (pgvector)'
    for component in pipeline['components']:
        if component['id'] in ('store_1', 'store_2'):
            profile = component['config']['profile']
            component['config'][profile]['collection'] = RAW_COLLECTION
    llm = [c for c in pipeline['components'] if c['id'] == 'llm_1'][0]['config']['custom']
    assert llm['apikey'] == 'replace-with-your-key' and llm['base_url'] == ''

    from rocketride.schema import Question

    async with client() as c:
        started = time.time()
        task = await c.use(pipeline=pipeline, source='chat_1', ttl=0)
        start_seconds = round(time.time() - started, 1)
        try:
            question = Question()
            question.addQuestion('Phase-0 check: which documents are stored?')
            started = time.time()
            answer = await c.chat(token=task['token'], question=question)
            return {
                'start_seconds': start_seconds,
                'chat_seconds': round(time.time() - started, 1),
                'keys': sorted(answer),
                'answers': answer.get('answers'),
                'documents': answer.get('documents'),
                'result_types': answer.get('result_types'),
            }
        finally:
            await c.terminate(task['token'])


def test_raw_template_chat_answers_with_the_llm_error(engine):
    """With the placeholder key, chat_1 starts and a chat answers with the LLM error text (not a failed call)."""
    observed = run(_raw_template_chat())
    record('g0_1b_raw_template_chat', observed)
    assert observed['keys'] == ['answers', 'documents', 'name', 'objectId', 'path', 'result_types']
    assert observed['result_types'] == {'answers': 'answers', 'documents': 'documents'}
    assert len(observed['answers']) == 1
    assert observed['answers'][0].startswith('**LLM error**'), observed['answers']
    assert observed['documents'] == []
