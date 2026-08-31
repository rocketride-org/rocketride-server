"""
Repository invariants — the machine-checkable part of "agent-ready".

Every assertion here is binary and self-describing: when it fails, the
message says which file to fix. There are no scores, weights or baselines
to maintain. The point is that the contributor guide (AGENTS.md), the CI
configuration and the tooling pins can never silently drift apart again.

Runs under a plain Python interpreter (no engine): ``./builder test:fast`` or
``python -m pytest tests/test_repo_invariants.py``.

What is asserted (each in its own test so failures are precise):

* AGENTS.md / nodes/AGENTS.md — every ``./builder <module>:<action>`` in a
  fenced block or table resolves to a registered builder action, and its
  whole step graph resolves (``--list-deps``); every backticked relative
  path exists relative to the file that mentions it.
* .github/workflows — every job has ``timeout-minutes`` (jobs that call a
  reusable workflow with ``uses:`` cannot, and are exempt); every external
  ``uses:`` is pinned to a 40-character commit SHA.
* lefthook.yml — no linter hook is commented out.
* .nvmrc matches ``engines.node`` in package.json.
* ruff is pinned to the same version in requirements-test.txt and ci.yml.
* Agent instruction files (AGENTS.md / CLAUDE.md) exist only where a harness
  is meant to load them.
* Known-stale documentation claims do not come back.

The helpers take explicit text/paths so they can be unit-tested with
fixtures (see ``TestCheckers``) — a checker that cannot itself be shown to
fail is not a gate.
"""

import json
import re
import subprocess
from functools import lru_cache
from pathlib import Path
from typing import List, Set, Tuple

import pytest

REPO = Path(__file__).resolve().parent.parent
WORKFLOWS = REPO / '.github' / 'workflows'
INSTRUCTION_FILES = [p for p in (REPO / 'AGENTS.md', REPO / 'nodes' / 'AGENTS.md') if p.exists()]

# Where AGENTS.md / CLAUDE.md are allowed to live. Root is loaded by every
# harness; nodes/ is the one sub-tree large enough to justify its own file;
# docs/stubs and docs/agents/stubs hold CONSUMER templates that the VS Code
# installer copies into user projects (apps/vscode/src/agents/base-installer.ts).
INSTRUCTION_FILE_ALLOWLIST = {
    'AGENTS.md',
    'CLAUDE.md',
    'nodes/AGENTS.md',
    'docs/stubs/AGENTS.md',
    'docs/stubs/CLAUDE.md',
    'docs/agents/stubs/AGENTS.md',
    'docs/agents/stubs/CLAUDE.md',
}

# Documentation claims that were wrong once and must not return.
# (path, regex, why)
STALE_CLAIMS = [
    ('docs/README.md', r'\|\s*\*\*Node\.js\*\*\s*\|\s*18\+', 'package.json engines requires Node >= 20'),
    (
        'docs/README-node-testing.md',
        r'no server needed\)\s*\n\s*builder nodes:test\b',
        'nodes:test starts a server; the server-free command is nodes:test-contracts-local',
    ),
    ('.github/PULL_REQUEST_TEMPLATE.md', r'Wiki updated', 'there is no wiki; docs live in docs/'),
    (
        '.github/PULL_REQUEST_TEMPLATE.md',
        r'`\./builder test` passes',
        'nobody runs the 20-minute polyglot suite locally; the checkable claim is test:fast + lint:check + surfaces:check',
    ),
    (
        'AGENTS.md',
        r'^\s*npx tsc --noEmit\s*$',
        'a bare root tsc is not what CI runs — use ./builder lint:tsc or the per-workspace form',
    ),
    ('docs/README.md', r'\|\s*\*\*pnpm\*\*\s*\|\s*[89]\+', 'package.json engines requires pnpm >= 10'),
]


# =============================================================================
# Checkers (pure functions over text — unit-tested below)
# =============================================================================

BUILDER_CMD_RE = re.compile(
    r'(?:^|[\s`|(])\.?/?builder\s+((?:[a-z0-9-]+:[a-z0-9-]+)(?:\s+[a-z0-9-]+:[a-z0-9-]+)*)', re.MULTILINE
)
BACKTICK_RE = re.compile(r'`([^`\n]+)`')
PATH_LIKE_RE = re.compile(
    r'^(?:\.?\.?/)?[\w.@-]+(?:/[\w.@*-]+)*\.(?:md|js|mjs|cjs|ts|tsx|py|json|toml|ya?ml|txt|cfg|ini|sh|cmd)$|^(?:\.?\.?/)?[\w.@-]+(?:/[\w.@-]+)+/?$'
)


def builder_actions_in(text: str) -> List[str]:
    """Return every ``module:action`` that appears after ``./builder`` in *text*."""
    found: List[str] = []
    for m in BUILDER_CMD_RE.finditer(text):
        found.extend(m.group(1).split())
    return found


def relative_paths_in(text: str) -> List[str]:
    """Return backticked tokens that look like repo-relative file or directory paths."""
    paths: List[str] = []
    for m in BACKTICK_RE.finditer(text):
        token = m.group(1).strip()
        if token.startswith(('http://', 'https://', '$', '-', '<')) or '<' in token or ' ' in token:
            continue
        if token.startswith(('dist/', 'build/', '.venv/')):  # gitignored build outputs
            continue
        if token.startswith('@'):  # scoped package names, not paths
            continue
        if '*' in token:
            continue
        if PATH_LIKE_RE.match(token):
            paths.append(token)
    return paths


def workflow_jobs(text: str) -> List[Tuple[str, bool, bool]]:
    """
    Parse a workflow file without PyYAML.

    Returns ``(job_id, has_timeout, is_reusable_call)`` per job. A job is the
    2-space-indented key under ``jobs:``; its body is everything indented
    deeper until the next 2-space key.
    """
    lines = text.splitlines()
    try:
        start = next(i for i, line in enumerate(lines) if re.match(r'^jobs:\s*(#.*)?$', line))
    except StopIteration:
        return []
    jobs: List[Tuple[str, bool, bool]] = []
    i = start + 1
    current = None
    body: List[str] = []

    def flush():
        if current is None:
            return
        has_timeout = any(re.match(r'\s{4}timeout-minutes:', b) for b in body)
        reusable = any(re.match(r'\s{4}uses:\s*\S', b) for b in body)
        jobs.append((current, has_timeout, reusable))

    while i < len(lines):
        line = lines[i]
        m = re.match(r'^  ([A-Za-z0-9_-]+):\s*(#.*)?$', line)
        if m:
            flush()
            current = m.group(1)
            body = []
        elif re.match(r'^\S', line) and line.strip():
            flush()
            current = None
            break
        else:
            body.append(line)
        i += 1
    flush()
    return jobs


USES_RE = re.compile(r'^\s*-?\s*uses:\s*([^\s#]+)', re.MULTILINE)
SHA_RE = re.compile(r'@[0-9a-f]{40}$')


def unpinned_uses(text: str) -> List[str]:
    """External ``uses:`` references that are not pinned to a full commit SHA."""
    bad = []
    for m in USES_RE.finditer(text):
        ref = m.group(1).strip('\'"')
        if ref.startswith(('./', 'docker://')):
            continue
        if not SHA_RE.search(ref):
            bad.append(ref)
    return bad


COMMENTED_HOOK_RE = re.compile(
    r'^\s*#\s*(eslint|prettier|ruff[\w-]*|tsc|pyright|mypy|clang-format)\s*:\s*$', re.MULTILINE
)


def commented_out_hooks(text: str) -> List[str]:
    return COMMENTED_HOOK_RE.findall(text)


def pinned_version(text: str, tool: str) -> str:
    """``tool==X.Y.Z`` in a requirements file, or ``version: X.Y.Z`` after ``tool-action`` in a workflow."""
    m = re.search(rf'^{tool}==([\w.]+)\s*$', text, re.MULTILINE)
    if m:
        return m.group(1)
    # Scan the whole `with:` block of the action step (any key order, comments allowed).
    m = re.search(rf'{tool}-action@[^\n]*\n\s+with:\s*\n((?:[ \t]+\S[^\n]*\n)*)', text)
    if not m:
        return ''
    v = re.search(r'^\s+version:\s*[\'"]?([\w.]+)', m.group(1), re.MULTILINE)
    return v.group(1) if v else ''


# =============================================================================
# Repo fixtures
# =============================================================================


@lru_cache(maxsize=1)
def registered_actions() -> Set[str]:
    # encoding/errors are explicit: on Windows, text=True alone decodes with the
    # ANSI code page, which can kill the reader thread and leave stdout=None.
    proc = subprocess.run(
        ['node', str(REPO / 'scripts' / 'build.js'), '--list-actions'],
        cwd=REPO,
        capture_output=True,
        text=True,
        encoding='utf-8',
        errors='replace',
        timeout=120,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            f'`node scripts/build.js --list-actions` exited {proc.returncode}; '
            f'the invariants suite needs a working builder.\nstderr:\n{proc.stderr}'
        )
    out = proc.stdout
    return {line.strip().split(' ')[0] for line in out.splitlines() if re.match(r'^\s+[a-z0-9-]+:[a-z0-9-]+', line)}


def list_deps(action: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ['node', str(REPO / 'scripts' / 'build.js'), '--list-deps', action],
        cwd=REPO,
        capture_output=True,
        text=True,
        encoding='utf-8',
        errors='replace',
        timeout=120,
    )


# =============================================================================
# Tests against the real repository
# =============================================================================


@pytest.mark.parametrize('instruction_file', INSTRUCTION_FILES, ids=lambda p: str(p.relative_to(REPO)))
class TestInstructionFiles:
    def test_builder_commands_are_registered(self, instruction_file: Path):
        text = instruction_file.read_text(encoding='utf-8')
        actions = builder_actions_in(text)
        assert actions, f'{instruction_file.relative_to(REPO)} documents no ./builder commands at all'
        unknown = sorted(set(actions) - registered_actions())
        assert not unknown, f'{instruction_file.relative_to(REPO)} mentions unregistered builder actions: {unknown}'

    def test_builder_command_graphs_resolve(self, instruction_file: Path):
        text = instruction_file.read_text(encoding='utf-8')
        failures = []
        for action in sorted(set(builder_actions_in(text))):
            proc = list_deps(action)
            if proc.returncode != 0 or 'Unknown' in proc.stdout or 'not found' in proc.stdout:
                failures.append(f'{action}: {proc.stdout.strip()[-300:]} {proc.stderr.strip()[-300:]}')
        assert not failures, 'builder step graph does not resolve:\n' + '\n'.join(failures)

    def test_relative_paths_exist(self, instruction_file: Path):
        text = instruction_file.read_text(encoding='utf-8')
        base = instruction_file.parent
        missing = [p for p in relative_paths_in(text) if not (base / p).exists() and not (REPO / p).exists()]
        assert not missing, f'{instruction_file.relative_to(REPO)} references paths that do not exist: {missing}'


@pytest.mark.parametrize('workflow', sorted(WORKFLOWS.glob('*.y*ml')), ids=lambda p: p.name)
class TestWorkflows:
    def test_every_job_has_timeout(self, workflow: Path):
        jobs = workflow_jobs(workflow.read_text(encoding='utf-8'))
        missing = [job for job, has_timeout, reusable in jobs if not has_timeout and not reusable]
        assert not missing, f'{workflow.name}: jobs without timeout-minutes: {missing}'

    def test_actions_are_sha_pinned(self, workflow: Path):
        bad = unpinned_uses(workflow.read_text(encoding='utf-8'))
        assert not bad, f'{workflow.name}: uses: not pinned to a 40-char SHA: {bad}'


def test_lefthook_has_no_commented_out_linters():
    text = (REPO / 'lefthook.yml').read_text(encoding='utf-8')
    assert not commented_out_hooks(text), 'lefthook.yml has commented-out linter hooks; enable them or delete them'


def test_nvmrc_matches_engines():
    nvmrc = (REPO / '.nvmrc').read_text(encoding='utf-8').strip().lstrip('v')
    engines = json.loads((REPO / 'package.json').read_text(encoding='utf-8'))['engines']['node']
    m = re.search(r'(\d+)', engines)
    assert m and nvmrc.split('.')[0] == m.group(1), (
        f'.nvmrc ({nvmrc}) does not match package.json engines.node ({engines})'
    )


def test_ruff_pinned_identically():
    req = pinned_version((REPO / 'requirements-test.txt').read_text(encoding='utf-8'), 'ruff')
    ci = pinned_version((WORKFLOWS / 'ci.yml').read_text(encoding='utf-8'), 'ruff')
    assert req, 'requirements-test.txt must pin ruff==X.Y.Z'
    assert ci, 'ci.yml ruff-action must set with: version: X.Y.Z'
    assert req == ci, f'ruff version differs: requirements-test.txt={req} ci.yml={ci}'


def test_instruction_files_only_where_allowed():
    tracked = subprocess.run(
        ['git', 'ls-files', '--', '*AGENTS.md', '*CLAUDE.md'],
        cwd=REPO,
        capture_output=True,
        text=True,
        encoding='utf-8',
        errors='replace',
        check=True,
    ).stdout.split()
    stray = sorted(p for p in tracked if p not in INSTRUCTION_FILE_ALLOWLIST)
    assert not stray, f'AGENTS.md/CLAUDE.md outside the allow-list (harnesses auto-load these): {stray}'


@pytest.mark.parametrize('rel, pattern, why', STALE_CLAIMS, ids=[f'{c[0]}:{c[1][:20]}' for c in STALE_CLAIMS])
def test_stale_claims_do_not_return(rel: str, pattern: str, why: str):
    path = REPO / rel
    if not path.exists():
        pytest.skip(f'{rel} not present')
    text = path.read_text(encoding='utf-8')
    assert not re.search(pattern, text, re.MULTILINE), f'{rel} regressed: matched /{pattern}/ — {why}'


# =============================================================================
# Unit tests for the checkers — each must be shown to FAIL on bad input
# =============================================================================


class TestCheckers:
    def test_builder_actions_in_finds_fenced_and_table_forms(self):
        text = '```bash\n./builder test:fast\n./builder lint:check surfaces:check\n```\n| `./builder shell:check` |\nbuilder nodes:test'
        assert builder_actions_in(text) == ['test:fast', 'lint:check', 'surfaces:check', 'shell:check', 'nodes:test']

    def test_relative_paths_in_filters_noise(self):
        text = '`docs/README.md` `https://x.y/z` `<node-dir>` `nodes/src/nodes/*/README.md` `scripts/lib/pytest.js` `ROCKETRIDE_PYTHON` `./builder x:y` `dist/server/engine`'
        assert relative_paths_in(text) == ['docs/README.md', 'scripts/lib/pytest.js']

    def test_workflow_jobs_detects_missing_timeout_and_reusable(self):
        text = 'name: x\njobs: # all\n  a: # first\n    runs-on: ubuntu-latest\n    timeout-minutes: 5\n  b:\n    runs-on: ubuntu-latest\n  c:\n    uses: ./.github/workflows/_init.yaml\n'
        assert workflow_jobs(text) == [('a', True, False), ('b', False, False), ('c', False, True)]

    def test_unpinned_uses_flags_tags_only(self):
        text = '  - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4\n  - uses: actions/setup-node@v4\n  uses: ./.github/workflows/_build.yaml\n'
        assert unpinned_uses(text) == ['actions/setup-node@v4']

    def test_commented_out_hooks_detected(self):
        assert commented_out_hooks('    # eslint:\n    #   run: x\n    ruff-check:\n') == ['eslint']
        assert commented_out_hooks('    eslint:\n      run: x\n') == []

    def test_pinned_version_reads_both_formats(self):
        assert pinned_version('pytest\nruff==0.16.5\n', 'ruff') == '0.16.5'
        assert (
            pinned_version(
                '      - uses: astral-sh/ruff-action@abc # v3\n        with:\n          version: 0.16.5\n', 'ruff'
            )
            == '0.16.5'
        )
        assert (
            pinned_version(
                '      - uses: astral-sh/ruff-action@abc # v3\n        with:\n          # keep in sync\n          version: 0.16.5\n',
                'ruff',
            )
            == '0.16.5'
        )
        assert (
            pinned_version(
                '      - uses: astral-sh/ruff-action@abc # v3\n        with:\n          args: check\n          version: 0.16.5\n',
                'ruff',
            )
            == '0.16.5'
        )
        assert pinned_version('      - uses: astral-sh/ruff-action@abc # v3\n      - run: ruff check\n', 'ruff') == ''

    def test_stale_claim_patterns_match_the_original_text(self):
        # Each regex must hit the wording that was actually in the tree, or the guard is decorative.
        samples = {
            'docs/README.md': '| **Node.js**       | 18+           | Runtime |\n| **pnpm**          | 8+            | x |',
            'docs/README-node-testing.md': '# Contract tests (no server needed)\nbuilder nodes:test\n',
            '.github/PULL_REQUEST_TEMPLATE.md': '- [ ] `./builder test` passes\n- [ ] Wiki updated (if applicable)',
            'AGENTS.md': 'npx tsc --noEmit\n',
        }
        for rel, pattern, _ in STALE_CLAIMS:
            assert re.search(pattern, samples[rel], re.MULTILINE), (
                f'pattern for {rel} does not match its own sample: {pattern}'
            )
