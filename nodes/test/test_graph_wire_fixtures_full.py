# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""graph-ui's wire fixtures must stay what the graph nodes really emit.

``apps/graph-ui/tests/fixtures/v1`` holds the CONTRACT v1 envelopes the
graph-ui tests parse: driver goldens (``read_query_*.json``) and live captures
(``live/*.json``). This suite regenerates both with
``nodes/test/graph_wire_fixtures.py`` and compares them with the committed
files, so a change to the envelope, an ``@kind`` tag or a tool's output fails
here until the fixtures are regenerated (see that module for the command).

The driver goldens must match exactly. Live captures are compared after
replacing what legitimately differs between runs: node and relationship ids
(Neo4j element ids embed the database's UUID), the per-run scratch graph name,
``refreshed_at`` timestamps, and, in Neo4j's ``get_schema``, labels and types
other test data left on the shared server.

Runs in the unmocked live-database lane (registered in
``nodes/scripts/db-lanes/graph.js``); skips without the drivers or databases unless
``RR_REQUIRE_DB_TESTS`` is set.
"""

from __future__ import annotations

import json
import os

from pathlib import Path

import pytest

_REQUIRED = bool(os.environ.get('RR_REQUIRE_DB_TESTS'))
if not _REQUIRED:
    pytest.importorskip('neo4j')
    pytest.importorskip('falkordb')
    pytest.importorskip('psycopg2')
    pytest.importorskip('antlr4')

from . import graph_wire_fixtures as gen  # noqa: E402
from . import test_graph_falkordb_full as fk  # noqa: E402
from . import test_graph_neo4j_full as n4  # noqa: E402
from . import test_rocketride_graph_full as rr  # noqa: E402

FIXTURES = Path(__file__).resolve().parents[2] / 'apps' / 'graph-ui' / 'tests' / 'fixtures' / 'v1'

# The labels and relationship types the generator seeds in Neo4j (after
# un-namespacing); anything else in get_schema is other data on the server.
_OWN_NEO4J_NAMES = frozenset({'GxPerson', 'GxEmployee', 'GxCompany', 'GxBlob', 'GX_KNOWS', 'GX_LIKES', 'GX_WORKS_AT'})


def _committed(name: str, live: bool = False):
    with open((FIXTURES / 'live' if live else FIXTURES) / name, encoding='utf-8') as handle:
        return json.load(handle)


def canonical(value):
    """Replace run-specific values: entity ids (first-seen order), refreshed_at."""
    ids: dict = {}

    def walk(item):
        if isinstance(item, list):
            return [walk(x) for x in item]
        if not isinstance(item, dict):
            return item
        out = {key: ('<time>' if key == 'refreshed_at' and x is not None else walk(x)) for key, x in item.items()}
        if item.get('@kind') in ('node', 'relationship'):
            for key in ('id', 'start', 'end'):
                if key in item:
                    out[key] = ids.setdefault(item[key], f'<id {len(ids) + 1}>')
        return out

    return walk(value)


def _own_neo4j_schema(schema):
    """get_schema reduced to this suite's own labels and relationship types."""
    out = dict(schema)
    out['labels'] = [x for x in schema['labels'] if x in _OWN_NEO4J_NAMES]
    out['nodes'] = {k: v for k, v in schema['nodes'].items() if k in _OWN_NEO4J_NAMES}
    out['relationships'] = [r for r in schema['relationships'] if r['type'] in _OWN_NEO4J_NAMES]
    block = dict(schema['schema'])
    block['labels'] = [x for x in block['labels'] if x['name'] in _OWN_NEO4J_NAMES]
    block['relationship_types'] = [r for r in block['relationship_types'] if r['type'] in _OWN_NEO4J_NAMES]
    out['schema'] = block
    return out


def _comparable(name, value):
    value = canonical(value)
    if name.endswith('_dialect.json') and value.get('graph') is not None:
        value = {**value, 'graph': '<scratch graph>'}
    if name == 'neo4j_get_schema.json':
        value = _own_neo4j_schema(value)
    return value


@pytest.mark.parametrize('name', gen.DRIVER_FIXTURES)
def test_driver_goldens_match_the_normalizer(name):
    regenerated = gen.driver_fixtures()
    assert regenerated[name] == _committed(name), (
        f'apps/graph-ui/tests/fixtures/v1/{name} no longer matches the normalizer; regenerate it '
        '(see nodes/test/graph_wire_fixtures.py)'
    )


def test_the_generator_covers_every_committed_driver_golden():
    committed = sorted(p.name for p in FIXTURES.glob('read_query_*.json'))
    assert committed == sorted(gen.DRIVER_FIXTURES)


def _live_or_skip(reachable, what, generate):
    if not reachable:
        pytest.skip(f'{what} test database not reachable')
    return generate()


@pytest.fixture(scope='module')
def live():
    return {
        **_live_or_skip(n4._REACHABLE, 'Neo4j', gen.live_neo4j),
        **_live_or_skip(fk._REACHABLE, 'FalkorDB', gen.live_falkordb),
        **_live_or_skip(rr._db_reachable(), 'AGE', gen.live_age),
    }


def test_the_generator_covers_every_committed_live_capture(live):
    committed = sorted(p.name for p in (FIXTURES / 'live').glob('*.json'))
    assert committed == sorted(live)


@pytest.mark.parametrize('name', sorted(p.name for p in (FIXTURES / 'live').glob('*.json')))
def test_live_captures_match_the_tools(live, name):
    assert _comparable(name, live[name]) == _comparable(name, _committed(name, live=True)), (
        f'apps/graph-ui/tests/fixtures/v1/live/{name} no longer matches the node tools; regenerate it '
        '(see nodes/test/graph_wire_fixtures.py)'
    )


def test_canonical_form_ignores_only_run_specific_values():
    a = {'@kind': 'node', 'id': '4:uuid-a:1', 'labels': ['A'], 'properties': {}}
    b = {'@kind': 'relationship', 'id': '5:uuid-a:9', 'start': '4:uuid-a:1', 'end': '4:uuid-a:1', 'type': 'R'}
    renamed = json.loads(json.dumps([a, b]).replace('uuid-a', 'uuid-b'))
    assert canonical([a, b]) == canonical(renamed)
    changed = json.loads(json.dumps([a, b]))
    changed[0]['labels'] = ['B']
    assert canonical([a, b]) != canonical(changed)
    assert canonical({'refreshed_at': '2026-01-01', 'x': 1}) == canonical({'refreshed_at': '2027-01-01', 'x': 1})
