"""Command-line entry point for the documentation audit."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from .citations import ORPHANED, UNREADABLE_DOC, audit_doc
from .coverage import MISSING_DOC, MISSING_PARAMS, STALE_PARAMS, UNREADABLE, audit_nodes
from .index import EXCLUDED_PARTS, CodeIndex, is_excluded

DOC_SUFFIXES = ('.md', '.mdx')


def _docs(root: Path):
    # os.walk with in-place pruning, not rglob: rglob descends node_modules and
    # every vendored tree in full before the filter discards what it yielded.
    for dirpath, dirnames, filenames in os.walk(root):
        rel_dir = Path(dirpath).relative_to(root)
        dirnames[:] = [d for d in dirnames if d not in EXCLUDED_PARTS]
        if is_excluded(rel_dir):
            continue
        for name in filenames:
            if name.endswith(DOC_SUFFIXES):
                yield Path(dirpath) / name


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

    # A typo in --root would otherwise audit nothing, find nothing, and exit 0 --
    # green CI that never ran. Fail loudly instead.
    if not root.is_dir():
        print(f'docs-audit: --root is not a directory: {root}', file=sys.stderr)
        return 2

    index = CodeIndex.build(root)
    verdicts = [verdict for path in _docs(root) for verdict in audit_doc(path, root, index)]
    gaps = audit_nodes(root)

    orphaned = [v for v in verdicts if v.verdict == ORPHANED]
    # A doc that could not be read is a failure to audit, not a clean audit,
    # so it fails the run unconditionally rather than only under --fail-on-orphaned.
    unreadable = [v for v in verdicts if v.verdict == UNREADABLE_DOC]

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
        return 1 if (unreadable or (args.fail_on_orphaned and orphaned)) else 0

    if unreadable:
        print(f'UNREADABLE docs ({len(unreadable)}) -- these were NOT audited:\n')
        for v in unreadable:
            print(f'  {v.citation.doc}: {v.evidence}')
        print()

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
        for kind in (UNREADABLE, STALE_PARAMS, MISSING_PARAMS, MISSING_DOC):
            matching = [g for g in gaps if g.kind == kind]
            if not matching:
                continue
            print(f'  [{kind}] {len(matching)}')
            for gap in matching:
                print(f'    {gap.node}: {gap.detail}')

    return 1 if (unreadable or (args.fail_on_orphaned and orphaned)) else 0


if __name__ == '__main__':  # `python -m docs_audit.cli` printed nothing without this
    raise SystemExit(main())
