# MIT License
#
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

"""
Write the ``legacy`` block into every pre-existing node definition.

Invoke as:  engine tools/legacy_blocks.py [--ref origin/develop] [--write]

Named Pipelines plan 5.6.8: a node definition that existed on ``develop``
before the services.json format switch carries ONE top-level ``legacy``
object that only ``task_convert.py`` reads. It is derived here, once, from
the OLD definition (read from git at ``--ref``) and the NEW one on disk::

    "legacy": {
        "selector":   "<old selector key, e.g. profile>",
        "default":    "<old preconfig.default>",
        "profiles":   { ...old preconfig.profiles verbatim... },
        "dropped":    [ old keys with no leaf in the new schema ],
        "renamed":    { old key: new leaf | {to, values} },   # six nodes
        "credential": { old key: new leaf },                 # oauth grants
        "profileMap": { old profile: new branch }            # two nodes
    }

Steps per file:
    1. Load the new definition (comments tolerated) and the old one from git.
       A node with no old definition is new and gets no block.
    2. Collect the old keys: ``fields`` (minus groups and the selector) and
       every profile's keys except ``title``; prefix-stripped the way the
       old ``getNodeConfig`` saw them (``chunker.chunk_size`` -> ``chunk_size``,
       ``opensearch.auth.enabled`` -> ``auth.enabled``).
    3. Collect the new leaf and selector names, local and shared
       (``core/services.common*.json``), by their short name.
    4. ``dropped`` = old keys the new schema does not declare and no hand
       entry maps. Hand entries (``HAND``) are the verified exceptions from
       ``C:\\tmp\\named-pipes-legacy-map\\SUMMARY.md``; the LLM
       ``custom.model -> customModel`` rename is detected generically.
    5. Insert or replace the block as the LAST member of the file, keeping
       the file's tabs, comments and trailing newline. ``--write`` is
       required to touch disk; without it the script only reports.

The engine, the resolver, the catalog summary and the UI never read the block
(``services_catalog._build`` pops it from the on-demand full entry). It is
deleted in a later minor once no old-shape input is seen.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

# ============================================================================
# Constants
# ============================================================================

NODES_ROOT = Path('nodes/src/nodes')
SERVICES_FILE = re.compile(r'^services[^/\\]*\.json$')
SKIP_DIRS = {'core', '__pycache__'}

# The verified exceptions (every other node is derived). Keys are paths
# relative to NODES_ROOT with forward slashes.
HAND: Dict[str, Dict[str, Any]] = {
    'store_elasticsearch/services.elasticsearch.json': {
        'renamed': {
            'store_mode': {'to': 'mode', 'values': {'true': 'vstore', 'false': 'index'}},
        },
    },
    'store_elasticsearch/services.opensearch.json': {
        'renamed': {
            'auth.enabled': {'to': 'auth', 'values': {'true': 'basic', 'false': 'none'}},
            'auth.username': 'basic.username',
            'auth.password': 'basic.password',
            'mode': {'to': 'mode', 'values': {'true': 'vstore', 'false': 'index'}},
            'dim': 'vstore.dim',
            'score': 'vstore.score',
        },
    },
    'llamaparse/services.json': {
        'renamed': {
            'use_advanced_config': {'to': 'configMode', 'values': {'true': 'advanced', 'false': 'simple'}},
            'parse_mode': {'to': 'parse_mode', 'values': {'cost_effective (LLM)': 'cost_effective'}},
        },
    },
    'audio_transcribe/services.json': {'profileMap': {'default': 'base'}},
    'context_optimizer/services.json': {'profileMap': {'ci_tiny': 'manual'}},
}

# The OAuth grant moved from a token field to an oauth2 property (same value).
for _svc in ('calendar', 'docs', 'drive', 'gmail', 'sheets'):
    HAND[f'tool_google_workspace/services.{_svc}.json'] = {'credential': {'userToken': 'user.userAuth'}}
for _svc in ('excel', 'onedrive', 'outlook_calendar', 'outlook_mail', 'word'):
    HAND[f'tool_microsoft_365/services.{_svc}.json'] = {'credential': {'userToken': 'user.userAuth'}}

# ============================================================================
# JSON with comments
# ============================================================================


def _strip_comments(text: str) -> str:
    """Remove ``//`` comments outside strings, line by line."""
    out: List[str] = []
    for line in text.splitlines():
        quotes = 0
        i = 0
        cut: Optional[int] = None
        while i < len(line):
            ch = line[i]
            if ch == '\\' and quotes % 2 == 1:
                i += 2
                continue
            if ch == '"':
                quotes += 1
            elif ch == '/' and line[i : i + 2] == '//' and quotes % 2 == 0:
                cut = i
                break
            i += 1
        out.append(line if cut is None else line[:cut])
    return '\n'.join(out)


def load_json(text: str) -> Dict[str, Any]:
    """Parse a services.json, tolerating the ``//`` comments the files carry."""
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return json.loads(_strip_comments(text))


# ============================================================================
# Old and new schemas
# ============================================================================


def strip_prefix(key: str) -> str:
    """``chunker.chunk_size`` -> ``chunk_size``; ``opensearch.auth.enabled`` -> ``auth.enabled``."""
    head, _, rest = key.partition('.')
    return rest or head


def old_schema(doc: Dict[str, Any]) -> Tuple[Set[str], Optional[str], Optional[str], Dict[str, Any]]:
    """Return (old keys, selector key, default profile, profiles verbatim)."""
    keys: Set[str] = set()
    pre = doc.get('preconfig') or {}
    profiles = pre.get('profiles') or {}
    fields = doc.get('fields') or {}
    # Members of an array item are not node keys: the old `getNodeConfig`
    # merged top-level and profile keys only, and the item schema is the
    # new definition's business (an `include[].path` must never be dropped).
    array_names = {n for n, f in fields.items() if isinstance(f, dict) and f.get('type') == 'array'}
    item_fields = {n for n in fields if any(n.startswith(a + '.') for a in array_names)}

    def stored_name(name: str) -> str:
        # Fields are usually `<node>.<key>`; a few files (azure, objstore)
        # declare bare keys, where the first segment is itself a field.
        head, _, rest = name.partition('.')
        return rest if rest and head not in fields else name

    for name, field in fields.items():
        if not isinstance(field, dict) or 'object' in field or name in item_fields:
            continue
        # The profile selector itself: the stored key was always `profile`
        # (old getNodeConfig read connConfig['profile']), whatever the field
        # was called. Any other `conditional` field (advanced_mode,
        # show_advanced, tune) is a UI toggle and an ordinary old key.
        enum = field.get('enum')
        if isinstance(enum, list) and any(isinstance(e, str) and e.startswith('*>preconfig') for e in enum):
            continue
        if stored_name(name).split('.')[-1] == 'profile' and profiles:
            continue
        keys.add(stored_name(name))
    for profile in profiles.values():
        if isinstance(profile, dict):
            keys.update(k for k in profile if k != 'title')
    selector = 'profile' if profiles else None
    return keys, selector, pre.get('default'), profiles


def shared_definitions(root: Path) -> Dict[str, Any]:
    """Every ``propertyDefinitions`` entry of ``core/services.common*.json``."""
    shared: Dict[str, Any] = {}
    core = root / NODES_ROOT / 'core'
    for path in sorted(core.glob('services.common*.json')):
        shared.update(load_json(path.read_text(encoding='utf-8')).get('propertyDefinitions') or {})
    return shared


def new_schema(doc: Dict[str, Any], shared: Dict[str, Any]) -> Tuple[Set[str], Set[str]]:
    """Return (leaf short names, selector names) the new definition declares."""
    leaves: Set[str] = set()
    selectors: Set[str] = set()
    defs = dict(shared)
    defs.update(doc.get('propertyDefinitions') or {})

    def add_def(key: str) -> None:
        value = defs.get(key)
        if isinstance(value, dict) and isinstance(value.get('enum'), dict):
            selectors.add(strip_prefix(key).split('.')[-1])
            for branch in value['enum'].values():
                if isinstance(branch, dict):
                    walk(branch.get('properties'))
        else:
            leaves.add(key.split('.')[-1])

    def walk(props: Any) -> None:
        for prop in props or []:
            if isinstance(prop, str):
                add_def(prop)
                continue
            if not isinstance(prop, dict):
                continue
            if 'base' in prop and 'name' not in prop:
                add_def(prop['base'])
                continue
            name = prop.get('name') or (prop['base'].split('.')[-1] if 'base' in prop else None)
            if isinstance(prop.get('enum'), dict):
                if name:
                    selectors.add(name)
                for branch in prop['enum'].values():
                    if isinstance(branch, dict):
                        walk(branch.get('properties'))
            elif name:
                leaves.add(name)
            if isinstance(prop.get('properties'), list):
                walk(prop['properties'])

    walk(doc.get('properties'))
    for key, value in (doc.get('propertyDefinitions') or {}).items():
        if isinstance(value, dict) and isinstance(value.get('enum'), dict):
            selectors.add(key.split('.')[-1])
        else:
            leaves.add(key.split('.')[-1])
    return leaves, selectors


# ============================================================================
# The block
# ============================================================================


def build_block(rel: str, old: Dict[str, Any], new: Dict[str, Any], shared: Dict[str, Any]) -> Dict[str, Any]:
    """Derive one node's ``legacy`` block."""
    old_keys, selector, default, profiles = old_schema(old)
    leaves, selectors = new_schema(new, shared)
    hand = HAND.get(rel, {})
    renamed: Dict[str, Any] = dict(hand.get('renamed', {}))
    credential: Dict[str, str] = dict(hand.get('credential', {}))
    profile_map: Dict[str, str] = dict(hand.get('profileMap', {}))

    # LLM family: the custom profile's `model` became the root leaf `customModel`
    custom = profiles.get('custom')
    if isinstance(custom, dict) and 'model' in custom and 'customModel' in leaves:
        renamed.setdefault('custom.model', 'customModel')

    mapped = (
        set(renamed) | set(credential) | {k.split('.')[-1] for k in renamed} | {k.split('.')[-1] for k in credential}
    )
    dropped = sorted(
        key
        for key in old_keys
        if key not in mapped
        and key.split('.')[-1] not in leaves
        and key.split('.')[-1] not in selectors
        and key not in leaves
    )

    block: Dict[str, Any] = {}
    if selector:
        block['selector'] = selector
    if default is not None:
        block['default'] = default
    block['profiles'] = profiles
    block['dropped'] = dropped
    if renamed:
        block['renamed'] = renamed
    if credential:
        block['credential'] = credential
    if profile_map:
        block['profileMap'] = profile_map
    return block


# ============================================================================
# Text surgery (the files carry comments, so they are never re-serialized)
# ============================================================================


def _find_member(text: str, name: str) -> Optional[Tuple[int, int]]:
    """Span of a top-level ``"name": {...}`` member incl. its leading comma/newline, or None."""
    match = re.search(r',?\s*\n\t"' + re.escape(name) + r'":\s*\{', text)
    if not match:
        return None
    start = match.start()
    i = text.index('{', match.start())
    depth = 0
    in_string = False
    while i < len(text):
        ch = text[i]
        if in_string:
            if ch == '\\':
                i += 2
                continue
            if ch == '"':
                in_string = False
        elif ch == '"':
            in_string = True
        elif ch == '{':
            depth += 1
        elif ch == '}':
            depth -= 1
            if depth == 0:
                return start, i + 1
        i += 1
    raise ValueError(f'unbalanced braces after "{name}"')


def render_block(block: Dict[str, Any]) -> str:
    """The block as tab-indented JSON nested one level inside the file."""
    dumped = json.dumps(block, indent='\t', ensure_ascii=False)
    lines = dumped.split('\n')
    return '\t"legacy": ' + lines[0] + '\n' + '\n'.join('\t' + line for line in lines[1:])


def insert_block(text: str, block: Dict[str, Any]) -> str:
    """Return the file text with ``legacy`` as its last top-level member."""
    rendered = render_block(block)
    existing = _find_member(text, 'legacy')
    if existing:
        text = text[: existing[0]] + text[existing[1] :]
    trailing = text[len(text.rstrip()) :]
    body = text.rstrip()
    if not body.endswith('}'):
        raise ValueError('file does not end with }')
    body = body[:-1].rstrip()
    comma = '' if body.endswith('{') else ','
    newline = '\n'
    return body + comma + newline + rendered + newline + '}' + (trailing or newline)


# ============================================================================
# Driver
# ============================================================================


def git_show(root: Path, ref: str, rel: Path) -> Optional[str]:
    """The file at ``ref`` or None when it does not exist there."""
    result = subprocess.run(
        ['git', '-C', str(root), 'show', f'{ref}:{rel.as_posix()}'],
        capture_output=True,
        text=True,
        encoding='utf-8',
        errors='replace',
    )
    return result.stdout if result.returncode == 0 else None


def service_files(root: Path) -> Iterable[Path]:
    for dirpath, dirnames, filenames in os.walk(root / NODES_ROOT):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for name in sorted(filenames):
            if SERVICES_FILE.match(name):
                yield Path(dirpath) / name


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[1])
    parser.add_argument('--root', default='.', help='repository root (default: cwd)')
    parser.add_argument('--ref', default='origin/develop', help='git ref holding the OLD definitions')
    parser.add_argument('--write', action='store_true', help='write the blocks (default: report only)')
    args = parser.parse_args(argv)

    root = Path(args.root).resolve()
    shared = shared_definitions(root)
    written = skipped = 0
    hand_seen: Set[str] = set()
    for path in service_files(root):
        rel = path.relative_to(root)
        node_rel = path.relative_to(root / NODES_ROOT).as_posix()
        old_text = git_show(root, args.ref, rel)
        if old_text is None:
            skipped += 1
            continue
        old = load_json(old_text)
        if not old.get('preconfig') and not old.get('fields'):
            skipped += 1
            continue
        text = path.read_text(encoding='utf-8')
        block = build_block(node_rel, old, load_json(text), shared)
        if node_rel in HAND:
            hand_seen.add(node_rel)
        if not block['profiles'] and not block['dropped'] and len(block) == 2:
            # Nothing an old pipe could carry that the new schema rejects.
            skipped += 1
            continue
        summary = (
            f'{node_rel}: selector={block.get("selector")} default={block.get("default")} '
            f'profiles={len(block["profiles"])} dropped={block["dropped"]}'
        )
        for extra in ('renamed', 'credential', 'profileMap'):
            if extra in block:
                summary += f' {extra}={json.dumps(block[extra])}'
        print(summary)
        if args.write:
            new_text = insert_block(text, block)
            load_json(new_text)  # the result must still parse
            path.write_text(new_text, encoding='utf-8', newline='\n')
        written += 1

    missing = sorted(set(HAND) - hand_seen)
    print(
        f'\n{written} definitions {"written" if args.write else "reported"}, {skipped} skipped (new node or no old config)'
    )
    if missing:
        print(f'HAND entries that matched no file: {missing}')
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
