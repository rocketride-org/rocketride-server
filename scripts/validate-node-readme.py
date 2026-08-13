#!/usr/bin/env python3
"""Validate node READMEs against docs/development/node-readme-schema.md.

Deterministic, no LLM. For each node directory:
  1. Parse and merge services*.json (JSONC: // comments + trailing commas).
     Entries without a "protocol" are shared fragments and are ignored.
  2. Compute required / forbidden sections from declared triggers.
  3. Check the hand-written region's title, section presence, order, and
     table-key parity with the merged service metadata. The
     ROCKETRIDE:GENERATED:PARAMS region is exempt (checked only for being
     last).

Checks that don't apply to a node report SKIPPED, never FAILED.

Usage: validate-node-readme.py <node-dir> [<node-dir> ...]
       validate-node-readme.py --all nodes/src/nodes
"""

import json
import re
import sys
from pathlib import Path

CANONICAL_ORDER = [
    'About',  # optional, vendor
    'What it does',  # core
    'Example pipelines',  # core (>=1 real flow; opens with the shipped example)
    'Connections',  # conditional: invoke
    'Lanes',  # conditional: lanes
    'As a tool',  # conditional: tool in classType
    'Profiles',  # conditional: >=2 real profiles
    'Configuration',  # core (usage guidance + ### field details)
    'Authentication',  # optional: credential setup
    'Requirements',  # conditional: gpu
    'Limitations',  # conditional: nosaas/noremote/security/filesystem
    'Notes',  # optional
    'Upstream docs',  # optional
]
OPTIONAL = {'About', 'Authentication', 'Notes', 'Upstream docs'}
LIMITATION_CAPS = {'nosaas', 'noremote', 'security', 'filesystem'}
GEN_START = '<!-- ROCKETRIDE:GENERATED:PARAMS START -->'
GEN_END = '<!-- ROCKETRIDE:GENERATED:PARAMS END -->'


def strip_jsonc(s: str) -> str:
    out, i, n, instr = [], 0, len(s), False
    while i < n:
        c = s[i]
        if instr:
            out.append(c)
            if c == '\\' and i + 1 < n:
                out.append(s[i + 1])
                i += 2
                continue
            if c == '"':
                instr = False
            i += 1
            continue
        if c == '"':
            instr = True
            out.append(c)
            i += 1
            continue
        if c == '/' and i + 1 < n and s[i + 1] == '/':
            while i < n and s[i] != '\n':
                i += 1
            continue
        out.append(c)
        i += 1
    return re.sub(r',(\s*[}\]])', r'\1', ''.join(out))


def load_services(node_dir: Path):
    """Load and merge all protocol-bearing entries from services*.json.

    Some nodes define multiple services (e.g. agent_deepagent). Entries
    without a "protocol" are shared field fragments (e.g. nodes/src/nodes/
    core/services.common.*.json), not nodes. Returns None when the dir has
    no protocol-bearing entry.
    """
    files = sorted(node_dir.glob('services*.json'))
    if not files:
        raise FileNotFoundError(node_dir / 'services.json')
    entries = []
    for f in files:
        d = json.loads(strip_jsonc(f.read_text()))
        for e in d if isinstance(d, list) else [d]:
            if isinstance(e, dict) and e.get('protocol'):
                entries.append(e)
    if not entries:
        return None
    merged = dict(entries[0])
    merged['_service_count'] = len(entries)
    for e in entries[1:]:
        merged['classType'] = sorted(set(merged.get('classType') or []) | set(e.get('classType') or []))
        merged['capabilities'] = sorted(set(merged.get('capabilities') or []) | set(e.get('capabilities') or []))
        merged['lanes'] = {**(e.get('lanes') or {}), **(merged.get('lanes') or {})}
        inv = {**(e.get('invoke') or {}), **(merged.get('invoke') or {})}
        merged['invoke'] = inv or None
        merged['fields'] = {**(e.get('fields') or {}), **(merged.get('fields') or {})}
        pc_m = merged.get('preconfig') or {}
        pc_e = e.get('preconfig') or {}
        pc_m['profiles'] = {**(pc_e.get('profiles') or {}), **(pc_m.get('profiles') or {})}
        merged['preconfig'] = pc_m
    return merged


def real_profiles(svc) -> dict:
    pc = svc.get('preconfig') or {}
    profs = pc.get('profiles') or {}
    return {k: v for k, v in profs.items() if k != 'custom'}


def required_sections(svc):
    req = {'What it does', 'Configuration', 'Example pipelines'}
    forb = set()
    (req if svc.get('invoke') else forb).add('Connections')
    (req if svc.get('lanes') else forb).add('Lanes')
    (req if 'tool' in svc.get('classType', []) else forb).add('As a tool')
    (req if len(real_profiles(svc)) >= 2 else forb).add('Profiles')
    caps = set(svc.get('capabilities', []))
    (req if 'gpu' in caps else forb).add('Requirements')
    (req if caps & LIMITATION_CAPS else forb).add('Limitations')
    return req, forb


def canon(h: str) -> str:
    return 'About' if h.startswith('About') else h.strip()


def table_col(text: str, section: str, col: int = 0):
    """First-column cell values of tables in a section (markup-stripped).

    Header rows are detected structurally: a table row immediately followed
    by a |---| separator line is a header.
    """
    m = re.search(rf'^## {re.escape(section)}.*?$(.*?)(?=^## |\Z)', text, re.M | re.S)
    if not m:
        return []
    vals = []
    lines = m.group(1).splitlines()
    for i, line in enumerate(lines):
        row = re.match(r'^\|(.+)\|$', line)
        if not row:
            continue
        nxt = lines[i + 1] if i + 1 < len(lines) else ''
        if re.match(r'^\|[\s\-:|]+\|$', nxt):
            continue  # header row
        cells = [re.sub(r'\s*\(default\)\s*', '', re.sub(r'[*_`]', '', c)).strip() for c in row.group(1).split('|')]
        if cells and not set(cells[0]) <= {'-', ' ', ':'}:
            vals.append(cells[col] if col < len(cells) else '')
    return [v for v in vals if v]


def complex_fields(svc):
    """Fields with objective complexity signals: textarea widget or a large
    enum. Returns their display titles.
    """
    out = []
    for key, v in (svc.get('fields') or {}).items():
        if not isinstance(v, dict) or not v.get('title') or not v.get('type'):
            continue
        ui = v.get('ui') or {}
        big_enum = isinstance(v.get('enum'), list) and len(v['enum']) > 6
        if ui.get('ui:widget') == 'textarea' or big_enum:
            out.append(v['title'])
    return out


def validate(node_dir: Path):
    name = node_dir.name
    results = []

    def add(status, check, detail=''):
        results.append((status, check, detail))

    try:
        svc = load_services(node_dir)
    except FileNotFoundError:
        return name, [('SKIP', 'all', 'no services*.json (not a node)')]
    except Exception as e:
        return name, [('FAIL', 'services*.json parses', str(e)[:80])]
    if svc is None:
        return name, [('SKIP', 'all', 'shared fragments only (no protocol)')]

    readme = node_dir / 'README.md'
    if not readme.exists():
        return name, [('FAIL', 'README exists', 'no README.md')]
    full = readme.read_text()

    # -- split hand-written / generated regions --
    if GEN_START in full:
        hand, _, tail = full.partition(GEN_START)
        add('PASS' if GEN_END in tail else 'FAIL', 'generated region is terminated', 'missing END marker')
        after = tail.split(GEN_END, 1)[1] if GEN_END in tail else ''
        add('PASS' if not after.strip() else 'FAIL', 'generated region is last', 'content found after END marker')
    else:
        hand = full
        add('SKIP', 'generated region', 'none present')

    # -- title + summary --
    m = re.match(r'^# (.+?)\s*$', hand, re.M)
    add(
        'PASS' if m and m.group(1) == name else 'FAIL',
        'H1 equals directory name',
        f"'{m.group(1) if m else '(no H1)'}' != '{name}'" if not (m and m.group(1) == name) else '',
    )
    if m:
        rest = hand[m.end() :]
        first_para = next((p.strip() for p in rest.split('\n\n') if p.strip()), '')
        add('PASS' if first_para and not first_para.startswith('#') else 'FAIL', 'summary paragraph after H1')

    headings = re.findall(r'^## (.+)$', hand, re.M)
    seen = [canon(h) for h in headings]
    req, forb = required_sections(svc)

    # -- section presence / forbidden / unknown --
    for s in sorted(req):
        add('PASS' if s in seen else 'FAIL', f"required section '{s}'")
    for s in sorted(forb):
        if s in seen:
            add('FAIL', f"section '{s}' forbidden", 'trigger is false in services*.json — README and metadata disagree')
        else:
            add('SKIP', f"section '{s}'", 'not applicable')
    for s in seen:
        if s not in CANONICAL_ORDER:
            add('FAIL', f"unknown heading '## {s}'", 'move under ## Notes')

    # -- order --
    idx = [CANONICAL_ORDER.index(s) for s in seen if s in CANONICAL_ORDER]
    add(
        'PASS' if idx == sorted(idx) else 'FAIL',
        'section order',
        '' if idx == sorted(idx) else f'got: {", ".join(seen)}',
    )

    # -- About rules --
    if 'About' in seen:
        if seen[0] != 'About':
            add('FAIL', 'About is first section')
        body = re.search(r'^## About.*?$(.*?)(?=^## |\Z)', hand, re.M | re.S)
        words = len(body.group(1).split()) if body else 0
        add('PASS' if words <= 80 else 'FAIL', 'About <= 80 words', f'{words} words')
        add('PASS' if 'Upstream docs' in seen else 'FAIL', 'Upstream docs present when About exists')

    # -- table-key parity --
    if svc.get('invoke'):
        want = set(svc['invoke'].keys())
        got = set(table_col(hand, 'Connections'))
        add(
            'PASS' if want <= got else 'FAIL',
            'Connections rows match invoke keys',
            f'missing: {sorted(want - got)}' if not want <= got else '',
        )
    if svc.get('lanes') and 'Lanes' in seen:
        want = set(svc['lanes'].keys())
        got = set(table_col(hand, 'Lanes'))
        add(
            'PASS' if want <= got else 'FAIL',
            'Lanes rows match declared lanes',
            f'missing lane-in: {sorted(want - got)}' if not want <= got else '',
        )
    profs = real_profiles(svc)
    if len(profs) >= 2 and 'Profiles' in seen:
        # Rows may lead with either the profile key or its display title
        # (checked across the first two columns).
        got = set(table_col(hand, 'Profiles')) | set(table_col(hand, 'Profiles', 1))
        missing = set()
        for k, v in profs.items():
            if not isinstance(v, dict):
                continue
            title = v.get('title') or k
            if k not in got and not any(title in g or g in title for g in got):
                missing.add(title)
        add(
            'PASS' if not missing else 'FAIL',
            'Profiles rows match preconfig',
            f'missing: {sorted(missing)}' if missing else '',
        )

    # -- Example pipelines: >=1 flow, plus the shipped-example bundle --
    if 'Example pipelines' in seen:
        body = re.search(r'^## Example pipelines.*?$(.*?)(?=^## |\Z)', hand, re.M | re.S)
        section = body.group(1) if body else ''
        add(
            'PASS' if '→' in section else 'FAIL',
            'Example pipelines has >=1 flow',
            'no `a → b` pipeline shape found',
        )

        # Shipped example bundle: example.pipe + example.png in the node dir,
        # a screenshot embed, and a download badge linking the .pipe. All or
        # nothing — any part present makes every part required. Nothing at
        # all is a WARN (pre-bundle node awaiting migration).
        pipe_file = (node_dir / 'example.pipe').exists()
        png_file = (node_dir / 'example.png').exists()
        images = re.findall(r'!\[([^\]]*)\]\((?:\./)?example\.png\)', section)
        # A plain or badge link whose target is the .pipe file.
        pipe_links = re.findall(r'\]\((?:\./)?example\.pipe\)', section)
        parts = {
            'example.pipe file': pipe_file,
            'example.png file': png_file,
            'screenshot embed (example.png)': bool(images),
            'download link (example.pipe)': bool(pipe_links),
        }
        if any(parts.values()):
            for label, present in parts.items():
                add(
                    'PASS' if present else 'FAIL',
                    f'shipped example: {label}',
                    '' if present else 'bundle is all-or-nothing',
                )
            if images:
                add(
                    'PASS' if images[0].strip() else 'FAIL',
                    'shipped example: screenshot has alt text',
                )
        else:
            add('WARN', 'shipped example bundle', 'no example.pipe/example.png yet (required for new nodes)')

    # -- Layer-2 floor: complex fields should have a ### under Configuration --
    conf = re.search(r'^## Configuration.*?$(.*?)(?=^## |\Z)', hand, re.M | re.S)
    if conf:
        subs = re.findall(r'^### (.+)$', conf.group(1), re.M)

        def tokens(s):
            return {t for t in re.findall(r'[a-z0-9]+', s.lower()) if len(t) > 2}

        for title in complex_fields(svc):
            # Covered when a subsection heading contains the title (or vice
            # versa), or contains all of the title's significant words —
            # grouped subsections like "Detection / Recognition Architecture"
            # cover both grouped fields.
            covered = any(
                title.lower() in s.lower() or s.lower() in title.lower() or tokens(title) <= tokens(s) for s in subs
            )
            if not covered:
                add(
                    'WARN',
                    'complex field has a detail subsection',
                    f"'{title}' (textarea/large-enum) has no ### under Configuration",
                )

    return name, results


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        sys.exit(2)
    if args[0] == '--all':
        dirs = sorted(p for p in Path(args[1]).iterdir() if p.is_dir() and any(p.glob('services*.json')))
    else:
        dirs = [Path(a) for a in args]

    any_fail = False
    for d in dirs:
        name, results = validate(d)
        fails = [r for r in results if r[0] == 'FAIL']
        warns = [r for r in results if r[0] == 'WARN']
        skipped_all = all(r[0] == 'SKIP' for r in results)
        if skipped_all:
            print(f'\n- {name}: SKIPPED ({results[0][2]})')
            continue
        status = 'FAIL' if fails else 'PASS'
        any_fail |= bool(fails)
        print(
            f'\n{"x" if fails else "ok"} {name}: {status} '
            f'({len(fails)} failed, {len(warns)} warnings, '
            f'{len([r for r in results if r[0] == "PASS"])} passed)'
        )
        for st, check, detail in results:
            if st in ('FAIL', 'WARN'):
                print(f'    {st}: {check}' + (f' — {detail}' if detail else ''))
    if any_fail:
        print('\nSchema: docs/development/node-readme-schema.md')
    sys.exit(1 if any_fail else 0)


if __name__ == '__main__':
    main()
