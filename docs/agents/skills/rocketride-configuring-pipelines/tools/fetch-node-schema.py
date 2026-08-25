#!/usr/bin/env python3
"""Fetch one node's config schema (Layer 2).

CONSTRAINT (agent contract / future MCP tool description): configure a node using ONLY the fields
this schema defines — never invent field names (e.g. it is `modelTotalTokens`, not `max_tokens`).
Fetch ONE node at a time; never bulk-load the schema catalog (FF#17).

Degrees of freedom: NONE. Run this command exactly as shown — one node name, optionally --cache-ok.
Do not add other flags, pipe it through transforms, or hand-roll the schema fetch in your own code;
the agent contract IS this one command.

Order of preference:
  1. --cache-ok + a warm cache → serve .rocketride/schema/<name>.json with NO reconnect (fast path)
  2. Live engine via the RocketRide SDK:  client.get_service(<name>) → write-through to the cache
  3. The cached catalog file:             .rocketride/schema/<name>.json

Usage:
  python3 fetch-node-schema.py <node_name>              # engine-first (freshest); caches the result
  python3 fetch-node-schema.py --cache-ok <node_name>   # reuse a warm cache, skip the reconnect (T1)

Prints the service/schema definition as JSON. The agent reads `required` fields, the
`Pipe.schema` (incl. dependencies.profile.oneOf for LLM/embedding/store profiles), and any
conditional constraints before configuring the node. Never configure a node without this.
"""

import sys
import os
import json
import asyncio


def from_files(name):
    """Walk up from cwd looking for .rocketride/schema/<name>.json."""
    here = os.getcwd()
    for _ in range(8):
        cand = os.path.join(here, '.rocketride', 'schema', f'{name}.json')
        if os.path.isfile(cand):
            return json.load(open(cand))
        parent = os.path.dirname(here)
        if parent == here:
            break
        here = parent
    return None


def _schema_dir():
    """Walk up from cwd for an existing .rocketride/schema dir (where the cache lives)."""
    here = os.getcwd()
    for _ in range(8):
        d = os.path.join(here, '.rocketride', 'schema')
        if os.path.isdir(d):
            return d
        parent = os.path.dirname(here)
        if parent == here:
            break
        here = parent
    return None


def write_through(name, result):
    """Atomically cache a live schema so a later --cache-ok serves it with no reconnect (T1)."""
    d = _schema_dir()
    if not d:
        return False
    try:
        import tempfile

        fd, tmp = tempfile.mkstemp(dir=d, suffix='.tmp')
        with os.fdopen(fd, 'w') as f:
            json.dump(result, f, indent=2)
        os.replace(tmp, os.path.join(d, f'{name}.json'))
        return True
    except Exception:
        return False


async def from_engine(name):
    try:
        from rocketride import RocketRideClient  # type: ignore
    except Exception:
        sys.stderr.write('[fetch-node-schema] RocketRide SDK not importable; falling back to files\n')
        sys.stderr.write(
            'ERROR_JSON: '
            + json.dumps(
                {
                    'code': 'ENGINE_UNAVAILABLE',
                    'retriable': False,
                    'fallback': 'reading the bundled .rocketride/schema/<name>.json (do NOT retry the engine)',
                }
            )
            + '\n'
        )
        return None
    try:
        async with RocketRideClient() as client:  # reads uri/auth from .env
            return await client.get_service(name)
    except Exception as e:
        sys.stderr.write(f'[fetch-node-schema] engine unavailable ({e}); falling back to files\n')
        sys.stderr.write(
            'ERROR_JSON: '
            + json.dumps(
                {
                    'code': 'ENGINE_UNAVAILABLE',
                    'retriable': False,
                    'fallback': 'reading the bundled .rocketride/schema/<name>.json (do NOT retry the engine)',
                }
            )
            + '\n'
        )
        return None


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    cache_ok = '--cache-ok' in sys.argv
    if not args:
        sys.stderr.write(__doc__)
        sys.exit(2)
    name = args[0]
    # T1 fast path: --cache-ok serves a warm cached schema with NO reconnect (e.g. Phase 2 reusing
    # the schema design already fetched this session — still schema-grounded, just not re-fetched).
    if cache_ok:
        cached = from_files(name)
        if cached is not None:
            sys.stderr.write('[fetch-node-schema] source: cache (--cache-ok, no reconnect)\n')
            print(json.dumps(cached, indent=2))
            return
    result = asyncio.run(from_engine(name))
    source = 'engine (get_service)'
    if result is not None:
        source = 'engine (get_service) [cached]' if write_through(name, result) else source
    else:
        result = from_files(name)
        source = '.rocketride/schema file'
    if result is None:
        sys.stderr.write(
            f"[fetch-node-schema] no schema for '{name}' from engine or files.\n"
            f'  - is the node name spelled exactly as in the index?\n'
            f'  - run from a workspace with a .rocketride/ dir, or connect an engine (.env).\n'
        )
        sys.stderr.write(
            'ERROR_JSON: '
            + json.dumps(
                {
                    'code': 'SCHEMA_NOT_FOUND',
                    'retriable': False,
                    'fallback': 'verify the node name against the L1 index — it may not exist; do not invent fields',
                }
            )
            + '\n'
        )
        sys.exit(1)
    sys.stderr.write(f'[fetch-node-schema] source: {source}\n')
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
