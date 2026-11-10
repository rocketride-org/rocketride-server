# Copyright 2026 Aparavi Software AG. MIT License.
"""Credential catalog + per-caller readiness for the integrations surface.

The catalog is derived from the service definitions the engine already hands
us: a property carrying an "env" member declares which account variable
supplies it, and "secret" marks it as a credential rather than a plain
setting. There is no second source of truth to keep in sync — the node's own
services.json is the only place a credential is described.

Exact suggested-name match => configured. A boundary-aware token match (an
underscore-separated part of the env-var name starting with a node token) only
*surfaces* candidates for the agent to confirm — it never confers readiness.
An env-keys read failure yields 'unconfirmed' for everything, never
'available': a read error must not look like "nothing is set up".
"""

import logging
import re
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)
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
    # False: list the node without auto-wiring secrets (it runs with authType none).
    wire: bool = True


def _walk_properties(properties: Any, out: List[CredField]) -> None:
    """Collect every `env`-carrying property, however deeply it is nested.

    A credential is not always a plain top-level property: it can sit inside
    an enum branch (one auth mode needs a token, another does not), inside a
    group, or be the item of an array. Walking every shape means a node's
    credentials are found wherever the author put them, instead of only in
    the places a flat scan would look.
    """
    if not isinstance(properties, list):
        return
    for prop in properties:
        if not isinstance(prop, dict):
            continue

        env = prop.get('env')
        name = prop.get('name')
        path = prop.get('path')
        # The engine stamps every leaf with a string path and env name; a
        # leaf that does not is left out rather than allowed to break the
        # whole listing later (nest_wiring splits the path). Groups and
        # branches carry no env and are still walked below.
        well_typed = isinstance(env, str) and isinstance(name, str) and (path is None or isinstance(path, str))
        if env and name and well_typed:
            # The schema stamps every leaf with its resolved `path`
            # (`cloud.apikey` for a leaf inside the `cloud` branch); that is
            # where the resolver reads the value, so that is what a caller
            # wiring the credential must set. The bare name is only right for
            # a top-level leaf, so it is the fallback, not the rule.
            out.append(
                CredField(
                    path=path or name,
                    title=prop.get('title') or name,
                    kind='secret' if prop.get('secret') else 'text',
                    required=bool(prop.get('required', True)),
                    suggests=env,
                )
            )

        # An object-form enum keys its branches by value; each branch may
        # expose its own properties.
        branches = prop.get('enum')
        if isinstance(branches, dict):
            for branch in branches.values():
                if isinstance(branch, dict):
                    _walk_properties(branch.get('properties'), out)

        _walk_properties(prop.get('properties'), out)
        item = prop.get('item')
        if isinstance(item, dict):
            _walk_properties([item], out)


def catalog_from_definitions(definitions: Any) -> Dict[str, Integration]:
    """Build the credential catalog from `getServices` definitions.

    Only nodes that actually declare a credential appear: a node with no
    `env` property needs no setup, so listing it as an "integration" would be
    noise.
    """
    out: Dict[str, Integration] = {}
    if not isinstance(definitions, dict):
        return out
    for name, definition in definitions.items():
        if not isinstance(definition, dict):
            continue
        fields: List[CredField] = []
        _walk_properties(definition.get('properties'), fields)
        if not fields:
            continue
        out[name] = Integration(
            name=name,
            title=definition.get('title') or name,
            docs=definition.get('documentation') or '',
            fields=tuple(fields),
        )
    return out


def nest_wiring(flat: Dict[str, str]) -> Dict[str, Any]:
    """Materialise ``{path: placeholder}`` into the nested config tree the path addresses.

    A credential's ``path`` is where the resolver reads it AND where the
    engine's encrypt walk (``findNested`` from the component ``config``
    root, by resolved path, into ``secureParameters``) looks for it.
    Neither walk accepts the dotted path as one flat key: the resolver
    rejects it, and the encrypt walk descends object by object, so a flat
    ``cloud.apikey`` would never be lifted and would ride back out of
    ``rrext_validate`` - and into the stored pipeline - with its expanded
    secret in plaintext. So the wiring handed to a caller is already the
    nested tree; copying it into the component ``config`` puts every value
    where both walks find it. A top-level path is unchanged by this.

    Raises:
        ValueError: Two paths claim the same key as both a leaf and a group.
    """
    out: Dict[str, Any] = {}
    for path, value in flat.items():
        parts = path.split('.')
        node = out
        for part in parts[:-1]:
            child = node.setdefault(part, {})
            if not isinstance(child, dict):
                raise ValueError(f'credential path {path!r} nests under a leaf')
            node = child
        if isinstance(node.get(parts[-1]), dict):
            raise ValueError(f'credential path {path!r} is also a group')
        node[parts[-1]] = value
    return out


def node_tokens(name: str) -> frozenset:
    parts = [p.upper() for p in name.split('_') if p not in _GENERIC_TOKENS and len(p) > 2]
    return frozenset(parts) if parts else frozenset({name.upper()})


def evaluate(spec: Integration, env_keys: Optional[List[str]]) -> dict:
    if not spec.wire:
        # Optional-auth nodes must stay listed and must not emit a secret-only
        # wiring dict (that would recreate #2495: authToken with authType none).
        return {
            'status': 'configured',
            'env_error': False,
            'missing': [],
            'candidates': [],
            'wiring': None,
        }
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
        flat = {f.path: '${' + f.suggests + '}' for f in spec.fields if f.required or f.suggests in have}
        try:
            wiring = nest_wiring(flat)
        except ValueError as exc:
            # A definition declaring a credential on both a group and its child
            # cannot be wired as one tree. Report the node unconfirmed instead of
            # failing the whole listing, so every other node stays discoverable.
            logger.warning('%s: credential paths collide, wiring withheld: %s', spec.name, exc)
            # candidates are VARIABLE names a caller may bind; a definition
            # defect is reported on its own key, never as a binding proposal
            return {
                'status': 'unconfirmed',
                'env_error': False,
                'missing': [],
                'candidates': [],
                'wiring': None,
                'definition_error': f'credential paths collide in the node definition: {exc}',
            }
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
    if state.get('definition_error'):
        # The defect is in the node definition, not in the caller's variables;
        # say so beside the setup block so nobody chases variables they have set
        result['definition_error'] = state['definition_error']
    return result
