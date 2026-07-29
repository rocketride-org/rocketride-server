"""Command-line entry point for the documentation audit."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .citations import ORPHANED, audit_doc
from .coverage import MISSING_DOC, MISSING_PARAMS, STALE_PARAMS, audit_nodes
from .index import CodeIndex, is_excluded

DOC_SUFFIXES = ('.md', '.mdx')


def _docs(root: Path):
    for suffix in DOC_SUFFIXES:
        for path in root.rglob(f'*{suffix}'):
            if not is_excluded(path.relative_to(root)):
                yield path


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog='docs-audit',
        description='Audit documentation against the code it claims to describe.',
    )
    parser.add_argument('--root', default='.', help='Repository root (default: cwd)')
    parser.add_argument('--json', action='store_true', help='Emit machine-readable JSON')
    parser.add_argument(
        '--fail-on-orphaned',
        action='store_true',
        help='Exit non-zero if any ORPHANED citation is found (for CI)',
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    root = Path(args.root).resolve()

    index = CodeIndex.build(root)
    verdicts = [verdict for path in _docs(root) for verdict in audit_doc(path, root, index)]
    gaps = audit_nodes(root)

    orphaned = [v for v in verdicts if v.verdict == ORPHANED]

    if args.json:
        payload = {
            'citations': {
                'total': len(verdicts),
                'by_verdict': {
                    verdict: sum(1 for v in verdicts if v.verdict == verdict)
                    for verdict in sorted({v.verdict for v in verdicts})
                },
                'orphaned': [
                    {'doc': v.citation.doc, 'line': v.citation.line, 'token': v.citation.token, 'evidence': v.evidence}
                    for v in orphaned
                ],
            },
            'coverage': [{'kind': g.kind, 'node': g.node, 'detail': g.detail} for g in gaps],
        }
        json.dump(payload, sys.stdout, indent=2)
        sys.stdout.write('\n')
        return 1 if (args.fail_on_orphaned and orphaned) else 0

    print(f'Scanned {len(verdicts)} doc->code citations across the tree.\n')
    print('  verdict          count   meaning')
    print('  ---------------  -----   -------')
    labels = {
        'VERIFIED': 'resolves to real code',
        'PLACEHOLDER': 'reader creates it (protected)',
        'HISTORICAL': 'describes the past (protected)',
        'RUNTIME': 'built at runtime (protected)',
        'ORPHANED': 'no referent -> review for deletion',
    }
    for verdict in ('VERIFIED', 'PLACEHOLDER', 'HISTORICAL', 'RUNTIME', 'ORPHANED'):
        count = sum(1 for v in verdicts if v.verdict == verdict)
        print(f'  {verdict:<15}  {count:>5}   {labels[verdict]}')

    if orphaned:
        print(f'\nORPHANED citations ({len(orphaned)}) -- each needs a human decision:\n')
        for verdict in sorted(orphaned, key=lambda v: (v.citation.doc, v.citation.line)):
            citation = verdict.citation
            print(f'  {citation.doc}:{citation.line}  `{citation.token}`')

    if gaps:
        print(f'\nUndocumented / drifted code ({len(gaps)}):\n')
        for kind in (STALE_PARAMS, MISSING_PARAMS, MISSING_DOC):
            matching = [g for g in gaps if g.kind == kind]
            if not matching:
                continue
            print(f'  [{kind}] {len(matching)}')
            for gap in matching:
                print(f'    {gap.node}: {gap.detail}')

    return 1 if (args.fail_on_orphaned and orphaned) else 0
