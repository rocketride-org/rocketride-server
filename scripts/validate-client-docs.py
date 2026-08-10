#!/usr/bin/env python3
"""Validate the Python/TypeScript client readmes against
docs/development/client-readme-schema.md.

Deterministic, no LLM. Checks section order and API symbol parity between
docs/clients/python/readme.md and docs/clients/typescript/readme.md.
Symbols are harvested from the first backticked cell of table rows inside
the shared API sections and normalized across naming conventions
(snake_case == camelCase). Rows ending with an HTML comment containing
"language-specific" are exempt, as are Python dunder methods.

Usage: validate-client-docs.py [repo-root]
"""

import re
import sys
from pathlib import Path

SHARED_SECTIONS = [
    'Quick Start',
    'What is RocketRide?',
    'Features',
    'RocketRideClient',
    'DataPipe',
    'Question',
    'Answer',
    'Types',
    'Exceptions',
    'Examples (Full API Usage)',
    'Links',
    'License',
]
LANG_SECTIONS = {
    'python': {'CLI', 'Configuration'},
    'typescript': {'RocketRideClientConfig'},
}
# Where language-specific sections must sit (section they follow).
LANG_POSITION = {
    'RocketRideClientConfig': 'Features',
    'CLI': 'Examples (Full API Usage)',
    'Configuration': 'CLI',
}
PARITY_SECTIONS = ['RocketRideClient', 'DataPipe', 'Question', 'Answer', 'Types', 'Exceptions']


def norm(symbol: str) -> str:
    """snake_case and camelCase collapse to the same key."""
    return re.sub(r'[^a-z0-9]', '', symbol.lower())


def sections(text: str):
    parts = {}
    matches = list(re.finditer(r'^## (.+?)\s*$', text, re.M))
    for i, m in enumerate(matches):
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        parts[m.group(1)] = text[m.end() : end]
    return parts


def harvest(section_text: str):
    """Backticked first-column table cells -> {normalized: display}.

    Constructor subsections are excluded: constructor options are
    structurally language-divergent (Python kwargs vs the TypeScript
    RocketRideClientConfig object, which has its own section). Dotted names
    compare by their final segment (`Answer.parsePython` == `parsePython`).
    """
    section_text = re.sub(r'^### Constructor.*?(?=^### |\Z)', '', section_text, flags=re.M | re.S)
    out = {}
    for line in section_text.splitlines():
        m = re.match(r'^\|\s*`([^`]+)`\s*\|', line)
        if not m:
            continue
        if 'language-specific' in line.lower():
            continue
        name = m.group(1).strip()
        name = name.split('(')[0].strip()
        if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_.]*', name):
            continue
        name = name.split('.')[-1]
        if re.fullmatch(r'__\w+__', name):  # Python dunder idiom
            continue
        out.setdefault(norm(name), name)
    return out


def main():
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path('.')
    files = {
        'python': root / 'docs/clients/python/readme.md',
        'typescript': root / 'docs/clients/typescript/readme.md',
    }
    failures = []

    docs = {}
    for lang, path in files.items():
        if not path.exists():
            print(f'FAIL: {path} does not exist')
            sys.exit(1)
        docs[lang] = path.read_text()

    # -- section presence, order, and ownership --
    for lang, text in docs.items():
        heads = re.findall(r'^## (.+?)\s*$', text, re.M)
        for s in SHARED_SECTIONS:
            if s not in heads:
                failures.append(f"{lang}: missing shared section '## {s}'")
        allowed = set(SHARED_SECTIONS) | LANG_SECTIONS[lang]
        for h in heads:
            if h not in allowed:
                other = [name for name, ss in LANG_SECTIONS.items() if h in ss]
                if other:
                    failures.append(f"{lang}: section '## {h}' belongs to {other[0]} only")
                else:
                    failures.append(f"{lang}: unknown section '## {h}'")
        order = [h for h in heads if h in SHARED_SECTIONS]
        expected = [s for s in SHARED_SECTIONS if s in heads]
        if order != expected:
            failures.append(f'{lang}: shared sections out of schema order')
        for extra, after in LANG_POSITION.items():
            if extra in heads and after in heads:
                if heads.index(extra) != heads.index(after) + 1:
                    failures.append(f"{lang}: '## {extra}' must directly follow '## {after}'")

    # -- API symbol parity --
    parts = {lang: sections(text) for lang, text in docs.items()}
    for sec in PARITY_SECTIONS:
        py = harvest(parts['python'].get(sec, ''))
        ts = harvest(parts['typescript'].get(sec, ''))
        for key in sorted(set(py) - set(ts)):
            failures.append(
                f'parity[{sec}]: `{py[key]}` documented in python only '
                f'(add to typescript or mark <!-- language-specific -->)'
            )
        for key in sorted(set(ts) - set(py)):
            failures.append(
                f'parity[{sec}]: `{ts[key]}` documented in typescript only '
                f'(add to python or mark <!-- language-specific -->)'
            )

    if failures:
        print(f'FAIL ({len(failures)} problems):')
        for f in failures:
            print(f'  - {f}')
        print('\nSchema: docs/development/client-readme-schema.md')
        sys.exit(1)
    print(
        'ok: client docs conform to the schema '
        f'({len(SHARED_SECTIONS)} shared sections, parity across '
        f'{len(PARITY_SECTIONS)} API sections)'
    )


if __name__ == '__main__':
    main()
