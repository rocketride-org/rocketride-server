#!/usr/bin/env python3
"""Validate the Python/TypeScript client docs against
docs/development/clients/readme-schema.md.

Deterministic, no LLM. Two layers:

1. READMEs (docs/public/{python,typescript}/README.md — the PyPI/npm sources):
   exactly the schema sections, in order, plus env-var parity between the two
   Configuration tables.
2. Site pages (the rest of each folder): both folders publish the same page
   set (declared single-language extras aside), and the two reference.md files
   document the same API symbols — harvested from the first backticked cell of
   table rows and normalized across naming conventions (snake_case ==
   camelCase). Rows ending with an HTML comment containing "language-specific"
   are exempt, as are Python dunder methods.

Usage: validate-client-docs.py [repo-root]
"""

import re
import sys
from pathlib import Path

README_SECTIONS = [
    'Quick Start',
    'What is RocketRide?',
    'Configuration',
    'Documentation',
    'Links',
    'License',
]

# The shared site page set (filenames, extension-insensitive: index is .mdx).
SHARED_PAGES = [
    'index',
    'configuration',
    'connection',
    'pipelines',
    'deploy',
    'data',
    'storage',
    'chat',
    'logs',
    'errors',
    'reference',
    'examples',
    'analytics',
]
# Declared single-language extras (surface that exists in one SDK only).
TS_ONLY_PAGES = {'database-sequelize'}
PY_ONLY_PAGES = set()


def norm(symbol: str) -> str:
    """snake_case and camelCase collapse to the same key."""
    return re.sub(r'[^a-z0-9]', '', symbol.lower())


def harvest(text: str):
    """Backticked first-column table cells -> {normalized: display}.

    Constructor subsections are excluded: constructor options are
    structurally language-divergent and live on configuration.md. Dotted
    names compare by their final segment (`Answer.parsePython` ==
    `parsePython`).
    """
    text = re.sub(r'^#+ Constructor.*?(?=^#+ |\Z)', '', text, flags=re.M | re.S)
    out = {}
    for line in text.splitlines():
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


def env_vars(text: str):
    """`ROCKETRIDE_*` first-column cells from the README Configuration table."""
    return {m.group(1) for m in re.finditer(r'^\|\s*`(ROCKETRIDE_\w+)`\s*\|', text, re.M)}


def main():
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path('.')
    dirs = {
        'python': root / 'docs/public/python',
        'typescript': root / 'docs/public/typescript',
    }
    failures = []

    # -- layer 1: READMEs --
    readmes = {}
    for lang, d in dirs.items():
        path = d / 'README.md'
        if not path.exists():
            print(f'FAIL: {path} does not exist')
            sys.exit(1)
        readmes[lang] = path.read_text()

    for lang, text in readmes.items():
        heads = re.findall(r'^## (.+?)\s*$', text, re.M)
        if heads != README_SECTIONS:
            missing = [s for s in README_SECTIONS if s not in heads]
            unknown = [h for h in heads if h not in README_SECTIONS]
            for s in missing:
                failures.append(f"{lang} README: missing section '## {s}'")
            for h in unknown:
                failures.append(f"{lang} README: unknown section '## {h}'")
            if not missing and not unknown:
                failures.append(f'{lang} README: sections out of schema order')
        if 'Full documentation:' not in text:
            failures.append(f"{lang} README: missing the bold 'Full documentation:' deferral line")

    py_env, ts_env = env_vars(readmes['python']), env_vars(readmes['typescript'])
    for var in sorted(py_env ^ ts_env):
        where = 'python' if var in py_env else 'typescript'
        failures.append(f'README env parity: `{var}` documented in {where} only')

    # -- layer 2: site page set --
    page_sets = {}
    for lang, d in dirs.items():
        page_sets[lang] = {p.stem for p in d.iterdir() if p.suffix in ('.md', '.mdx') and p.stem != 'README'}
    expected = set(SHARED_PAGES)
    for lang, extras in (('python', PY_ONLY_PAGES), ('typescript', TS_ONLY_PAGES)):
        want = expected | extras
        for missing in sorted(want - page_sets[lang]):
            failures.append(f'{lang}: missing site page {missing}.md')
        for unknown in sorted(page_sets[lang] - want):
            failures.append(f'{lang}: undeclared site page {unknown}.md (add to the schema + validator page set)')

    # -- layer 2: reference.md symbol parity --
    refs = {}
    for lang, d in dirs.items():
        path = d / 'reference.md'
        refs[lang] = path.read_text() if path.exists() else ''
    py = harvest(refs['python'])
    ts = harvest(refs['typescript'])
    for key in sorted(set(py) - set(ts)):
        failures.append(
            f'parity[reference]: `{py[key]}` documented in python only '
            f'(add to typescript or mark <!-- language-specific -->)'
        )
    for key in sorted(set(ts) - set(py)):
        failures.append(
            f'parity[reference]: `{ts[key]}` documented in typescript only '
            f'(add to python or mark <!-- language-specific -->)'
        )

    if failures:
        print(f'FAIL ({len(failures)} problems):')
        for f in failures:
            print(f'  - {f}')
        print('\nSchema: docs/development/clients/readme-schema.md')
        sys.exit(1)
    print(
        'ok: client docs conform to the schema '
        f'({len(README_SECTIONS)} README sections, {len(SHARED_PAGES)} shared site pages, '
        'symbol parity across reference.md)'
    )


if __name__ == '__main__':
    main()
