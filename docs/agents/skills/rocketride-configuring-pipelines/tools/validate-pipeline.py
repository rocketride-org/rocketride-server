#!/usr/bin/env python3
"""Validate a RocketRide pipeline (Layer 3 — the backstop).

CONSTRAINT (agent contract / future MCP tool description): run this before ANY pipeline run and
accept ONLY a zero-error result. On errors, show them verbatim, fix the offending node, and
re-validate — never claim a pipeline is valid without a clean result in hand.

Degrees of freedom: NONE. Run this command exactly as shown (the file path, optionally --static).
Do not hand-roll the structural/lane/cycle checks in your own code or eyeball the JSON to declare it
valid; this tool IS the validator the agent must call.

Two modes:
  (default)  Engine validation via the SDK: client.validate(pipeline) -> {errors, warnings}.
             This is authoritative (real structural + connection + chain checks). Falls back to
             --static automatically if no engine/SDK is reachable (and says so).
  --static   Local pre-flight lint only (no engine): the 9-point checklist + lane compatibility +
             cycle/orphan detection, checked against the node catalog. Fast, but NOT authoritative
             — always run engine validation before a real run.

Usage:
  python3 validate-pipeline.py mypipeline.pipe
  python3 validate-pipeline.py --static mypipeline.pipe

Exit code 0 = no errors; 1 = errors found; 2 = usage/load error.
"""

import sys
import os
import json
import re
import asyncio
from datetime import datetime, timezone

GUID_RE = re.compile(r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')
STALE_DAYS = 14


def staleness_note():
    """NON-BLOCKING freshness check (T2): warn if the bundled L1 node index has no freshness stamp
    or is older than STALE_DAYS. Returns a note string or None. Never affects the exit code.
    """
    here = os.path.dirname(os.path.abspath(__file__))
    cand = os.path.normpath(
        os.path.join(here, '..', '..', 'rocketride-designing-pipelines', 'LAYER1_NODE_INDEX.meta.json')
    )
    if not os.path.isfile(cand):  # also accept a workspace-local stamp
        d = os.getcwd()
        for _ in range(8):
            c = os.path.join(d, '.rocketride', 'LAYER1_NODE_INDEX.meta.json')
            if os.path.isfile(c):
                cand = c
                break
            p = os.path.dirname(d)
            if p == d:
                break
            d = p
    if not os.path.isfile(cand):
        return (
            'node index has no freshness stamp — run tools/generate-index.py against a live '
            'engine to stamp + refresh it. Proceeding with the bundled snapshot.'
        )
    try:
        meta = json.load(open(cand))
        gen = datetime.fromisoformat(meta.get('generated_at'))
        if gen.tzinfo is None:
            gen = gen.replace(tzinfo=timezone.utc)
        age = (datetime.now(timezone.utc) - gen).days
        if age > STALE_DAYS:
            return (
                f'node index snapshot is {age} days old ({meta.get("node_count")} nodes) — '
                f'run tools/generate-index.py against a live engine before trusting node '
                f'selection. Proceeding with the bundled snapshot.'
            )
    except Exception:
        return (
            'node index freshness stamp unreadable — consider re-running '
            'tools/generate-index.py. Proceeding with the bundled snapshot.'
        )
    return None


# ---------- catalog loading (for --static) ----------
def load_catalog(start):
    """Find the node catalog: live .rocketride/services-catalog.json (walk up), else the bundled
    LAYER1_NODE_INDEX.json next to the skills. Returns {name: entry} or None.
    """
    here = os.path.abspath(start)
    for _ in range(8):
        cand = os.path.join(here, '.rocketride', 'services-catalog.json')
        if os.path.isfile(cand):
            data = json.load(open(cand))
            return {e['name']: e for e in data}
        parent = os.path.dirname(here)
        if parent == here:
            break
        here = parent
    bundled = os.path.join(
        os.path.dirname(os.path.abspath(__file__)),
        '..',
        '..',
        'rocketride-designing-pipelines',
        'LAYER1_NODE_INDEX.json',
    )
    if os.path.isfile(bundled):
        return {e['name']: e for e in json.load(open(bundled))}
    return None


def out_lanes(entry):
    s = set()
    for outs in (entry.get('lanes') or {}).values():
        s.update(outs or [])
    return s


def in_lanes(entry):
    return {k for k in (entry.get('lanes') or {}).keys() if k != '_source'}


def is_source(entry):
    return 'source' in (entry.get('classType') or [])


def static_validate(path):
    errors, warnings = [], []
    try:
        obj = json.load(open(path))
    except Exception as e:
        return [f'could not parse pipeline JSON: {e}'], []

    # 1. extension
    if not path.endswith('.pipe'):
        errors.append('file must use the .pipe extension, not .json')
    # 2. components present (conventionally first; schema marks key order optional)
    keys = list(obj.keys())
    if 'components' not in obj:
        errors.append('pipeline must have a `components` array')
    elif keys and keys[0] != 'components':
        warnings.append('`components` is conventionally the first key (editor convention; schema marks order optional)')
    comps = obj.get('components') or []
    if not comps:
        return errors + ['pipeline has no components'], warnings
    # 3. project_id (optional per schema; if present, should be a literal GUID, not a variable)
    pid = obj.get('project_id')
    if pid is not None and (not isinstance(pid, str) or '$' in pid or not GUID_RE.match(pid)):
        warnings.append(f'project_id should be a literal GUID, not a variable (editor convention); got {pid!r}')

    ids = [c.get('id') for c in comps]
    # 5. unique ids
    dupes = {i for i in ids if ids.count(i) > 1}
    if dupes:
        errors.append(f'duplicate component ids: {sorted(dupes)}')
    idset = set(ids)
    # 4. source field (optional) matches a component
    if 'source' in obj and obj['source'] not in idset:
        errors.append(f'`source` {obj["source"]!r} does not match any component id')

    cat = load_catalog(os.path.dirname(os.path.abspath(path)) or '.')
    if cat is None:
        warnings.append('no catalog found (.rocketride/ or bundled index) — lane checks skipped')

    sources = []
    adj = {i: [] for i in ids}  # from -> [to]
    has_incoming = set()
    has_control = set()
    for c in comps:
        cid, prov = c.get('id'), c.get('provider')
        entry = cat.get(prov) if cat else None
        if cat and entry is None:
            errors.append(f'component {cid!r}: provider {prov!r} not found in catalog')
        ctrl = c.get('control') or []
        src = is_source(entry) if entry else (not c.get('input') and not ctrl)
        if src:
            sources.append(cid)
        if ctrl:
            has_control.add(cid)
        for ce in ctrl:  # control-plane nodes (llm/tool/memory attached to an agent)
            if ce.get('from') not in idset:
                errors.append(f'{cid!r} control.from {ce.get("from")!r} is not a component id')
        inputs = c.get('input') or []
        # 6. non-source, non-control node needs input
        if not src and not inputs and not ctrl:
            errors.append(f'non-source component {cid!r} has no input array and no control')
        for edge in inputs:
            frm, lane = edge.get('from'), edge.get('lane')
            if frm not in idset:
                errors.append(f'{cid!r} input.from {frm!r} is not a component id')
                continue
            adj[frm].append(cid)
            has_incoming.add(cid)
            # 7. lane compatibility
            if cat and entry is not None:
                frm_entry = cat.get(comp_by_id(comps, frm, 'provider'))
                if frm_entry and lane not in out_lanes(frm_entry):
                    errors.append(f'lane {lane!r}: {frm!r} does not output it (edge {frm}->{cid})')
                if lane not in in_lanes(entry) and in_lanes(entry):
                    errors.append(f'lane {lane!r}: {cid!r} does not accept it (edge {frm}->{cid})')
        # 9. secrets via env substitution (any ${VAR}); flag hardcoded literals only
        for k, v in flatten(c.get('config') or {}):
            if 'apikey' in k.lower() and isinstance(v, str) and v and not v.startswith('${'):
                errors.append(f'{cid!r} config {k}: hardcoded secret — use ${{ENV_VAR}} substitution')
    # one source
    if len(sources) == 0:
        errors.append('no source component found (need exactly one)')
    elif len(sources) > 1:
        errors.append(f'more than one source component: {sources}')
    # 8. orphans + cycles
    for c in comps:
        cid = c.get('id')
        if cid not in sources and cid not in has_incoming and cid not in has_control:
            warnings.append(f'component {cid!r} is orphaned (no incoming edge / control)')
    cyc = find_cycle(adj)
    if cyc:
        errors.append(f'cycle detected (pipelines must be acyclic): {" -> ".join(cyc)}')
    return errors, warnings


def comp_by_id(comps, cid, field):
    for c in comps:
        if c.get('id') == cid:
            return c.get(field)
    return None


def flatten(d, prefix=''):
    out = []
    if isinstance(d, dict):
        for k, v in d.items():
            out += flatten(v, f'{prefix}{k}.')
    elif isinstance(d, list):
        for i, v in enumerate(d):
            out += flatten(v, f'{prefix}{i}.')
    else:
        out.append((prefix.rstrip('.'), d))
    return out


def find_cycle(adj):
    WHITE, GRAY, BLACK = 0, 1, 2
    color = {n: WHITE for n in adj}
    stack = []

    def dfs(n):
        color[n] = GRAY
        stack.append(n)
        for m in adj.get(n, []):
            if color.get(m) == GRAY:
                return stack[stack.index(m) :] + [m]
            if color.get(m, BLACK) == WHITE:
                r = dfs(m)
                if r:
                    return r
        stack.pop()
        color[n] = BLACK
        return None

    for n in adj:
        if color[n] == WHITE:
            r = dfs(n)
            if r:
                return r
    return None


# ---------- engine validation (default) ----------
async def engine_validate(path):
    try:
        from rocketride import RocketRideClient  # type: ignore
    except Exception:
        sys.stderr.write('[validate] RocketRide SDK not importable; falling back to --static\n')
        sys.stderr.write(
            'ERROR_JSON: '
            + json.dumps(
                {
                    'code': 'ENGINE_UNAVAILABLE',
                    'retriable': False,
                    'fallback': 'ran --static lint (no SDK/engine). Install the SDK + .env to validate against an engine.',
                }
            )
            + '\n'
        )
        return None
    try:
        pipeline = json.load(open(path))
        async with RocketRideClient() as client:
            return await client.validate(pipeline)
    except Exception as e:
        sys.stderr.write(f'[validate] engine unavailable ({e}); falling back to --static\n')
        sys.stderr.write(
            'ERROR_JSON: '
            + json.dumps(
                {
                    'code': 'ENGINE_UNAVAILABLE',
                    'retriable': False,
                    'fallback': 'ran --static lint (no engine). To validate against a live engine, configure .env.',
                }
            )
            + '\n'
        )
        return None


def report(errors, warnings, mode):
    sys.stderr.write(f'[validate] mode: {mode}\n')
    for w in warnings:
        print(f'WARNING: {w}')
    for e in errors:
        print(f'ERROR: {e}')
    print(f'\nvalidate(): {len(errors)} errors, {len(warnings)} warnings')
    if errors:
        sys.stderr.write(
            'ERROR_JSON: '
            + json.dumps(
                {
                    'code': 'VALIDATION_FAILED',
                    'retriable': True,
                    'fallback': 'fix the listed errors and re-validate; never run an invalid pipeline',
                }
            )
            + '\n'
        )
    sys.exit(1 if errors else 0)


def main():
    args = [a for a in sys.argv[1:] if a != '--static']
    static = '--static' in sys.argv
    if not args:
        sys.stderr.write(__doc__)
        sys.exit(2)
    path = args[0]
    if not os.path.isfile(path):
        sys.stderr.write(f'[validate] file not found: {path}\n')
        sys.exit(2)
    note = staleness_note()
    if note:
        print(f'WARNING (freshness): {note}')
    if not static:
        res = asyncio.run(engine_validate(path))
        if res is not None:
            errs = [e.get('message', str(e)) if isinstance(e, dict) else str(e) for e in res.get('errors', [])]
            warns = [w.get('message', str(w)) if isinstance(w, dict) else str(w) for w in res.get('warnings', [])]
            report(errs, warns, 'engine (client.validate)')
            return
    errors, warnings = static_validate(path)
    report(errors, warnings, 'static lint (NOT authoritative — run engine validation before a real run)')


if __name__ == '__main__':
    main()
