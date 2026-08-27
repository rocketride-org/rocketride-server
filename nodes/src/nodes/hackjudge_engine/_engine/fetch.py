"""GitHub fetch + repo helpers for the Hack Judge engine.

Vendored (minimal, stdlib-only) from the hackathon-usage-verifier run_batch.py so
the node has NO openpyxl / rocketride-client dependency. engine.py's lazy
`import run_batch as rb` is redirected here (see the two patched lines in
_engine/engine.py); it only needs parse_repo + OTHER_PLATFORMS. IInstance also
uses _gh / repo_missing / github_token. GH_TOKEN is seeded by IGlobal.beginGlobal.
"""

import os
import re
import time
import urllib.error
import urllib.request
from pathlib import Path

# Seeded at runtime by IGlobal.beginGlobal (from node config / env). _gh reads it.
GH_TOKEN = None

MISSING = {'', 'na', 'n/a', 'none', 'nil', '-', 'tbd'}

# Other major platforms - engine uses this to judge whether the target is the sole
# backbone (Yes) or sits alongside another platform (Partial). Kept identical to
# run_batch.OTHER_PLATFORMS.
OTHER_PLATFORMS = [
    'butterbase',
    'supabase',
    'xtrace',
    'photon',
    'langchain',
    'crewai',
    'firebase',
    'pinecone',
    'weaviate',
]


def _norm(s: str) -> str:
    return (s or '').strip().lower()


def repo_missing(url: str) -> bool:
    return _norm(url) in {_norm(m) for m in MISSING} or 'github.com' not in url.lower()


def github_token() -> str:
    t = os.environ.get('ROCKETRIDE_GITHUB_TOKEN')
    if t and not t.startswith('PASTE'):
        return t
    envf = Path('.env')
    if envf.exists():
        for line in envf.read_text(encoding='utf-8-sig').splitlines():
            if line.strip().startswith('ROCKETRIDE_GITHUB_TOKEN='):
                v = line.split('=', 1)[1].strip()
                if v and not v.startswith('PASTE'):
                    return v
    return None


def _gh(url: str, retries: int = 2) -> tuple:
    headers = {'User-Agent': 'rr-verifier', 'Accept': 'application/vnd.github+json'}
    if GH_TOKEN:
        headers['Authorization'] = f'Bearer {GH_TOKEN}'
    for attempt in range(retries + 1):
        req = urllib.request.Request(url, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.status, r.read().decode('utf-8', 'replace')
        except urllib.error.HTTPError as e:
            if e.code in (403, 429, 500, 502, 503) and attempt < retries:
                time.sleep(1.5 * (attempt + 1))
                continue
            return e.code, ''
        except Exception:
            if attempt < retries:
                time.sleep(1.0)
                continue
            return None, ''
    return None, ''


def parse_repo(url: str):
    m = re.search(r'github\.com[/:]+([^/\s]+)/([^/\s#?]+)', url, re.I)
    return (m.group(1), m.group(2).removesuffix('.git')) if m else None
