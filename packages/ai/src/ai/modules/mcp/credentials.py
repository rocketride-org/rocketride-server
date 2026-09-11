# Copyright 2026 Aparavi Software AG. MIT License.
"""Credential catalog + per-caller readiness for the integrations surface.

The catalog (credentials.json, sibling file) describes the config *fields*
credentialed nodes need; ROCKETRIDE_* names are curated *suggestions*.
Exact suggested-name match => configured. A boundary-aware token match (an
underscore-separated part of the env-var name starting with a node token) only
*surfaces* candidates for the agent to confirm — it never confers readiness.
An env-keys read failure yields 'unconfirmed' for everything, never
'available': a read error must not look like "nothing is set up".
"""

import json
import logging
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional

logger = logging.getLogger(__name__)

_CATALOG_PATH = Path(__file__).parent / 'credentials.json'
_GENERIC_TOKENS = frozenset(
    {
        'store',
        'tool',
        'db',
        'graph',
        'llm',
        'embedding',
        'memory',
        'search',
        'rerank',
        'vision',
        'cloud',
        'api',
        'agent',
        'eval',
    }
)

SETUP_HOW = (
    'Set these variables in RocketRide: VS Code extension -> RocketRide: '
    'Settings -> Variables, or https://app.rocketride.ai/settings/variables. '
    'Then re-run list_integrations - the node becomes usable immediately.'
)


@dataclass(frozen=True)
class CredField:
    path: str
    title: str
    kind: str  # 'secret' | 'endpoint' | 'identifier' | 'text'
    required: bool
    suggests: str
    review: bool = False


@dataclass(frozen=True)
class Integration:
    name: str
    title: str
    docs: str
    fields: tuple


def catalog_from_dict(raw: dict) -> Dict[str, Integration]:
    out: Dict[str, Integration] = {}
    for name, entry in raw.items():
        if not isinstance(entry, dict):
            continue
        fields = tuple(
            CredField(
                path=f['path'],
                title=f.get('title', f['path']),
                kind=f.get('kind', 'secret'),
                required=bool(f.get('required', True)),
                suggests=f['suggests'],
                review=bool(f.get('review', False)),
            )
            for f in entry.get('fields', [])
            if isinstance(f, dict) and f.get('path') and f.get('suggests')
        )
        out[name] = Integration(
            name=name,
            title=entry.get('title', name),
            docs=entry.get('docs', ''),
            fields=fields,
        )
    return out


_cache: Optional[Dict[str, Integration]] = None


def load_catalog(path: Optional[Path] = None) -> Dict[str, Integration]:
    global _cache
    if path is not None:  # test seam - never cached
        return catalog_from_dict(json.loads(path.read_text(encoding='utf-8')))
    if _cache is None:
        try:
            _cache = catalog_from_dict(json.loads(_CATALOG_PATH.read_text(encoding='utf-8')))
        except (OSError, ValueError) as exc:
            # A broken catalog must not take down the tool surface - degrade
            # to "no credentialed nodes known" and log loudly.
            logger.error('credentials.json unreadable: %s', exc)
            _cache = {}
    return _cache


def node_tokens(name: str) -> frozenset:
    parts = [p.upper() for p in name.split('_') if p not in _GENERIC_TOKENS and len(p) > 2]
    return frozenset(parts) if parts else frozenset({name.upper()})


def evaluate(spec: Integration, env_keys: Optional[List[str]]) -> dict:
    required = [f for f in spec.fields if f.required]
    if env_keys is None:
        return {
            'status': 'unconfirmed',
            'env_error': True,
            'missing': [f.suggests for f in required],
            'candidates': [],
            'wiring': None,
        }
    have = set(env_keys)
    missing = [f.suggests for f in required if f.suggests not in have]
    if not missing:
        wiring = {f.path: '${' + f.suggests + '}' for f in spec.fields if f.required or f.suggests in have}
        return {'status': 'configured', 'env_error': False, 'missing': [], 'candidates': [], 'wiring': wiring}
    tokens = node_tokens(spec.name)
    # Match on name *parts*, not raw substrings: a part must start with the
    # token, so GITHUB_TOKEN and GIT_PAT match tool_git's GIT while
    # DIGITALOCEAN_TOKEN does not. A wrong candidate is worse than none —
    # the model is told to propose a binding from these.
    candidates = sorted(
        k for k in have if any(p.startswith(t) for t in tokens for p in re.split(r'[^A-Z0-9]+', k.upper()))
    )
    status = 'unconfirmed' if candidates else 'available'
    return {'status': status, 'env_error': False, 'missing': missing, 'candidates': candidates, 'wiring': None}


async def fetch_env_keys(client) -> Optional[List[str]]:
    """The caller's merged variable *names* (never values); None on any failure."""
    try:
        keys = await client.get_environment_keys()
        return list(keys) if keys is not None else None
    except Exception as exc:  # noqa: BLE001 - any failure means "unknown", not "empty"
        logger.warning('get_environment_keys failed; readiness degrades to unconfirmed: %s', exc)
        return None


def setup_block(spec: Integration) -> dict:
    return {
        'variables': [f.suggests for f in spec.fields if f.required],
        'how': SETUP_HOW,
        'docs': spec.docs,
    }


def describe_state(spec: Integration, state: dict) -> dict:
    """Shape an `evaluate()` state into the caller-facing readiness block
    shared by every credential-aware tool result: `status`/`missing`/
    `candidates` plus exactly one of `wiring` (configured) or `setup`
    (not yet configured) -- never both, so a caller can branch on which key
    is present rather than parsing `status` themselves.
    """
    result = {
        'status': state['status'],
        'missing': state['missing'],
        'candidates': state['candidates'],
    }
    if state['status'] == 'configured':
        result['wiring'] = state['wiring']
    else:
        result['setup'] = setup_block(spec)
    return result
