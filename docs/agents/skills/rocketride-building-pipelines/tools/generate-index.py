#!/usr/bin/env python3
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================
"""Regenerate the Layer 1 node index from a live engine.

Rebuilds LAYER1_NODE_INDEX.json (the compact node catalog the designing/configuring
skills select nodes from) and LAYER1_NODE_INDEX.meta.json (the freshness stamp that
validate-pipeline.py's staleness check reads) from the engine's live service catalog
(client.get_services() via the RocketRide SDK).

Degrees of freedom: NONE beyond the flags below. Run this command exactly as shown;
do not hand-roll the catalog fetch or edit the index files by hand — this tool owns
their format.

Requires a reachable engine: the SDK reads ROCKETRIDE_URI / ROCKETRIDE_APIKEY from the
environment or a .env file. If no engine is reachable the bundled index stays as-is and
remains usable — it is just not refreshed.

Usage:
  python3 generate-index.py                     # refresh the bundled index in the
                                                # rocketride-designing-pipelines skill dir
  python3 generate-index.py --dry-run           # connect + report counts, write nothing
  python3 generate-index.py --output-dir DIR    # write the two files elsewhere
"""

import sys
import os
import json
import asyncio
import tempfile
from datetime import datetime, timezone

INDEX_NAME = 'LAYER1_NODE_INDEX.json'
META_NAME = 'LAYER1_NODE_INDEX.meta.json'


def default_output_dir():
    """The designing-pipelines skill dir, resolved relative to this script."""
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.normpath(os.path.join(here, '..', '..', 'rocketride-designing-pipelines'))


def to_index_entry(name, summary):
    """Reduce a service summary to the compact L1 index entry format:
    name + classType + lanes, plus invoke slot cardinalities when the node has them.
    """
    entry = {
        'name': name,
        'classType': summary.get('classType') or [],
        'lanes': summary.get('lanes') or {},
    }
    invoke = summary.get('invoke')
    if invoke:
        slots = {}
        for slot, spec in invoke.items():
            spec = spec if isinstance(spec, dict) else {}
            slots[slot] = {k: spec[k] for k in ('min', 'max') if k in spec}
        entry['invoke'] = slots
    return entry


def atomic_write(path, obj):
    """Atomically write JSON so a concurrent reader never sees a truncated file."""
    d = os.path.dirname(path)
    fd, tmp = tempfile.mkstemp(dir=d, suffix='.tmp')
    try:
        with os.fdopen(fd, 'w') as f:
            json.dump(obj, f, indent=2)
            f.write('\n')
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


async def from_engine():
    """Fetch the live service catalog; returns the get_services() response or None."""
    try:
        from rocketride import RocketRideClient  # type: ignore
    except Exception:
        sys.stderr.write('[generate-index] RocketRide SDK not importable; cannot refresh the index\n')
        sys.stderr.write(
            'ERROR_JSON: '
            + json.dumps(
                {
                    'code': 'ENGINE_UNAVAILABLE',
                    'retriable': False,
                    'fallback': 'the bundled LAYER1_NODE_INDEX.json remains usable as-is; install the SDK + .env to refresh it',
                }
            )
            + '\n'
        )
        return None
    try:
        async with RocketRideClient() as client:  # reads uri/auth from .env
            return await client.get_services()
    except Exception as e:
        sys.stderr.write(f'[generate-index] engine unavailable ({e}); cannot refresh the index\n')
        sys.stderr.write(
            'ERROR_JSON: '
            + json.dumps(
                {
                    'code': 'ENGINE_UNAVAILABLE',
                    'retriable': False,
                    'fallback': 'the bundled LAYER1_NODE_INDEX.json remains usable as-is; configure ROCKETRIDE_URI/ROCKETRIDE_APIKEY (.env) and retry',
                }
            )
            + '\n'
        )
        return None


def main():
    args = sys.argv[1:]
    dry_run = '--dry-run' in args
    out_dir = default_output_dir()
    if '--output-dir' in args:
        i = args.index('--output-dir')
        if i + 1 >= len(args):
            sys.stderr.write('[generate-index] --output-dir needs a directory argument\n')
            sys.exit(2)
        out_dir = args[i + 1]

    resp = asyncio.run(from_engine())
    if resp is None:
        sys.exit(1)

    services = resp.get('services') or {}
    if not services:
        sys.stderr.write(
            '[generate-index] engine returned an empty service catalog; refusing to write an empty index\n'
        )
        sys.stderr.write(
            'ERROR_JSON: '
            + json.dumps(
                {
                    'code': 'EMPTY_CATALOG',
                    'retriable': True,
                    'fallback': 'the bundled LAYER1_NODE_INDEX.json remains usable as-is; check the engine and retry',
                }
            )
            + '\n'
        )
        sys.exit(1)

    index = sorted(
        (to_index_entry(name, summary or {}) for name, summary in services.items()),
        key=lambda e: e['name'],
    )
    meta = {
        'generated_at': datetime.now(timezone.utc).isoformat(),
        'node_count': len(index),
        'source': 'engine (get_services)',
    }
    if resp.get('version'):
        meta['engine_version'] = resp['version']

    if dry_run:
        print(f'[generate-index] DRY RUN: {len(index)} nodes from the engine; would write:')
        print(f'  {os.path.join(out_dir, INDEX_NAME)}')
        print(f'  {os.path.join(out_dir, META_NAME)}')
        print(f'  meta: {json.dumps(meta)}')
        return

    if not os.path.isdir(out_dir):
        sys.stderr.write(f'[generate-index] output dir not found: {out_dir}\n')
        sys.exit(2)
    atomic_write(os.path.join(out_dir, INDEX_NAME), index)
    atomic_write(os.path.join(out_dir, META_NAME), meta)
    print(f'[generate-index] wrote {len(index)} nodes to {os.path.join(out_dir, INDEX_NAME)}')
    print(f'[generate-index] stamped {os.path.join(out_dir, META_NAME)}: {json.dumps(meta)}')


if __name__ == '__main__':
    main()
