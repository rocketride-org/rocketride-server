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
"""Fetch ONE RocketRide documentation page (deep-docs layer).

CONSTRAINT (agent contract / future MCP tool description): fetch exactly ONE page; NEVER
llms-full.txt (~257K tokens — it blows the context window), by any method, even if the user asks
for "all the docs". Topic lookups resolve ONLY through the bundled doc-map — do not invent paths
or hosts; an explicit /path.md argument is fetched as-given (and may 404 if it is not in the map).

The token-economical pattern: the resident doc-map (llms.txt) lists ~156 pages; this tool
resolves a topic to the single relevant page and fetches only that. It will NEVER fetch
llms-full.txt (~257K tokens) and caps any response so the context window is safe.

Usage:
  python3 fetch-doc.py "<topic>"        # e.g. "llm_openai", "use method", "error handling"
  python3 fetch-doc.py /nodes/llm_openai.md   # explicit path (fetched as-given; may 404 if unmapped)
  python3 fetch-doc.py --list "<topic>"       # just list matching pages, don't fetch

Live-first (fetches the fresh page from docs.rocketride.org); on no-network / non-200 it falls
back to the mapped bundled snapshot and tells you which file to read. Topic lookups resolve URLs
from the bundled doc-map only — the tool does not invent paths. An explicit /path.md argument is
the exception: it is fetched as-given even when unmapped, and an unmapped path may simply 404
(e.g. /develop/use.md is a 404; the real path is /develop/typescript/methods/use.md).
"""

import sys
import os
import re
import json
import urllib.request
import urllib.error

BASE = 'https://docs.rocketride.org'
SIZE_CAP = 80_000  # bytes; a single doc page is ~1.5-8KB. Truncate anything larger.
TIMEOUT = 20

LINK_RE = re.compile(r'\-\s*\[(.+?)\]\((/[^)]+\.md)\)')


def find_doc_map():
    """Locate ROCKETRIDE_DOC_MAP.md: the skill dir first (its canonical home — the docs
    exporter owns .rocketride/docs/ and deletes files it didn't export), then the legacy
    .rocketride/docs/ locations relative to this script, else walk up from cwd.
    """
    here = os.path.dirname(os.path.abspath(__file__))
    for cand in (
        os.path.normpath(os.path.join(here, '..', 'ROCKETRIDE_DOC_MAP.md')),
        os.path.normpath(os.path.join(here, '..', '..', '..', '.rocketride', 'docs', 'ROCKETRIDE_DOC_MAP.md')),
    ):
        if os.path.isfile(cand):
            return cand
    d = os.getcwd()
    for _ in range(8):
        c = os.path.join(d, '.rocketride', 'docs', 'ROCKETRIDE_DOC_MAP.md')
        if os.path.isfile(c):
            return c
        parent = os.path.dirname(d)
        if parent == d:
            break
        d = parent
    return None


def bundled_docs_dir(map_path):
    """The .rocketride/docs snapshot dir (pages/, ../schema, ROCKETRIDE_*.md). The map may
    live in the skill dir instead, so resolve this independently of the map's location.
    """
    if map_path:
        d = os.path.dirname(map_path)
        if os.path.basename(os.path.dirname(d)) == '.rocketride':
            return d
    here = os.path.dirname(os.path.abspath(__file__))
    cand = os.path.normpath(os.path.join(here, '..', '..', '..', '.rocketride', 'docs'))
    if os.path.isdir(cand):
        return cand
    d = os.getcwd()
    for _ in range(8):
        c = os.path.join(d, '.rocketride', 'docs')
        if os.path.isdir(c):
            return c
        parent = os.path.dirname(d)
        if parent == d:
            break
        d = parent
    return None


def load_map():
    mp = find_doc_map()
    if not mp:
        return [], None
    try:
        text = open(mp).read()
    except OSError as e:
        sys.stderr.write(f'[fetch-doc] doc-map unreadable ({mp}: {e})\n')
        sys.stderr.write(
            'ERROR_JSON: '
            + json.dumps(
                {
                    'code': 'DOC_MAP_UNREADABLE',
                    'retriable': False,
                    'fallback': 'read the bundled .rocketride/docs/ROCKETRIDE_*.md snapshots instead',
                }
            )
            + '\n'
        )
        return [], None
    links = [(t.strip(), p.strip()) for t, p in LINK_RE.findall(text)]
    return links, mp


def resolve(arg, links):
    """Return (title, path) best match, or a list of candidates if ambiguous, or None."""
    arg = arg.strip()
    if arg.startswith('/') and arg.endswith('.md'):
        for t, p in links:
            if p == arg:
                return (t, p)
        return ('(explicit)', arg)  # allow, but it may 404
    # keyword match against title + path basename
    terms = [w for w in re.split(r'[^a-z0-9]+', arg.lower()) if w]
    scored = []
    for t, p in links:
        hay = (t + ' ' + p).lower()
        base = os.path.basename(p)[:-3].lower()
        score = sum(1 for w in terms if w in hay)
        if base in arg.lower().replace(' ', '_') or arg.lower().replace(' ', '_') in base:
            score += 2
        if score:
            scored.append((score, t, p))
    if not scored:
        return None
    scored.sort(key=lambda x: -x[0])
    top = scored[0][0]
    best = [(t, p) for s, t, p in scored if s == top]
    return best[0] if len(best) == 1 else [('AMBIGUOUS', None)] + [(t, p) for s, t, p in scored[:6]]


def offline_fallback(path, docs_dir):
    """Map a doc path to the bundled file the agent should read instead, in order:
    (1) the refreshed verbatim page under pages/, (2) a node's bundled schema,
    (3) a legacy condensed snapshot.
    """
    if not docs_dir:
        return None
    # 1. refreshed bundled page (fresh snapshot, structure preserved)
    page = os.path.join(docs_dir, 'pages', path.lstrip('/'))
    if os.path.isfile(page):
        return page
    # 2. node page -> the bundled config schema
    if path.startswith('/nodes/'):
        node = os.path.basename(path)[:-3].split('/')[-1]
        schema = os.path.normpath(os.path.join(docs_dir, '..', 'schema', node + '.json'))
        if os.path.isfile(schema):
            return schema
    # 3. legacy condensed snapshots
    table = {
        '/develop/python': 'ROCKETRIDE_python_API.md',
        '/develop/typescript': 'ROCKETRIDE_typescript_API.md',
        '/develop': 'ROCKETRIDE_python_API.md',
        'best-practices': 'ROCKETRIDE_COMMON_MISTAKES.md',
        'error-handling': 'ROCKETRIDE_COMMON_MISTAKES.md',
        'observability': 'ROCKETRIDE_OBSERVABILITY.md',
        '/concepts': 'ROCKETRIDE_PIPELINE_RULES.md',
        'pipeline-reference': 'ROCKETRIDE_PIPELINE_RULES.md',
        '/quickstart': 'ROCKETRIDE_QUICKSTART.md',
        '/examples': 'ROCKETRIDE_QUICKSTART.md',
    }
    for key, fname in table.items():
        if key in path:
            c = os.path.join(docs_dir, fname)
            if os.path.isfile(c):
                return c
    return None


def fetch(path):
    url = BASE + path
    req = urllib.request.Request(url, headers={'User-Agent': 'rocketride-skills-fetch-doc/1.0'})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        if r.status != 200:
            raise urllib.error.HTTPError(url, r.status, 'non-200', r.headers, None)
        data = r.read(SIZE_CAP + 1)
    truncated = len(data) > SIZE_CAP
    return data[:SIZE_CAP].decode('utf-8', 'replace'), truncated, url


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    list_only = '--list' in sys.argv
    if not args:
        sys.stderr.write(__doc__)
        sys.exit(2)
    arg = ' '.join(args)

    # Hard guard: never the monolith.
    if 'llms-full' in arg.lower():
        sys.stderr.write(
            '[fetch-doc] REFUSED: llms-full.txt is ~257K tokens and will blow the '
            'context window. Fetch the single relevant page instead (see the doc-map).\n'
        )
        sys.stderr.write(
            'ERROR_JSON: '
            + json.dumps(
                {
                    'code': 'MONOLITH_REFUSED',
                    'retriable': False,
                    'fallback': 'find the ONE relevant page in the doc-map and fetch only that',
                }
            )
            + '\n'
        )
        sys.exit(2)

    links, map_path = load_map()
    docs_dir = bundled_docs_dir(map_path)
    if not links:
        sys.stderr.write(
            '[fetch-doc] doc-map not found (ROCKETRIDE_DOC_MAP.md in the '
            'rocketride-building-pipelines skill dir, or .rocketride/docs/). '
            'Read the bundled .rocketride/docs/ROCKETRIDE_*.md snapshots instead.\n'
        )
        sys.exit(1)

    res = resolve(arg, links)
    if res is None:
        sys.stderr.write(f'[fetch-doc] no page matches {arg!r}. Browse the map: {map_path}\n')
        sys.exit(1)
    if isinstance(res, list):  # ambiguous
        sys.stderr.write(f'[fetch-doc] {arg!r} is ambiguous — pick one and pass its /path.md:\n')
        for t, p in res[1:]:
            sys.stderr.write(f'    {p}   ({t})\n')
        sys.exit(1)

    title, path = res
    if list_only:
        print(f'{path}   ({title})')
        return

    try:
        body, truncated, url = fetch(path)
        sys.stderr.write(f'[fetch-doc] source: {url}  ({title})\n')
        print(body)
        if truncated:
            sys.stderr.write(
                f'\n[fetch-doc] NOTE: page exceeded {SIZE_CAP} bytes and was truncated. '
                f'Read the rest at {url} if needed.\n'
            )
    except Exception as e:
        sys.stderr.write(f'[fetch-doc] live fetch failed ({e}); falling back to bundled snapshot.\n')
        sys.stderr.write(
            'ERROR_JSON: '
            + json.dumps(
                {
                    'code': 'PAGE_FETCH_FAILED',
                    'retriable': False,
                    'fallback': 'use the bundled snapshot below (do NOT retry the URL or fetch the monolith)',
                }
            )
            + '\n'
        )
        fb = offline_fallback(path, docs_dir)
        if fb:
            sys.stderr.write(f'[fetch-doc] OFFLINE FALLBACK — read this bundled file: {fb}\n')
            try:
                print(open(fb).read())
            except OSError as read_err:
                sys.stderr.write(f'[fetch-doc] bundled fallback unreadable ({fb}: {read_err})\n')
                sys.stderr.write(
                    'ERROR_JSON: '
                    + json.dumps(
                        {
                            'code': 'FALLBACK_UNREADABLE',
                            'retriable': False,
                            'fallback': 'read the doc-map / the bundled .rocketride/docs/ROCKETRIDE_*.md directly',
                        }
                    )
                    + '\n'
                )
                sys.exit(1)
        else:
            sys.stderr.write(
                f'[fetch-doc] no bundled fallback for {path}. Read the doc-map / '
                f'the bundled .rocketride/docs/ROCKETRIDE_*.md.\n'
            )
            sys.exit(1)


if __name__ == '__main__':
    main()
