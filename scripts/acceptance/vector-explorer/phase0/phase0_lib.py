# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""Shared settings and helpers for the Vector Explorer Phase-0 pins.

The pins run against a live engine and fail loudly when what they pin does not
hold, including when the engine or a container is not there. See README.md.

Every default is a throwaway LOCAL-ONLY value for disposable containers.
"""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from typing import Any, Dict

from rocketride import RocketRideClient

HERE = Path(__file__).resolve().parent
ACC = HERE.parent
REPO = HERE.parents[3]

# The engine under test. An OSS engine started without ROCKETRIDE_APIKEY accepts any
# non-empty key, so RR_TEST_APIKEY is a local label, not a credential.
ENGINE_URL = os.environ.get('ENGINE_URL', 'http://127.0.0.1:5590')
API_KEY = os.environ.get('RR_TEST_APIKEY', 'local-acceptance-key')

# Results (latencies, observed behaviour) land here; out/ is git-ignored.
OUT_DIR = Path(os.environ.get('OUT_DIR', str(ACC / 'out'))) / 'phase0'

# The template fixtures G0-1/G0-2 start through start_fixtures.py, and the table or
# collection they use (kept apart from the demo collection other runs ingest into).
FIXTURES = [k.strip() for k in os.environ.get('VX_PHASE0_FIXTURES', 'postgres').split(',') if k.strip()]
FIXTURE_COLLECTION = os.environ.get('VX_PHASE0_COLLECTION', 'vx_phase0_docs')
FIXTURE_RR_TABLE = os.environ.get('VX_PHASE0_RR_TABLE', 'vx_phase0_rr')

# The probe nodes (nodes/test/vx_context_probe) load only with --node_path.
PROBE_NODE_PATH = REPO / 'nodes' / 'test' / 'vx_context_probe'
PROBE_PROJECT_ID = '00000000-0000-4000-8000-0000000c0e10'
PROBE_SOURCES = {'tools_1': 'tools', 'chat_1': 'chat', 'ingest_1': 'dropper'}

# Fixed local-only project ids of start_fixtures.py, by fixture key.
FIXTURE_PROJECT_IDS = {
    'postgres': '00000000-0000-4000-8000-00000000d1a1',
    'rocketride_vector': '00000000-0000-4000-8000-00000000d1a2',
    'qdrant': '00000000-0000-4000-8000-00000000d1a3',
    'chroma': '00000000-0000-4000-8000-00000000d1a4',
}
TEMPLATE_SOURCES = ('tools_1', 'chat_1', 'ingest_1')


def run(coro: Any) -> Any:
    """Run one coroutine to completion (the pins are plain synchronous tests)."""
    return asyncio.run(coro)


def client(*, auth: str = None, timeout_ms: int = 600_000) -> RocketRideClient:
    """Return a client for the engine under test (use with ``async with``)."""
    return RocketRideClient(uri=ENGINE_URL, auth=auth or API_KEY, request_timeout=timeout_ms)


def record(name: str, data: Any) -> Path:
    """Write an observation to out/phase0/<name>.json and return its path."""
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    path = OUT_DIR / f'{name}.json'
    path.write_text(json.dumps(data, indent=2, sort_keys=True, default=str) + '\n', encoding='utf-8')
    return path


def source(component_id: str, provider: str, name: str) -> Dict[str, Any]:
    """A source component as the pipeline editor writes it."""
    return {
        'id': component_id,
        'provider': provider,
        'name': name,
        'config': {'hideForm': True, 'mode': 'Source', 'parameters': {}, 'type': provider, 'name': name},
    }


def probe_pipeline() -> Dict[str, Any]:
    """The call context probe pipeline.

    ``tools_1`` controls ``caller_1`` and ``receiver_1``; ``caller_1`` controls
    ``receiver_1`` (the agent-style path); ``chat_1`` and ``ingest_1`` reach
    ``receiver_1`` through its questions and tags lanes.
    """
    return {
        'name': 'vx-local Phase-0 call context probe',
        'project_id': PROBE_PROJECT_ID,
        'components': [
            source('tools_1', 'tools', 'Tools'),
            source('chat_1', 'chat', 'Chat'),
            source('ingest_1', 'dropper', 'Ingest'),
            {
                'id': 'caller_1',
                'provider': 'vx_probe_caller',
                'name': 'Caller probe',
                'config': {'profile': 'default', 'default': {}},
                'control': [{'classType': 'tool', 'from': 'tools_1'}],
            },
            {
                'id': 'receiver_1',
                'provider': 'vx_probe_receiver',
                'name': 'Receiver probe',
                'config': {'profile': 'default', 'default': {}},
                'control': [{'classType': 'tool', 'from': 'tools_1'}, {'classType': 'tool', 'from': 'caller_1'}],
                'input': [{'lane': 'questions', 'from': 'chat_1'}, {'lane': 'tags', 'from': 'ingest_1'}],
            },
        ],
    }
