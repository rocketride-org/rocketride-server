# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""Ingest the fictional demo corpus into the Vector Explorer fixtures (local containers only).

* The four template fixtures (pgvector, RocketRide Vector, Qdrant, Chroma) get
  the whole corpus (``gen_corpus.py``) through their ``ingest_1`` source, each
  file named ``C:/demo/<folder>/<file>`` (the path the directory shows).
* ``stock_rag`` gets the ``greenhouse`` and ``observatory`` folders through its
  webhook source.
* With ``--pager``, ``qdrant_pager`` gets 1,500 one-sentence documents named
  ``C:/pager/<folder>/note-<n>.txt``, for the directory's background paging.

The fixtures' sources are started when they are not running (``ttl=0``, as
start_fixtures.py does). Uploading a name again replaces that document, so a
second run is harmless; ``--if-empty`` skips a fixture whose store already
holds documents (asked through its Tools source, ``stats``; a store holding
only its control record counts as empty).

Usage (from dist/server): ./engine <this folder>/seed_demo.py [--only postgres,qdrant] [--pager] [--if-empty]
"""

from __future__ import annotations

import argparse
import asyncio
import importlib.util
import random
import sys
import tempfile

from pathlib import Path
from typing import Any, Iterable, Iterator, List, Optional, Sequence, Tuple

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import vx_fixtures as fx  # noqa: E402

DEMO_PREFIX = 'C:/demo/'
PAGER_PREFIX = 'C:/pager/'
TEMPLATE_FIXTURES = ('postgres', 'rocketride_vector', 'qdrant', 'chroma')
STOCK_RAG_FOLDERS = ('greenhouse', 'observatory')
BATCH = 25

PAGER_TOPICS = (
    'Water log',
    'Battery check',
    'Radio check-in',
    'Greenhouse note',
    'Bird count',
    'Kitchen stock',
    'Weather reading',
    'Visitor entry',
    'Generator hours',
    'Fuel delivery',
    'Shift handover',
    'Maintenance ticket',
)


def _corpus():
    spec = importlib.util.spec_from_file_location('vx_gen_corpus', HERE / 'gen_corpus.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def corpus_files(root: Path, folders: Optional[Sequence[str]] = None) -> List[Tuple[Path, str]]:
    """Write the corpus under root; (file, upload name) for every document (optionally some folders)."""
    out = []
    for path in _corpus().write_corpus(root):
        rel = path.relative_to(root).as_posix()
        if folders is None or rel.split('/')[0] in folders:
            out.append((path, DEMO_PREFIX + rel))
    return out


def pager_documents(count: int = fx.PAGER_DOCUMENTS) -> List[Tuple[str, str]]:
    """(upload name, text) of the paging fixture's one-sentence documents, the same every run."""
    rng = random.Random(f'vx-pager:{count}')
    docs = []
    for n in range(1, count + 1):
        topic = PAGER_TOPICS[n % len(PAGER_TOPICS)]
        folder = f'{topic.lower().replace(" ", "_")}/{2020 + n % 6}'
        text = f'{topic} {n}: recorded at {rng.randint(0, 23):02d}:{rng.randint(0, 59):02d}, value {rng.randint(1, 999)}, all normal.\n'
        docs.append((f'{PAGER_PREFIX}{folder}/note-{n:04d}.txt', text))
    return docs


def batches(items: Sequence, size: int) -> Iterator[Sequence]:
    """Consecutive slices of at most ``size`` items."""
    for start in range(0, len(items), size):
        yield items[start : start + size]


def stored_documents(answer: Any) -> Optional[int]:
    """Documents in a store from its ``stats`` answer; None when it did not answer.

    The explorer's ``stats`` counts ``documents`` without the control record.
    The legacy answer has only ``count``, every row including the control
    record, so a collection holding just that record (e.g. after a failed
    first upload) counts 1: that is no document.
    """
    if not isinstance(answer, dict) or answer.get('success') is False:
        return None
    if isinstance(answer.get('documents'), int):
        return answer['documents']
    return max(0, int(answer.get('count') or 0) - 1)


def is_empty(answer: Any) -> bool:
    """True when --if-empty should seed the store: it holds no document, or could not say."""
    return not (stored_documents(answer) or 0) > 0


async def _stats(client, key: str) -> Any:
    """The store's ``stats`` answer through the fixture's Tools source (None when not answerable)."""
    fixture = fx.FIXTURES[key]
    if 'tools_1' not in fixture.sources:
        return None
    tokens = await fx.ensure_started(client, fx.build_pipeline(key), ('tools_1',))
    try:
        return await client.tool(token=tokens['tools_1'], tool='stats', node_id='store_1', input={}, timeout=60000)
    except Exception:  # noqa: BLE001 - a fixture that cannot answer is seeded
        return None


async def upload(client, key: str, source: str, files: Iterable[Tuple[Path, str]]) -> int:
    """Upload through one fixture source in batches; the number of uploads that did not complete."""
    tokens = await fx.ensure_started(client, fx.build_pipeline(key), (source,))
    failed = 0
    for batch in batches(list(files), BATCH):
        results = await client.send_files([(str(path), {'name': name}) for path, name in batch], tokens[source])
        failed += len(fx.failed_uploads(results))
    return failed


async def main() -> int:
    """Seed the selected fixtures."""
    from rocketride import RocketRideClient

    parser = argparse.ArgumentParser(
        description='Ingest the demo corpus into the Vector Explorer fixtures (local containers only).'
    )
    parser.add_argument('--only', default=','.join(TEMPLATE_FIXTURES + ('stock_rag',)))
    parser.add_argument('--pager', action='store_true', help='also fill qdrant_pager with 1,500 documents')
    parser.add_argument(
        '--if-empty',
        action='store_true',
        help='skip a fixture whose store already has documents (the control record alone is none)',
    )
    args = parser.parse_args()
    keys = [k.strip() for k in args.only.split(',') if k.strip()]
    if args.pager and 'qdrant_pager' not in keys:
        keys.append('qdrant_pager')
    unknown = [k for k in keys if k not in fx.FIXTURES]
    if unknown:
        parser.error(f'unknown fixture(s): {", ".join(unknown)}')

    failures = 0
    with tempfile.TemporaryDirectory(prefix='vx-demo-') as tmp:
        root = Path(tmp)
        async with RocketRideClient(uri=fx.ENGINE_URL, auth=fx.API_KEY, request_timeout=900000) as client:
            for key in keys:
                name = fx.FIXTURES[key].name
                if args.if_empty and not is_empty(await _stats(client, key)):
                    print(f'{name}: already has documents, skipped')
                    continue
                if key == 'stock_rag':
                    files = corpus_files(root / key, STOCK_RAG_FOLDERS)
                    failed = await upload(client, key, 'webhook_1', files)
                elif key == 'qdrant_pager':
                    folder = root / key
                    files = []
                    for i, (upload_name, text) in enumerate(pager_documents()):
                        path = folder / f'{i:04d}.txt'
                        path.parent.mkdir(parents=True, exist_ok=True)
                        path.write_text(text, encoding='utf-8')
                        files.append((path, upload_name))
                    failed = await upload(client, key, 'ingest_1', files)
                else:
                    files = corpus_files(root / key)
                    failed = await upload(client, key, 'ingest_1', files)
                failures += failed
                print(f'{name}: {len(files) - failed} of {len(files)} documents ingested')
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(asyncio.run(main()))
