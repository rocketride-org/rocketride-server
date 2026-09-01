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
"""Validate node READMEs against docs/development/nodes/readme-schema.md.

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
    'Example pipelines',  # PARKED — tolerated in this slot, no longer required
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
PROFILE_HEADERS = {
    'profile': 'profile',
    # A table that gives the key and the title their own columns (ocr) heads the
    # first one 'Profile key'. Without the alias every row resolves to an empty
    # cell and a well-formed table reports every profile missing.
    'profile key': 'profile',
    'model': 'model',
    'model id': 'model',
    'context': 'modelTotalTokens',
    'context tokens': 'modelTotalTokens',
    'output': 'modelOutputTokens',
    'output tokens': 'modelOutputTokens',
}


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
    # Each protocol-bearing service declares its own default. A branded preset or
    # a second provider registration (cloud_tts, store_elasticsearch,
    # llm_openai_api) is a different node from the engine's point of view, so its
    # default is a fact about that service, not a competing claim about this one.
    # Order follows file order, primary service first.
    defaults = []
    for e in entries:
        d = (e.get('preconfig') or {}).get('default')
        if d and d not in defaults:
            defaults.append(d)
    merged['_defaults'] = defaults
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


def declared_profiles(svc) -> dict:
    return (svc.get('preconfig') or {}).get('profiles') or {}


def section_body(text: str, section: str) -> str:
    match = re.search(rf'^## {re.escape(section)}.*?$(.*?)(?=^## |\Z)', text, re.M | re.S)
    return match.group(1) if match else ''


def parse_profile_tables(section: str) -> list[dict]:
    details_start = list(re.finditer(r'^<details>\s*$', section, re.M))
    details_end = list(re.finditer(r'^</details>\s*$', section, re.M))
    details_bounds = None
    if len(details_start) == len(details_end) == 1 and details_start[0].start() < details_end[0].start():
        details_bounds = (details_start[0].start(), details_end[0].start())

    pattern = re.compile(
        r'^(?P<header>\|[^\n]*\|)[ \t]*\n'
        r'(?P<separator>\|(?:[ \t]*:?-+:?[ \t]*\|)+)[ \t]*(?:\n|\Z)'
        r'(?P<rows>(?:\|[^\n]*\|[ \t]*(?:\n|\Z))*)',
        re.M,
    )
    tables = []
    for match in pattern.finditer(section):
        raw_headers = [cell.strip() for cell in match.group('header').strip()[1:-1].split('|')]
        headers = []
        for header in raw_headers:
            normalized = re.sub(r'\s+', ' ', _clean_cell(header)).lower()
            headers.append(PROFILE_HEADERS.get(normalized, normalized))
        rows = []
        for line in match.group('rows').splitlines():
            cells = [cell.strip() for cell in line.strip()[1:-1].split('|')]
            rows.append(dict(zip(headers, cells)))
        offset = match.start()
        tables.append(
            {
                'headers': headers,
                'rows': rows,
                'collapsed': bool(details_bounds and details_bounds[0] < offset < details_bounds[1]),
                'offset': offset,
            }
        )
    return tables


def resolve_profile_row(row: dict, profiles: dict) -> str | None:
    raw = row.get('profile', '')
    cleaned = _clean_cell(raw)
    if cleaned in profiles:
        return cleaned
    for key, metadata in profiles.items():
        if isinstance(metadata, dict) and _collapse_ws(cleaned) == _collapse_ws(metadata.get('title') or key):
            return key
    for key in re.findall(r'`([^`]+)`', raw):
        if key in profiles:
            return key
    return None


def profile_results(svc: dict, hand: str) -> list[tuple[str, str, str]]:
    profiles = declared_profiles(svc)
    section = section_body(hand, 'Profiles')
    if len({key for key in profiles if key != 'custom'}) < 2 or not section:
        return []

    defaults = [key for key in (svc.get('_defaults') or []) if key in profiles]
    if not defaults:
        fallback = (svc.get('preconfig') or {}).get('default')
        defaults = [fallback] if fallback else []
    # The primary service's default leads the visible table in the large layout.
    default = defaults[0] if defaults else None
    large = 'llm' in (svc.get('classType') or []) and len(profiles) > 6
    tables = parse_profile_tables(section)
    visible = [table for table in tables if not table['collapsed']]
    collapsed = [table for table in tables if table['collapsed']]
    details_start = list(re.finditer(r'^<details>\s*$', section, re.M))
    details_end = list(re.finditer(r'^</details>\s*$', section, re.M))
    results = []

    def add(ok, check, detail=''):
        results.append(('PASS' if ok else 'FAIL', check, '' if ok else detail))

    if large:
        layout_ok = (
            len(details_start) == len(details_end) == 1
            and len(tables) == 2
            and len(visible) == 1
            and len(collapsed) == 1
            and visible[0]['offset'] < details_start[0].start()
        )
        layout_detail = 'large LLM profile sections require one visible table and one table inside <details>'
    else:
        layout_ok = not details_start and not details_end and len(tables) == 1 and len(visible) == 1
        layout_detail = 'ordinary profile sections require one table and no <details> block'
    add(layout_ok, 'Profiles details layout', layout_detail)

    if large and len(visible) == len(collapsed) == 1:
        visible_headers = visible[0]['headers']
        collapsed_headers = collapsed[0]['headers']
        add(
            visible_headers == collapsed_headers,
            'Profiles table headers match',
            f'visible: {visible_headers}; collapsed: {collapsed_headers}',
        )

    row_records = []
    for table in tables:
        for row in table['rows']:
            row_records.append(
                {
                    'row': row,
                    'key': resolve_profile_row(row, profiles),
                    'headers': table['headers'],
                    'collapsed': table['collapsed'],
                }
            )

    resolved = [record['key'] for record in row_records if record['key'] is not None]
    missing = sorted(set(profiles) - set(resolved))
    duplicates = sorted({key for key in resolved if resolved.count(key) > 1})
    unknown = [_clean_cell(record['row'].get('profile', '')) for record in row_records if record['key'] is None]
    add(not missing, 'Profiles missing rows', f'missing: {missing}')
    add(not duplicates, 'Profiles duplicate rows', f'duplicate: {duplicates}')
    add(not unknown, 'Profiles unknown rows', f'unknown: {unknown}')

    semantic_fields = (
        ('model', 'Profiles model matches preconfig'),
        ('modelTotalTokens', 'Profiles context tokens match preconfig'),
        ('modelOutputTokens', 'Profiles output tokens match preconfig'),
    )
    for field, check in semantic_fields:
        mismatches = []
        for record in row_records:
            key = record['key']
            metadata = profiles.get(key) if key is not None else None
            if key == 'custom' or not isinstance(metadata, dict) or field not in metadata:
                continue
            if field not in record['headers']:
                continue
            rendered = _clean_cell(record['row'].get(field, '')).replace(',', '')
            expected = _clean_cell(str(metadata[field])).replace(',', '')
            if rendered != expected:
                mismatches.append(f"{key}: '{rendered}' != '{expected}'")
        add(not mismatches, check, '; '.join(mismatches))

    marked = [record['key'] for record in row_records if '(default)' in record['row'].get('profile', '')]
    add(
        sorted(filter(None, marked)) == sorted(defaults) and len(marked) == len(defaults),
        'Profiles default is marked',
        f'expected exactly {defaults}, got: {marked}',
    )
    first_table_offset = min((table['offset'] for table in tables), default=len(section))
    intro = section[:first_table_offset]
    absent = [key for key in defaults if not re.search(rf'(?<![\w.-]){re.escape(key)}(?![\w.-])', intro)]
    add(
        bool(defaults) and not absent,
        'Profiles default appears in intro',
        f'default key(s) {absent or defaults} not found before first table',
    )
    missing_titles = []
    intro_ws = _collapse_ws(intro)
    for key in defaults:
        metadata = profiles.get(key)
        title = metadata.get('title') if isinstance(metadata, dict) else None
        if title and f'**{_collapse_ws(title)}**' not in intro_ws:
            missing_titles.append(title)
    if missing_titles:
        add(
            False,
            'Profiles default title appears in intro',
            f'default title(s) {missing_titles} not found before first table',
        )
    else:
        add(True, 'Profiles default title appears in intro')

    if large:
        visible_rows = visible[0]['rows'] if len(visible) == 1 else []
        visible_keys = [resolve_profile_row(row, profiles) for row in visible_rows]
        add(
            len(visible_rows) <= 6,
            'Profiles visible row count',
            f'{len(visible_rows)} visible rows; at most 6 allowed',
        )
        add(
            bool(visible_keys) and visible_keys[0] == default,
            'Profiles default is visible and first',
            f"expected '{default}' first, got: {visible_keys[:1]}",
        )
        hidden_defaults = sorted(set(defaults) - set(visible_keys))
        add(
            not hidden_defaults,
            'Profiles defaults are all visible',
            f'declared default(s) {hidden_defaults} are collapsed',
        )

        forced_collapsed = {
            key
            for key, metadata in profiles.items()
            if key == 'custom' or (isinstance(metadata, dict) and metadata.get('deprecated'))
        }
        misplaced = sorted(
            record['key'] for record in row_records if record['key'] in forced_collapsed and not record['collapsed']
        )
        add(
            not misplaced,
            'Profiles custom/deprecated rows collapsed',
            f'visible: {misplaced}',
        )
        bad_defaults = sorted(set(defaults) & forced_collapsed)
        add(
            not bad_defaults,
            'Profiles default metadata is compatible with large layout',
            f'default(s) {bad_defaults} are custom or deprecated',
        )

        hidden_rows = collapsed[0]['rows'] if len(collapsed) == 1 else []
        summaries = re.findall(r'^<summary><strong>View (\d+) more models</strong></summary>\s*$', section, re.M)
        hidden_count_ok = len(summaries) == 1 and int(summaries[0]) == len(hidden_rows)
        add(
            hidden_count_ok,
            'Profiles hidden row count',
            f'summary: {summaries[0] if len(summaries) == 1 else "(invalid)"}; hidden rows: {len(hidden_rows)}',
        )
        details_text = ''
        if len(details_start) == len(details_end) == 1:
            details_text = section[details_start[0].start() : details_end[0].end()]
        blank_lines_ok = bool(
            re.search(r'</summary>\n[ \t]*\n\|', details_text)
            and re.search(r'\|[^\n]*\|\n[ \t]*\n</details>', details_text)
        )
        add(
            blank_lines_ok,
            'Profiles details blank lines',
            'a blank line is required after </summary> and before </details>',
        )

    return results


def required_sections(svc):
    # 'Example pipelines' is PARKED: still allowed in its slot, no longer
    # required. Restore it here and un-park the bundle checks below together.
    req = {'What it does', 'Configuration'}
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


def _collapse_ws(value: str) -> str:
    """Collapse whitespace runs so prose need not reproduce dropdown padding.

    Profile titles are padded to align in the configuration panel's dropdown
    ('Text Small   - ...', 'Text Large   - ...', 'Text Ada     - ...'). That
    alignment is deliberate and belongs in services.json, but a README should
    write the title as an ordinary sentence, so runs of whitespace compare
    equal to a single space on both sides.
    """
    return re.sub(r'\s+', ' ', value).strip()


def _clean_cell(c: str) -> str:
    """Strip markdown decoration from a table cell without eating identifiers.

    Underscores cannot be removed wholesale: they are markdown emphasis, but
    they are also legal in the names this function exists to compare. Lane
    `_source`, profile `gemini-2_5-flash` and connection `streamable_http` all
    lose characters under a blanket strip and then fail to match the metadata
    that declared them. Emphasis is therefore only removed when a pair of
    underscores wraps the whole cell.
    """
    c = c.replace('`', '').replace('*', '')
    c = re.sub(r'\s*_?\(default\)_?\s*', '', c).strip()
    return re.sub(r'^_(.+?)_$', r'\1', c).strip()


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
        cells = [_clean_cell(c) for c in row.group(1).split('|')]
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
    results.extend(profile_results(svc, hand))

    # -- Example pipelines (parked section): >=1 flow when present --
    if 'Example pipelines' in seen:
        body = re.search(r'^## Example pipelines.*?$(.*?)(?=^## |\Z)', hand, re.M | re.S)
        section = body.group(1) if body else ''
        add(
            'PASS' if '→' in section else 'FAIL',
            'Example pipelines has >=1 flow',
            'no `a → b` pipeline shape found',
        )

    # -- PARKED: shipped-example bundle (example.pipe + example.png) --
    # Un-park together with the `## Example pipelines` block in
    # docs/development/node-readme-schema.md. Restore by uncommenting inside
    # the `if 'Example pipelines' in seen:` block above.
    #
    #     # The trigger is a REFERENCE, not a loose file: a referenced file
    #     # that is missing renders a broken page and fails, while an
    #     # unreferenced file harms no reader and lets the bundle be
    #     # assembled in stages (author the .pipe now, screenshot it later).
    #     # Referencing either half obliges the other, so a README never
    #     # ships with only part of the bundle visible.
    #     pipe_file = (node_dir / 'example.pipe').exists()
    #     png_file = (node_dir / 'example.png').exists()
    #     # Both the markdown form — ![alt](example.png) — and the HTML form
    #     # used for centred/sized embeds are accepted; `images` collects the
    #     # alt text of each so the alt-text check works either way.
    #     images = re.findall(r'!\[([^\]]*)\]\((?:\./)?example\.png\)', section)
    #     for tag in re.findall(r'<img\b[^>]*>', section):
    #         if re.search(r'src=["\'](?:\./)?example\.png["\']', tag):
    #             alt = re.search(r'alt=["\']([^"\']*)["\']', tag)
    #             images.append(alt.group(1) if alt else '')
    #     pipe_links = re.findall(r'\]\((?:\./)?example\.pipe\)', section) + re.findall(
    #         r'href=["\'](?:\./)?example\.pipe["\']', section
    #     )
    #     if images or pipe_links:
    #         add(
    #             'PASS' if images else 'FAIL',
    #             'shipped example: screenshot embed (example.png)',
    #             '' if images else 'referenced bundle must show the screenshot',
    #         )
    #         add(
    #             'PASS' if pipe_links else 'FAIL',
    #             'shipped example: download link (example.pipe)',
    #             '' if pipe_links else 'referenced bundle must offer the .pipe',
    #         )
    #         if images:
    #             add(
    #                 'PASS' if png_file else 'FAIL',
    #                 'shipped example: example.png exists',
    #                 'referenced but not in the node directory',
    #             )
    #             add('PASS' if images[0].strip() else 'FAIL', 'shipped example: screenshot has alt text')
    #         if pipe_links:
    #             add(
    #                 'PASS' if pipe_file else 'FAIL',
    #                 'shipped example: example.pipe exists',
    #                 'referenced but not in the node directory',
    #             )
    #     elif pipe_file or png_file:
    #         have = ' + '.join(n for n, ok in (('example.pipe', pipe_file), ('example.png', png_file)) if ok)
    #         add(
    #             'WARN', 'shipped example bundle', f'{have} present but not referenced — embed it once both halves exist'
    #         )
    #     else:
    #         add('WARN', 'shipped example bundle', 'no example.pipe/example.png yet (required for new nodes)')

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
        print('\nSchema: docs/development/nodes/readme-schema.md')
    sys.exit(1 if any_fail else 0)


if __name__ == '__main__':
    main()
