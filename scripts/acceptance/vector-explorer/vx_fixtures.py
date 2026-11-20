# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""Shared settings and pipeline builders for the Vector Explorer acceptance scripts.

Everything here targets disposable local containers. Every default is a
throwaway LOCAL-ONLY test value for those containers, not a secret.

The fixture pipelines (``start_fixtures.py``):

* one per supported template (``apps/vector-ui/templates``): pgvector, RocketRide
  Vector (through the fake broker), Qdrant and Chroma, with the three sources
  ``tools_1``, ``chat_1`` and ``ingest_1``;
* ``stock_rag``: the shape of the repository's RAG example (a webhook ingest, a
  chat with its own embedding and store node, no Tools source), the read-only
  case of the explorer;
* ``qdrant_pager``: a Qdrant template pointed at a collection of 1,500 one-chunk
  documents, for the directory's background paging.

The builders never create, drop or rewrite a table or collection; the stores
create their own on the first ingest.
"""

from __future__ import annotations

import copy
import json
import os
import uuid

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]

# Engine under test. An OSS engine started without ROCKETRIDE_APIKEY accepts any
# non-empty key, so RR_TEST_APIKEY is a local label, not a credential.
ENGINE_URL = os.environ.get('ENGINE_URL', 'http://127.0.0.1:5590')
API_KEY = os.environ.get('RR_TEST_APIKEY', 'local-acceptance-key')
TEMPLATES = Path(os.environ.get('VX_TEMPLATES_DIR', str(REPO / 'apps' / 'vector-ui' / 'templates')))
CHUNKING = REPO / 'apps' / 'vector-ui' / 'tests' / 'fixtures' / 'chunking.json'
STUB_LLM_URL = os.environ.get('VX_STUB_LLM_URL', 'http://127.0.0.1:18901/v1')
STUB_LLM_NODE_NAME = 'Local stub LLM'
COLLECTION = os.environ.get('VX_COLLECTION', 'vx_demo_docs')
RR_TABLE = os.environ.get('VX_RR_TABLE', 'vx_demo_rr')
STOCK_RAG_TABLE = os.environ.get('VX_STOCK_RAG_TABLE', 'vx_stock_rag')
PAGER_COLLECTION = os.environ.get('VX_PAGER_COLLECTION', 'vx_pager_docs')
PAGER_DOCUMENTS = 1500

PG = {
    'host': os.environ.get('VX_PG_HOST', '127.0.0.1'),
    'port': int(os.environ.get('VX_PG_PORT', '55432')),
    'user': os.environ.get('VX_PG_USER', 'rruser'),
    'password': os.environ.get('VX_PG_PASSWORD', 'rrpass'),
    'database': os.environ.get('VX_PG_DATABASE', 'rrtenant'),
}
PG_POOLER_PORT = int(os.environ.get('VX_PG_POOLER_PORT', '56434'))
QDRANT = {'host': os.environ.get('VX_QDRANT_HOST', '127.0.0.1'), 'port': int(os.environ.get('VX_QDRANT_PORT', '56333'))}
CHROMA = {'host': os.environ.get('VX_CHROMA_HOST', '127.0.0.1'), 'port': os.environ.get('VX_CHROMA_PORT', '58000')}

TEMPLATE_SOURCES = ('tools_1', 'chat_1', 'ingest_1')
STOCK_RAG_SOURCES = ('chat_1', 'webhook_1')

# The embedding model of every template (profile miniAll of embedding_transformer).
EMBEDDING_MODEL = 'sentence-transformers/all-MiniLM-L6-v2'
EMBEDDING_DIMENSION = 384


@dataclass(frozen=True)
class Fixture:
    """One fixture pipeline: display name, fixed local-only project id, how to build it."""

    key: str
    name: str
    project_id: str
    template: Optional[str]  # template stem; None for a shape built here
    connection: Dict[str, Any] = field(default_factory=dict)
    sources: Tuple[str, ...] = TEMPLATE_SOURCES


# The browser lanes find the fixtures by these display names (env.cjs FIXTURES; keep in sync).
FIXTURES: Dict[str, Fixture] = {
    f.key: f
    for f in (
        Fixture(
            'postgres',
            'vx-local Vector (pgvector)',
            '00000000-0000-4000-8000-00000000d1a1',
            'postgres',
            {**PG, 'collection': COLLECTION},
        ),
        Fixture(
            'rocketride_vector',
            'vx-local Vector (RocketRide Vector)',
            '00000000-0000-4000-8000-00000000d1a2',
            'rocketride_vector',
            {'collection': RR_TABLE},
        ),
        Fixture(
            'qdrant',
            'vx-local Vector (Qdrant)',
            '00000000-0000-4000-8000-00000000d1a3',
            'qdrant',
            {**QDRANT, 'collection': COLLECTION},
        ),
        Fixture(
            'chroma',
            'vx-local Vector (Chroma)',
            '00000000-0000-4000-8000-00000000d1a4',
            'chroma',
            {**CHROMA, 'collection': COLLECTION},
        ),
        Fixture(
            'stock_rag',
            'vx-local Stock RAG (pgvector)',
            '00000000-0000-4000-8000-00000000d1a5',
            None,
            {**PG, 'collection': STOCK_RAG_TABLE},
            STOCK_RAG_SOURCES,
        ),
        Fixture(
            'qdrant_pager',
            'vx-local 1,500 documents (Qdrant)',
            '00000000-0000-4000-8000-00000000d1a6',
            'qdrant',
            {**QDRANT, 'collection': PAGER_COLLECTION},
        ),
    )
}
# The fixtures start_fixtures.py starts when --only is not given.
DEFAULT_FIXTURES = ('postgres', 'rocketride_vector', 'qdrant', 'chroma', 'stock_rag')


def object_id(name: str) -> str:
    """The objectId the engine derives for an upload named ``name`` (the app's collision check uses the same)."""
    return str(uuid.uuid5(uuid.NAMESPACE_URL, 'null://Stream/' + name))


def load_template(stem: str) -> Dict[str, Any]:
    """One shipped template, as a fresh dict."""
    template = json.loads((TEMPLATES / f'{stem}.pipe').read_text(encoding='utf-8'))
    return copy.deepcopy(template.get('pipeline', template))


def calibrated_chunker() -> Dict[str, Any]:
    """The templates' chunk_1 configuration (apps/vector-ui/tests/fixtures/chunking.json)."""
    return copy.deepcopy(json.loads(CHUNKING.read_text(encoding='utf-8'))['chunk_1']['config'])


def stub_llm(component: Dict[str, Any]) -> None:
    """Point an llm_openai_api component at the local test stub (not a model, not a key)."""
    component['name'] = STUB_LLM_NODE_NAME
    profile = component['config'].get('profile', 'custom')
    component['config'].setdefault(profile, {}).update({'base_url': STUB_LLM_URL, 'apikey': 'local-stub-not-a-key'})


def _source(cid: str, provider: str, name: str) -> Dict[str, Any]:
    return {
        'id': cid,
        'provider': provider,
        'name': name,
        'config': {'hideForm': True, 'mode': 'Source', 'parameters': {}, 'type': provider, 'name': name},
    }


def stock_rag_pipeline(connection: Dict[str, Any], llm: str = 'stub', allow_writes: bool = True) -> Dict[str, Any]:
    """The shape of examples/rag-pipeline.pipe on pgvector: webhook ingest, chat, no Tools source.

    Both store nodes carry ``allow_writes`` (on by default here) so a write
    through the chat source shows the source check, not the switch.
    """

    def store(cid: str, name: str, lane: str, source: str) -> Dict[str, Any]:
        local = {
            **connection,
            'score': 0.3,
            'similarity': 'cosine',
            'serverName': 'postgres',
            'allow_writes': allow_writes,
        }
        return {
            'id': cid,
            'provider': 'postgres',
            'name': name,
            'config': {'profile': 'local', 'local': local, 'parameters': {}},
            'input': [{'lane': lane, 'from': source}],
        }

    llm_node = {
        'id': 'llm_1',
        'provider': 'llm_openai_api',
        'name': 'LLM',
        'config': {
            'profile': 'custom',
            'custom': {
                'model': 'gpt-4o-mini',
                'base_url': '',
                'apikey': 'replace-with-your-key',
                'modelTotalTokens': 16384,
            },
            'parameters': {},
        },
        'input': [{'lane': 'questions', 'from': 'prompt_1'}],
    }
    if llm == 'stub':
        stub_llm(llm_node)
    return {
        'components': [
            _source('webhook_1', 'webhook', 'Webhook'),
            {
                'id': 'parse_1',
                'provider': 'parse',
                'name': 'Parse',
                'config': {},
                'input': [{'lane': 'tags', 'from': 'webhook_1'}],
            },
            {
                'id': 'chunk_1',
                'provider': 'preprocessor_langchain',
                'name': 'Chunker',
                'config': calibrated_chunker(),
                'input': [{'lane': 'text', 'from': 'parse_1'}],
            },
            {
                'id': 'embed_1',
                'provider': 'embedding_transformer',
                'name': 'Embedding',
                'config': {'profile': 'miniAll', 'parameters': {}},
                'input': [{'lane': 'documents', 'from': 'chunk_1'}],
            },
            store('store_1', 'PostgreSQL (pgvector)', 'documents', 'embed_1'),
            _source('chat_1', 'chat', 'Chat'),
            {
                'id': 'embed_2',
                'provider': 'embedding_transformer',
                'name': 'Embedding (chat)',
                'config': {'profile': 'miniAll', 'parameters': {}},
                'input': [{'lane': 'questions', 'from': 'chat_1'}],
            },
            store('store_2', 'PostgreSQL (pgvector) (chat)', 'questions', 'embed_2'),
            {
                'id': 'prompt_1',
                'provider': 'prompt',
                'name': 'Prompt',
                'config': {
                    'instructions': [
                        'Use the provided context to answer the question accurately. If the context does not contain relevant information, say so.'
                    ],
                    'parameters': {},
                },
                'input': [{'lane': 'documents', 'from': 'store_2'}, {'lane': 'questions', 'from': 'store_2'}],
            },
            llm_node,
            {
                'id': 'response_1',
                'provider': 'response_answers',
                'name': 'Return Answers',
                'config': {'laneName': 'answers'},
                'input': [{'lane': 'answers', 'from': 'llm_1'}],
            },
        ],
        'version': 1,
    }


def build_pipeline(
    key: str,
    llm: str = 'stub',
    *,
    collection: Optional[str] = None,
    project_id: Optional[str] = None,
    name: Optional[str] = None,
    connection: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """One fixture pipeline with its identity, store connection and LLM filled in.

    ``collection``/``connection``/``project_id``/``name`` override the
    fixture's own (the legacy seed points a template at another collection).
    """
    fixture = FIXTURES[key]
    conn = dict(connection if connection is not None else fixture.connection)
    if collection is not None:
        conn['collection'] = collection
    if fixture.template is None:
        pipe = stock_rag_pipeline(conn, llm)
    else:
        pipe = load_template(fixture.template)
        for comp in pipe['components']:
            if comp['id'] in ('store_1', 'store_2'):
                profile = comp['config']['profile']
                comp['config'][profile].update(conn)
            elif comp['id'] == 'llm_1' and llm == 'stub':
                stub_llm(comp)
    pipe['name'] = name or fixture.name
    pipe['project_id'] = project_id or fixture.project_id
    return pipe


def store_nodes(pipe: Dict[str, Any]) -> List[Dict[str, Any]]:
    """The vector store components of a pipeline (by id order)."""
    stores = (
        'postgres',
        'rocketride_vector',
        'qdrant',
        'chroma',
        'milvus',
        'weaviate',
        'pinecone',
        'astra_db',
        'atlas',
    )
    return sorted((c for c in pipe['components'] if c.get('provider') in stores), key=lambda c: c['id'])


async def running_tasks(client) -> Dict[Tuple[Optional[str], Optional[str]], Dict[str, Any]]:
    """Every running task, keyed by (project id, source)."""
    out = {}
    for task in await client.get_tasks():
        out[((task.get('pipeline') or {}).get('project_id'), task.get('source'))] = task
    return out


async def ensure_started(client, pipe: Dict[str, Any], sources: Sequence[str], ttl: int = 0) -> Dict[str, str]:
    """Start the sources of ``pipe`` that are not running yet; their task tokens by source."""
    running = await running_tasks(client)
    tokens = {}
    for source in sources:
        task = running.get((pipe['project_id'], source))
        if task is None:
            # ttl=0: run until stopped (the engine stops a task idle for its TTL, 15 minutes by default).
            task = await client.use(pipeline=pipe, source=source, ttl=ttl)
        tokens[source] = task['token']
    return tokens


async def stop(client, project_id: str, sources: Iterable[str]) -> List[str]:
    """Terminate the given sources of one project; the sources stopped."""
    running = await running_tasks(client)
    stopped = []
    for source in sources:
        task = running.get((project_id, source))
        if task is not None:
            await client.terminate(task['token'])
            stopped.append(source)
    return stopped


async def send_named(client, token: str, files: Sequence[Tuple[Path, str]]) -> List[Dict[str, Any]]:
    """Upload files one at a time, each under its display path; every upload's result."""
    results = []
    for path, name in files:
        (result,) = await client.send_files([(str(path), {'name': name})], token)
        results.append(result)
    return results


def failed_uploads(results: Sequence[Dict[str, Any]]) -> List[str]:
    """The file paths whose upload did not complete."""
    return [str(r.get('filepath') or r.get('name') or '?') for r in results if (r or {}).get('action') != 'complete']
