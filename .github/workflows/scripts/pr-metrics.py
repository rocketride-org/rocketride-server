"""Measure how PRs merged into develop follow "Show that it works" in CONTRIBUTING.md.

Usage: python3 pr-metrics.py [--days N | --since YYYY-MM-DD --until YYYY-MM-DD]
                             [--repo OWNER/NAME] [--base BRANCH] [--format markdown|discord|json]

Reads merged PRs with `gh api graphql`, so GH_TOKEN (or a gh login) must be able to
read the repository. PRs opened by bots are left out of every number.
"""

import argparse
import datetime as dt
import json
import re
import statistics
import subprocess
import sys

# The same UI paths as the "UI evidence" check in .coderabbit.yaml.
UI_PREFIXES = (
    'packages/shell/src/',
    'apps/shared/',
    'apps/vscode/src/',
    'packages/chat-widget/src/',
    'packages/ai/src/ai/modules/mcp/apps/',
    'docs/docusaurus/src/',
)
UI_APP = re.compile(r'^apps/[^/]+-ui/src/')
TEST_FILE = re.compile(r'(^|/)(tests?|__tests__)/|\.(test|spec)\.[jt]sx?$')

# An embedded image or video, or a GitHub attachment. Badges from img.shields.io do not count.
EVIDENCE = re.compile(
    r'!\[[^\]]*\]\((?!https?://img\.shields\.io)[^)]+\)|<img\b(?![^>]*img\.shields\.io)|<video\b'
    r'|github\.com/user-attachments/assets/|user-images\.githubusercontent\.com/',
    re.IGNORECASE,
)
COMMENT = re.compile(r'<!--.*?-->', re.DOTALL)
PLACEHOLDER_LINE = re.compile(r'^(steps:|result:|\d+\.|-\s*\[[ x]\].*)$', re.IGNORECASE)

# Measured with this script for PRs merged from 2026-08-22 to 2026-10-23, before the
# evidence rules: python3 pr-metrics.py --since 2026-08-22 --until 2026-10-23 --format json
BASELINE_WINDOW = '2026-08-22 to 2026-10-23'
BASELINE = {
    'merged': 270,
    'ui_prs': 34,
    'ui_with_evidence': 3,
    'verification_filled': 18,
    'linked_issue': 148,
    'changes_requested': 65,
    'reverts': 3,
    'median_hours': 44.9,
    'p90_hours': 1241.4,
}

QUERY = """
query($q: String!, $cursor: String) {
  search(query: $q, type: ISSUE, first: 25, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        number title body createdAt mergedAt
        author { login __typename }
        closingIssuesReferences { totalCount }
        reviews(states: CHANGES_REQUESTED, first: 20) { nodes { author { login __typename } } }
        files(first: 100) { nodes { path changeType } }
      }
    }
  }
}
"""


def is_bot(author: dict | None) -> bool:
    if not author:
        return True
    return author.get('__typename') == 'Bot' or author.get('login', '').endswith('[bot]')


def fetch(repo: str, base: str, since: dt.date, until: dt.date) -> list[dict]:
    search = f'repo:{repo} is:pr is:merged base:{base} merged:{since.isoformat()}..{until.isoformat()}'
    prs, cursor = [], None
    while True:
        cmd = ['gh', 'api', 'graphql', '-f', f'query={QUERY}', '-f', f'q={search}']
        if cursor:
            cmd += ['-f', f'cursor={cursor}']
        page = json.loads(subprocess.run(cmd, capture_output=True, text=True, check=True).stdout)['data']['search']
        prs += [n for n in page['nodes'] if n]
        if not page['pageInfo']['hasNextPage']:
            return prs
        cursor = page['pageInfo']['endCursor']


def changes_ui(files: list[dict]) -> bool:
    for f in files:
        path = f['path']
        if TEST_FILE.search(path):
            continue
        if path.startswith(UI_PREFIXES) or UI_APP.match(path):
            return True
        if path.startswith('docs/public/') and path.endswith(('.md', '.mdx')) and f['changeType'] == 'ADDED':
            return True
    return False


def verification_filled(body: str) -> bool:
    match = re.search(r'^##\s*Verification\s*$(.*?)(?=^##\s|\Z)', body, re.MULTILINE | re.DOTALL)
    if not match:
        return False
    text = re.sub(r'<!--.*?-->', '', match.group(1), flags=re.DOTALL)
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    return any(not PLACEHOLDER_LINE.match(line) for line in lines)


def hours(pr: dict) -> float:
    opened = dt.datetime.fromisoformat(pr['createdAt'].replace('Z', '+00:00'))
    merged = dt.datetime.fromisoformat(pr['mergedAt'].replace('Z', '+00:00'))
    return (merged - opened).total_seconds() / 3600


def measure(prs: list[dict]) -> dict:
    prs = [p for p in prs if not is_bot(p['author'])]
    ui = [p for p in prs if changes_ui(p['files']['nodes'])]
    times = sorted(hours(p) for p in prs)
    return {
        'merged': len(prs),
        'ui_prs': len(ui),
        'ui_with_evidence': sum(bool(EVIDENCE.search(COMMENT.sub('', p['body'] or ''))) for p in ui),
        'verification_filled': sum(verification_filled(p['body'] or '') for p in prs),
        'linked_issue': sum(p['closingIssuesReferences']['totalCount'] > 0 for p in prs),
        'changes_requested': sum(any(not is_bot(r['author']) for r in p['reviews']['nodes']) for p in prs),
        'reverts': sum(p['title'].lower().startswith('revert') for p in prs),
        'median_hours': round(statistics.median(times), 1) if times else None,
        'p90_hours': round(times[int(0.9 * (len(times) - 1))], 1) if times else None,
    }


def rows(m: dict) -> list[tuple[str, str]]:
    def of(part: int, whole: int) -> str:
        return f'{part} of {whole}' + (f' ({100 * part // whole}%)' if whole else '')

    return [
        ('PRs merged', str(m['merged'])),
        ('UI PRs with a screenshot or video', of(m['ui_with_evidence'], m['ui_prs'])),
        ('PRs with a filled-in Verification section', of(m['verification_filled'], m['merged'])),
        ('PRs that close an issue', of(m['linked_issue'], m['merged'])),
        ('PRs where a person requested changes', of(m['changes_requested'], m['merged'])),
        ('Reverts', str(m['reverts'])),
        ('Median hours from open to merge', str(m['median_hours'])),
        ('90th percentile hours from open to merge', str(m['p90_hours'])),
    ]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--days', type=int, default=7)
    parser.add_argument('--since', type=dt.date.fromisoformat)
    parser.add_argument('--until', type=dt.date.fromisoformat)
    parser.add_argument('--repo', default='rocketride-org/rocketride-server')
    parser.add_argument('--base', default='develop')
    parser.add_argument('--format', choices=('markdown', 'discord', 'json'), default='markdown')
    args = parser.parse_args()

    # Both ends are inclusive. --days counts whole UTC days ending yesterday, so weekly runs neither overlap nor skip.
    until = args.until or dt.datetime.now(dt.timezone.utc).date() - dt.timedelta(days=1)
    since = args.since or until - dt.timedelta(days=args.days - 1)
    m = measure(fetch(args.repo, args.base, since, until))
    window = f'{since.isoformat()} to {until.isoformat()}'

    if args.format == 'json':
        print(json.dumps({'window': window, **m}, indent=2))
        return

    base_rows = dict(rows(BASELINE)) if BASELINE else {}
    if args.format == 'markdown':
        print(f'## PR metrics for {args.base}, {window}\n')
        print(f'| Measure | {window} | {BASELINE_WINDOW}, before the rules |')
        print('|---|---|---|')
        for name, value in rows(m):
            print(f'| {name} | {value} | {base_rows.get(name, "")} |')
        print('\nMeasured by .github/workflows/scripts/pr-metrics.py. PRs opened by bots are left out.')
        return

    lines = [f'**PR metrics for develop, {window}**']
    for name, value in rows(m):
        before = f' (before the rules: {base_rows[name]})' if name in base_rows else ''
        lines.append(f'- {name}: {value}{before}')
    json.dump({'content': '\n'.join(lines)[:2000], 'allowed_mentions': {'parse': []}}, sys.stdout)


if __name__ == '__main__':
    main()
