# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""Start the Vector Explorer fixture pipelines (local disposable containers only).

The fixtures (``vx_fixtures.FIXTURES``):

* ``postgres``, ``rocketride_vector``, ``qdrant``, ``chroma``: one shipped
  template each (``apps/vector-ui/templates``) pointed at a local container:
  ``postgres.pipe`` at gx-pgvector, ``rocketride_vector.pipe`` through the
  fake DB broker, ``qdrant.pipe`` at vx-qdrant, ``chroma.pipe`` at vx-chroma.
  Their three sources (``tools_1``, ``chat_1``, ``ingest_1``) are started.
* ``stock_rag``: the shape of the repository's RAG example on pgvector (a
  webhook ingest and a chat with its own store node, no Tools source), the
  read-only case; its ``chat_1`` and ``webhook_1`` are started.
* ``qdrant_pager`` (only when named): ``qdrant.pipe`` on the collection of
  1,500 one-chunk documents that ``demo/seed_demo.sh --pager`` fills.

Each gets a fixed local-only project id and display name, and every source
is started with ``ttl=0`` so the engine does not stop it after its idle
timeout. Only what is not running yet is started; ``--stop`` terminates the
fixtures' tasks. It never creates, drops or rewrites a table or collection:
the stores create their collection on the first ingest (``demo/seed_demo.sh``).

``--llm stub`` (the default) points ``llm_1`` at the local test stub
(``stub_llm.py``, http://127.0.0.1:18901/v1) and names it "Local stub LLM";
``--llm template`` leaves the template's placeholder key in place, to record
how the chat source behaves without a real key.

Before starting, it warms the tiktoken encodings the LLM node counts tokens
with, so the first chat does not wait for a download (best effort: offline it
says so and goes on).

Prints names and project ids only, never tokens. Every default is a
throwaway LOCAL-ONLY test value for a disposable container, not a secret.

Usage (from dist/server): ./engine <this folder>/start_fixtures.py [--only postgres,qdrant_pager] [--llm stub|template] [--stop]
The engine must run with ROCKETRIDE_DB_BROKER_URL/ROCKETRIDE_DB_BROKER_TOKEN for the rocketride_vector fixture (see README.md).
Settings: ENGINE_URL, RR_TEST_APIKEY and the VX_* variables of README.md.
"""

from __future__ import annotations

import argparse
import asyncio
import sys

from pathlib import Path
from typing import List

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import vx_fixtures as fx  # noqa: E402


def select(only: str) -> List[str]:
    """The fixture keys to act on: the comma-separated ``only`` list, or the defaults."""
    keys = [k.strip() for k in only.split(',') if k.strip()] or list(fx.DEFAULT_FIXTURES)
    unknown = [k for k in keys if k not in fx.FIXTURES]
    if unknown:
        raise ValueError(f'unknown fixture(s): {", ".join(unknown)}; known: {", ".join(fx.FIXTURES)}')
    return keys


def warm_tiktoken() -> None:
    """Load the tiktoken encodings once so the LLM node finds them in the local cache."""
    try:
        import tiktoken
    except ImportError:
        print('tiktoken is not installed in this Python; the first chat may wait for its download')
        return
    for encoding in ('o200k_base', 'cl100k_base'):
        try:
            tiktoken.get_encoding(encoding)
            print(f'tiktoken {encoding}: cached')
        except Exception as e:  # noqa: BLE001 - offline is reported, not fatal
            print(f'tiktoken {encoding}: not cached ({type(e).__name__}); the first chat may wait for it')


async def main() -> int:
    """Start (or with --stop, terminate) the selected fixtures."""
    from rocketride import RocketRideClient

    parser = argparse.ArgumentParser(description='Start the Vector Explorer fixture pipelines (local containers only).')
    parser.add_argument('--only', default='', help='comma-separated fixture keys: ' + ', '.join(fx.FIXTURES))
    parser.add_argument('--llm', choices=('stub', 'template'), default='stub')
    parser.add_argument('--stop', action='store_true')
    parser.add_argument('--no-warm-tiktoken', action='store_true')
    args = parser.parse_args()
    try:
        keys = select(args.only)
    except ValueError as e:
        parser.error(str(e))
    if not args.stop and not args.no_warm_tiktoken:
        warm_tiktoken()

    failures = 0
    # A first start installs and loads the embedding model, which can take minutes.
    async with RocketRideClient(uri=fx.ENGINE_URL, auth=fx.API_KEY, request_timeout=900000) as client:
        for key in keys:
            fixture = fx.FIXTURES[key]
            if args.stop:
                for source in await fx.stop(client, fixture.project_id, fixture.sources):
                    print(f'stopped {fixture.name} / {source}')
                continue
            pipe = fx.build_pipeline(key, args.llm)
            running = await fx.running_tasks(client)
            for source in fixture.sources:
                if (fixture.project_id, source) in running:
                    print(f'running {fixture.name} / {source} ({fixture.project_id})')
                    continue
                try:
                    await fx.ensure_started(client, pipe, (source,))
                    print(f'started {fixture.name} / {source} ({fixture.project_id})')
                except Exception as e:  # noqa: BLE001 - the other fixtures still start
                    failures += 1
                    print(f'FAILED {fixture.name} / {source}: {type(e).__name__}: {str(e)[:200]}')
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(asyncio.run(main()))
