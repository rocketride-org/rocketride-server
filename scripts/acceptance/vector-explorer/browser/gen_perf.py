# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""Seed the Map performance fixture: one disposable collection with enough chunks for 5,000 light points.

Builds a fixture from the Qdrant template (or ``--backend postgres``) pointed at its
own collection (``vx_perf_docs``) with its own local project id and display name
("vx-local Map performance (Qdrant)"; lane_vector_perf.cjs finds the card by it),
starts its three sources (``ttl=0``) and ingests seeded synthetic documents
through ``ingest_1`` until the store holds at least ``--chunks`` chunks (default
6,000). The documents are written from twelve topic vocabularies, so the map has
real clusters to draw. Local containers only; nothing else is touched.

The lane measures the map's similarity edges on the 2,000-point detailed sample
of this fixture (rows ``edges:none``, ``edges:tree``, ``edges:neighbours:3`` and
``edges:neighbours:5``, ``EDGE_ROWS``). ``--check`` asks the fixture for that
sample through its Tools source and fails unless it can carry every row: 2,000
points, and a kNN graph that gives every point at least as many neighbours as
the densest row draws (5), so a row cannot pass by drawing fewer edges because
the sample had fewer to give.

Uses ``vx_fixtures.py`` from the parent folder (the fixture builder of the
acceptance scripts).

Usage (from dist/server):
  ./engine <repo>/scripts/acceptance/vector-explorer/browser/gen_perf.py [--chunks 6000] [--backend qdrant|postgres] [--if-enough]
  ./engine .../gen_perf.py --stop          # terminate the perf fixture's sources
  ./engine .../gen_perf.py --check         # can the 2,000-point sample carry every edge row?
  python3 .../gen_perf.py --dry-run        # print what would be generated (no engine)
"""

from __future__ import annotations

import argparse
import asyncio
import json
import random
import sys
import tempfile

from pathlib import Path
from typing import Any, List, Optional, Sequence, Tuple

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

PERF_COLLECTION = 'vx_perf_docs'
PERF_PROJECT_ID = '00000000-0000-4000-8000-00000000d1a7'
PERF_NAMES = {'qdrant': 'vx-local Map performance (Qdrant)', 'postgres': 'vx-local Map performance (pgvector)'}
DOCUMENT_CHARS = 60_000

#: The sample the lane measures edges on, and the edge rows it measures there (lane_vector_perf.cjs EDGE_MODES).
EDGE_SAMPLE_N = 2000
EDGE_ROWS = ('none', 'tree', 'neighbours:3', 'neighbours:5')
BATCH = 10
MAX_ROUNDS = 8

TOPICS = {
    'water': 'spring tank filter pump pressure valve pipe flow chlorine reservoir intake gauge',
    'birds': 'kestrel falcon nest perch wingspan clutch fledgling raptor feather hover dive',
    'greenhouse': 'orchid humidity soil seedling mist bench shade cutting bloom fertiliser trellis',
    'finance': 'invoice ledger budget audit accrual payment quarter forecast variance account',
    'legal': 'clause contract party liability indemnity term breach notice warranty governing',
    'power': 'generator fuel battery inverter load panel circuit breaker voltage hours',
    'radio': 'antenna frequency handset relay channel signal static callsign check-in band',
    'kitchen': 'pantry ration stove flour lentil storage menu supper bread cooler',
    'weather': 'barometer gust front drizzle cloud dewpoint squall forecast frost visibility',
    'medical': 'bandage dressing triage splint dosage clinic allergy fever saline kit',
    'transport': 'truck route convoy trailer fuel stop tyre loading manifest schedule',
    'research': 'sample assay protocol control trial hypothesis variance replicate dataset survey',
}
SHARED = 'the station team week report note check record morning evening crew site shift'.split()


def document_text(index: int, chars: int = DOCUMENT_CHARS) -> Tuple[str, str]:
    """(topic, text) of synthetic document ``index``: paragraphs from its topic's vocabulary, the same every run."""
    rng = random.Random(f'vx-perf:{index}')
    topics = sorted(TOPICS)
    topic = topics[index % len(topics)]
    neighbour = topics[(index + 1) % len(topics)]
    words = TOPICS[topic].split()
    side = TOPICS[neighbour].split()
    paragraphs: List[str] = []
    size = 0
    while size < chars:
        sentences = []
        for _ in range(rng.randint(4, 7)):
            pool = words * 4 + side + SHARED * 2
            sentence = ' '.join(rng.choice(pool) for _ in range(rng.randint(9, 16)))
            sentences.append(sentence[0].upper() + sentence[1:] + '.')
        paragraph = ' '.join(sentences)
        paragraphs.append(paragraph)
        size += len(paragraph) + 2
    title = f'# {topic.title()} log {index:03d}'
    return topic, title + '\n\n' + '\n\n'.join(paragraphs) + '\n'


def upload_name(index: int, topic: str) -> str:
    """The path a document is stored under (the directory shows it)."""
    return f'C:/perf/{topic}/{topic}_log_{index:03d}.md'


async def stored_chunks(client, token: str) -> int:
    """Chunks the store holds (stats, through the Tools source)."""
    answer = await client.tool(token=token, tool='stats', node_id='store_1', input={'mode': 'full'}, timeout=120000)
    if not isinstance(answer, dict):
        return 0
    chunks = answer.get('chunks')
    return int(chunks if isinstance(chunks, (int, float)) else answer.get('count') or 0)


async def seed(backend: str, target: int, if_enough: bool) -> int:
    """Ingest documents until the perf collection holds ``target`` chunks."""
    import vx_fixtures as fx
    from rocketride import RocketRideClient

    pipe = fx.build_pipeline(backend, collection=PERF_COLLECTION, project_id=PERF_PROJECT_ID, name=PERF_NAMES[backend])
    async with RocketRideClient(uri=fx.ENGINE_URL, auth=fx.API_KEY, request_timeout=900000) as client:
        tokens = await fx.ensure_started(client, pipe, fx.TEMPLATE_SOURCES)
        have = await stored_chunks(client, tokens['tools_1'])
        if if_enough and have >= target:
            print(
                json.dumps({'fixture': PERF_NAMES[backend], 'collection': PERF_COLLECTION, 'chunks': have, 'seeded': 0})
            )
            return 0
        index = 0
        failures = 0
        with tempfile.TemporaryDirectory(prefix='vx-perf-') as tmp:
            root = Path(tmp)
            for _ in range(MAX_ROUNDS):
                if have >= target:
                    break
                # Each round adds about what is missing, assuming ~800 characters a chunk.
                needed = max(BATCH, int((target - have) * 800 / DOCUMENT_CHARS) + 1)
                files: List[Tuple[Path, str]] = []
                for _ in range(needed):
                    topic, text = document_text(index)
                    path = root / f'{index:04d}.md'
                    path.write_text(text, encoding='utf-8')
                    files.append((path, upload_name(index, topic)))
                    index += 1
                for start in range(0, len(files), BATCH):
                    batch = files[start : start + BATCH]
                    results = await client.send_files(
                        [(str(p), {'name': name}) for p, name in batch], tokens['ingest_1']
                    )
                    failures += len(fx.failed_uploads(results))
                have = await stored_chunks(client, tokens['tools_1'])
                print(f'{PERF_NAMES[backend]}: {have} chunks after {index} documents', flush=True)
        print(
            json.dumps(
                {
                    'fixture': PERF_NAMES[backend],
                    'collection': PERF_COLLECTION,
                    'chunks': have,
                    'documents': index,
                    'failed_uploads': failures,
                }
            )
        )
        return 0 if have >= target and failures == 0 else 1


def edges_needed(rows: Sequence[str] = EDGE_ROWS) -> int:
    """The most kNN neighbours per point an edge row draws (``neighbours:m`` draws m; the tree needs 1)."""
    return max([int(row.split(':')[1]) for row in rows if row.startswith('neighbours:')] + [1])


def edge_sample_problems(answer: Any, n: int = EDGE_SAMPLE_N, rows: Sequence[str] = EDGE_ROWS) -> List[str]:
    """Why a ``sample`` answer cannot carry the lane's edge rows (empty when it can).

    It must be a success of exactly ``n`` points whose kNN graph (``knn.offsets_row``, ``knn.cols``)
    gives every point at least ``edges_needed(rows)`` neighbours.
    """
    if not isinstance(answer, dict) or answer.get('success') is False:
        return [f'the sample was refused: {answer!r:.200}']
    out: List[str] = []
    if answer.get('n') != n:
        out.append(f'the sample has {answer.get("n")} points, the edge rows need {n} (seed more chunks)')
    knn = answer.get('knn') if isinstance(answer.get('knn'), dict) else None
    offsets = knn.get('offsets_row') if knn else None
    cols = knn.get('cols') if knn else None
    if not isinstance(offsets, list) or not isinstance(cols, list) or len(offsets) != (answer.get('n') or 0) + 1:
        return out + ['the sample carries no kNN graph (knn.offsets_row and knn.cols)']
    degrees = [b - a for a, b in zip(offsets, offsets[1:])]
    need = edges_needed(rows)
    short = sum(1 for d in degrees if d < need)
    if short:
        out.append(
            f'{short} points have fewer than {need} kNN neighbours (least {min(degrees)}); neighbours:{need} would draw fewer edges'
        )
    if offsets[-1] != len(cols):
        out.append(f'knn.offsets_row ends at {offsets[-1]} but knn.cols holds {len(cols)} edges')
    return out


async def check(backend: str) -> int:
    """Ask the fixture for the edge rows' sample and say whether it can carry every edge row."""
    import vx_fixtures as fx
    from rocketride import RocketRideClient

    pipe = fx.build_pipeline(backend, collection=PERF_COLLECTION, project_id=PERF_PROJECT_ID, name=PERF_NAMES[backend])
    async with RocketRideClient(uri=fx.ENGINE_URL, auth=fx.API_KEY, request_timeout=300000) as client:
        tokens = await fx.ensure_started(client, pipe, ('tools_1',))
        answer = await client.tool(
            token=tokens['tools_1'],
            tool='sample',
            node_id='store_1',
            input={'n': EDGE_SAMPLE_N, 'mode': 'detailed'},
            timeout=300000,
        )
    problems = edge_sample_problems(answer)
    knn = answer.get('knn') if isinstance(answer, dict) and isinstance(answer.get('knn'), dict) else {}
    print(
        json.dumps(
            {
                'fixture': PERF_NAMES[backend],
                'n': answer.get('n') if isinstance(answer, dict) else None,
                'knn_k': knn.get('k'),
                'knn_source': answer.get('knn_source') if isinstance(answer, dict) else None,
                'edge_rows': list(EDGE_ROWS),
                'problems': problems,
            }
        )
    )
    return 1 if problems else 0


async def stop(backend: str) -> int:
    """Terminate the perf fixture's sources."""
    import vx_fixtures as fx
    from rocketride import RocketRideClient

    async with RocketRideClient(uri=fx.ENGINE_URL, auth=fx.API_KEY) as client:
        stopped = await fx.stop(client, PERF_PROJECT_ID, fx.TEMPLATE_SOURCES)
    print(f'{PERF_NAMES[backend]}: stopped {", ".join(stopped) or "nothing"}')
    return 0


def main(argv: Optional[List[str]] = None) -> int:
    """Parse arguments and run."""
    parser = argparse.ArgumentParser(
        description='Seed the Vector Explorer map performance fixture (local containers only).'
    )
    parser.add_argument('--chunks', type=int, default=6000, help='chunks the collection must hold (default 6,000)')
    parser.add_argument('--backend', choices=sorted(PERF_NAMES), default='qdrant')
    parser.add_argument(
        '--if-enough', action='store_true', help='do nothing when the collection already holds enough chunks'
    )
    parser.add_argument('--stop', action='store_true', help="terminate the fixture's sources and exit")
    parser.add_argument(
        '--check',
        action='store_true',
        help='check that the 2,000-point detailed sample can carry every edge row the lane measures',
    )
    parser.add_argument(
        '--dry-run', action='store_true', help='print the first documents that would be generated (no engine)'
    )
    args = parser.parse_args(argv)
    if args.dry_run:
        for i in range(3):
            topic, text = document_text(i)
            print(json.dumps({'name': upload_name(i, topic), 'chars': len(text), 'start': text[:80]}))
        return 0
    if args.stop:
        return asyncio.run(stop(args.backend))
    if args.check:
        return asyncio.run(check(args.backend))
    return asyncio.run(seed(args.backend, args.chunks, args.if_enough))


if __name__ == '__main__':
    sys.exit(main())
