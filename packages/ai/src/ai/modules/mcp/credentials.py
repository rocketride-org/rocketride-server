# Copyright 2026 Aparavi Software AG. MIT License.
"""Credential catalog + per-caller readiness for the integrations surface.

The catalog (credentials.json, sibling file) describes the config *fields*
credentialed nodes need; ROCKETRIDE_* names are curated *suggestions*.
Exact suggested-name match => configured. A boundary-aware token match (an
underscore-separated part of the env-var name starting with a node token) only
*surfaces* candidates for the agent to confirm — it never confers readiness.
An env-keys read failure yields 'unconfirmed' for everything, never
'available': a read error must not look like "nothing is set up".

A field may declare `required_for_profiles`: it is then required only when
the node runs one of those profiles. A node whose only gaps are such fields
reports 'partial' -- usable on its other profiles right now, with the
variable still listed as missing for the named ones -- instead of hiding a
keyless profile behind a flat "not configured".
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
    required_for_profiles: tuple = ()  # empty: required on every profile


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
                required_for_profiles=tuple(str(p) for p in (f.get('required_for_profiles') or []) if p),
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


def _conditional_block(fields: List[CredField], have: Optional[set]) -> list:
    """Describe profile-conditional fields for the caller; `have` is None when the env read failed."""
    return [
        {
            'variable': f.suggests,
            'path': f.path,
            'required_for_profiles': list(f.required_for_profiles),
            'configured': (f.suggests in have) if have is not None else None,
        }
        for f in fields
    ]


def evaluate(spec: Integration, env_keys: Optional[List[str]]) -> dict:
    required = [f for f in spec.fields if f.required]
    conditional = [f for f in required if f.required_for_profiles]
    if env_keys is None:
        return {
            'status': 'unconfirmed',
            'env_error': True,
            'missing': [f.suggests for f in required],
            'candidates': [],
            'wiring': None,
            'conditional': _conditional_block(conditional, None),
        }
    have = set(env_keys)
    absent = [f for f in required if f.suggests not in have]
    missing = [f.suggests for f in absent]
    # Gaps only in profile-conditional fields leave the node usable on every
    # other profile: that is 'partial', never a flat "not configured".
    if not absent or all(f.required_for_profiles for f in absent):
        wiring = {
            f.path: '${' + f.suggests + '}'
            for f in spec.fields
            if f.suggests in have or (f.required and not f.required_for_profiles)
        }
        return {
            'status': 'partial' if absent else 'configured',
            'env_error': False,
            'missing': missing,
            'candidates': [],
            'wiring': wiring,
            'conditional': _conditional_block(conditional, have),
        }
    tokens = node_tokens(spec.name)
    # Match on name *parts*, not raw substrings: a part must start with the
    # token, so GITHUB_TOKEN and GIT_PAT match tool_git's GIT while
    # DIGITALOCEAN_TOKEN does not. A wrong candidate is worse than none —
    # the model is told to propose a binding from these.
    candidates = sorted(
        k for k in have if any(p.startswith(t) for t in tokens for p in re.split(r'[^A-Z0-9]+', k.upper()))
    )
    status = 'unconfirmed' if candidates else 'available'
    return {
        'status': status,
        'env_error': False,
        'missing': missing,
        'candidates': candidates,
        'wiring': None,
        'conditional': _conditional_block(conditional, have),
    }


async def fetch_env_keys(client) -> Optional[List[str]]:
    """The caller's merged variable *names* (never values); None on any failure."""
    try:
        keys = await client.get_environment_keys()
        return list(keys) if keys is not None else None
    except Exception as exc:  # noqa: BLE001 - any failure means "unknown", not "empty"
        logger.warning('get_environment_keys failed; readiness degrades to unconfirmed: %s', exc)
        return None


def setup_block(spec: Integration, variables: Optional[List[str]] = None) -> dict:
    """Setup instructions for the caller; `variables` narrows the list (default: every required field)."""
    return {
        'variables': list(variables) if variables is not None else [f.suggests for f in spec.fields if f.required],
        'how': SETUP_HOW,
        'docs': spec.docs,
    }


def describe_state(spec: Integration, state: dict) -> dict:
    """Shape an `evaluate()` state into the caller-facing readiness block
    shared by every credential-aware tool result: `status`/`missing`/
    `candidates` plus exactly one of `wiring` (configured) or `setup`
    (not yet configured, including 'partial') -- never both, so a caller can
    branch on which key is present rather than parsing `status` themselves.
    `conditional` rides along only for fields declaring
    `required_for_profiles`: which profiles need each variable, and whether
    it is set.
    """
    result = {
        'status': state['status'],
        'missing': state['missing'],
        'candidates': state['candidates'],
    }
    if state.get('conditional'):
        result['conditional'] = state['conditional']
    if state['status'] == 'configured':
        result['wiring'] = state['wiring']
    elif state['status'] == 'partial':
        # Only profile-conditional variables are missing: name just those.
        result['setup'] = setup_block(spec, state['missing'])
    else:
        result['setup'] = setup_block(spec)
    return result
