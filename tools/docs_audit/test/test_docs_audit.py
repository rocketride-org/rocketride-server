"""Tests for the documentation audit.

The two regression tests that matter most are ``test_placeholder_*`` and
``test_profile_groups_*``: each pins a false positive that an earlier version
of this tool produced, and each would have caused correct documentation to be
deleted or a clean node to be reported as drifted.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

_SRC = Path(__file__).resolve().parents[1] / 'src'
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

from docs_audit.citations import (  # noqa: E402
    HISTORICAL,
    ORPHANED,
    PLACEHOLDER,
    RUNTIME,
    VERIFIED,
    classify,
    extract,
)
from docs_audit.cli import main  # noqa: E402
from docs_audit.coverage import (  # noqa: E402
    MISSING_DOC,
    STALE_PARAMS,
    UNREADABLE,
    audit_node,
    schema_params,
    strip_jsonc,
)
from docs_audit.index import CodeIndex  # noqa: E402


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    (tmp_path / 'pkg').mkdir()
    (tmp_path / 'pkg' / 'real.py').write_text("PATH = 'built_at_runtime.json'\n", encoding='utf-8')
    return tmp_path


def _classify(text: str, repo: Path, doc: str = 'docs/guide.md') -> list:
    index = CodeIndex.build(repo)
    lines = text.splitlines()
    return [classify(c, index, lines) for c in extract(text, doc)]


def test_extract_finds_path_citations() -> None:
    found = extract('See `pkg/real.py` for details.', 'docs/guide.md')
    assert [c.token for c in found] == ['pkg/real.py']


def test_extract_ignores_fenced_blocks() -> None:
    text = '```\n`pkg/inside_fence.py`\n```\n`pkg/outside.py`\n'
    assert [c.token for c in extract(text, 'd.md')] == ['pkg/outside.py']


def test_verified_when_path_exists(repo: Path) -> None:
    (verdict,) = _classify('See `pkg/real.py`.', repo)
    assert verdict.verdict == VERIFIED


def test_verified_by_basename_when_path_is_loose(repo: Path) -> None:
    """`real.py` alone is loosely worded, not wrong -- it must not be deleted."""
    (verdict,) = _classify('See `real.py`.', repo)
    assert verdict.verdict == VERIFIED


def test_orphaned_when_nothing_matches(repo: Path) -> None:
    (verdict,) = _classify('See `pkg/ghost_module.py`.', repo)
    assert verdict.verdict == ORPHANED


def test_placeholder_when_prose_says_create(repo: Path) -> None:
    """Regression: docs naming a file the READER creates are not stale."""
    (verdict,) = _classify('Create the entry point (`chat.pipe`).', repo)
    assert verdict.verdict == PLACEHOLDER


def test_placeholder_inside_tree_diagram(repo: Path) -> None:
    """Regression: scaffolding trees name template files, not repo files."""
    text = 'Layout:\n    └── `src/MyApp.tsx`   # client area\n'
    verdicts = [v for v in _classify(text, repo) if v.citation.token == 'src/MyApp.tsx']
    assert verdicts and verdicts[0].verdict == PLACEHOLDER


def test_placeholder_save_this_as(repo: Path) -> None:
    """Regression: 'Save this as X' is a create instruction, not a claim."""
    (verdict,) = _classify('Save this as `extract.pipe`:', repo)
    assert verdict.verdict == PLACEHOLDER


def test_placeholder_naming_illustration(repo: Path) -> None:
    """Regression: 'Examples: `a.pipe`' illustrates a convention."""
    (verdict,) = _classify('**Examples:** `document_processor.pipe`', repo)
    assert verdict.verdict == PLACEHOLDER


def test_counter_example_is_never_orphaned(repo: Path) -> None:
    """Regression: deleting a 'NOT: `x`' line reintroduces the very mistake
    the doc exists to prevent. This is the highest-cost false positive.
    """
    (verdict,) = _classify('- **NOT:** `.json` or `.pipeline.json`', repo)
    assert verdict.verdict == PLACEHOLDER


def test_historical_doc_is_protected(repo: Path) -> None:
    """A changelog naming a deleted file is correct by definition."""
    (verdict,) = _classify('Removed `pkg/deleted_thing.py`.', repo, doc='CHANGELOG.md')
    assert verdict.verdict == HISTORICAL


def test_runtime_path_built_by_code_is_protected(repo: Path) -> None:
    """Regression: a file that only exists at runtime is still documented correctly."""
    (verdict,) = _classify('Writes `built_at_runtime.json`.', repo)
    assert verdict.verdict == RUNTIME
    assert 'pkg/real.py' in verdict.evidence


def _node(root: Path, name: str, fields: dict, readme: str | None) -> Path:
    node = root / 'nodes' / 'src' / 'nodes' / name
    node.mkdir(parents=True)
    (node / 'impl.py').write_text('x = 1\n', encoding='utf-8')
    (node / 'services.json').write_text(json.dumps({'fields': fields}), encoding='utf-8')
    if readme is not None:
        (node / 'README.md').write_text(readme, encoding='utf-8')
    return node


def _block(*keys: str) -> str:
    rows = '\n'.join(f'| `{k}` | `string` | desc | |' for k in keys)
    return f'<!-- ROCKETRIDE:GENERATED:PARAMS START -->\n{rows}\n<!-- ROCKETRIDE:GENERATED:PARAMS END -->\n'


def test_profile_groups_are_not_params(tmp_path: Path) -> None:
    """Regression: `object`/`properties` entries are groupings, not settable params.

    Counting them made 8 clean nodes report phantom drift.
    """
    node = _node(
        tmp_path,
        'grouped',
        {
            'model': {'type': 'string', 'title': 'Model'},
            'grouped.fast': {'object': 'fast', 'properties': ['model']},
        },
        _block('model'),
    )
    assert schema_params(node) == {'model'}
    assert audit_node(node, tmp_path) == []


def test_stale_params_detected_when_block_misses_a_real_param(tmp_path: Path) -> None:
    node = _node(
        tmp_path,
        'drifted',
        {'a': {'type': 'string'}, 'b': {'type': 'boolean'}},
        _block('a'),
    )
    (gap,) = audit_node(node, tmp_path)
    assert gap.kind == STALE_PARAMS
    assert 'b' in gap.detail


def test_missing_doc_for_node_with_code_and_no_readme(tmp_path: Path) -> None:
    node = _node(tmp_path, 'undocumented', {'a': {'type': 'string'}}, readme=None)
    (gap,) = audit_node(node, tmp_path)
    assert gap.kind == MISSING_DOC


def test_node_without_python_is_not_a_gap(tmp_path: Path) -> None:
    node = tmp_path / 'nodes' / 'src' / 'nodes' / 'assets_only'
    node.mkdir(parents=True)
    (node / 'icon.svg').write_text('<svg/>', encoding='utf-8')
    assert audit_node(node, tmp_path) == []


def test_jsonc_services_file_is_parsed(tmp_path: Path) -> None:
    """Regression: several nodes ship `//`-commented schemas. Failing to parse
    them silently reported the node as having zero params, so real drift could
    never surface.
    """
    node = tmp_path / 'nodes' / 'src' / 'nodes' / 'commented'
    node.mkdir(parents=True)
    (node / 'impl.py').write_text('x = 1\n', encoding='utf-8')
    (node / 'services.json').write_text(
        '{\n\t//\n\t// Required:\n\t//\n\t"fields": {"a": {"type": "string"}}\n}\n',
        encoding='utf-8',
    )
    assert schema_params(node) == {'a'}


def test_malformed_schema_is_reported_not_skipped(tmp_path: Path) -> None:
    """Regression: a broken services.json yielded zero declared params, which is
    indistinguishable from a node with nothing to document -- so the audit
    reported the node as clean while hiding whatever the schema really said.
    """
    node = tmp_path / 'nodes' / 'src' / 'nodes' / 'broken'
    node.mkdir(parents=True)
    (node / 'impl.py').write_text('x = 1\n', encoding='utf-8')
    (node / 'services.json').write_text('{"fields": {', encoding='utf-8')
    (node / 'README.md').write_text(_block('a'), encoding='utf-8')

    (gap,) = audit_node(node, tmp_path)
    assert gap.kind == UNREADABLE
    assert 'services.json' in gap.detail


def test_dotfile_paths_keep_their_leading_dot(tmp_path: Path) -> None:
    """Regression: `.lstrip('./')` strips a character SET, not a prefix, so
    `.env` was indexed as `env` and citations to hidden files looked orphaned.
    """
    (tmp_path / '.env').write_text('K=v\n', encoding='utf-8')
    (tmp_path / '.github' / 'workflows').mkdir(parents=True)
    (tmp_path / '.github' / 'workflows' / 'ci.yml').write_text('on: push\n', encoding='utf-8')

    index = CodeIndex.build(tmp_path)
    assert index.has_path('.env')
    assert index.has_path('.github/workflows/ci.yml')
    assert not index.has_path('env')


def test_nonexistent_root_fails_instead_of_passing_green(tmp_path: Path) -> None:
    """A typo in --root must not look like a clean audit."""
    assert main(['--root', str(tmp_path / 'nope'), '--fail-on-orphaned']) == 2


def test_strip_jsonc_keeps_urls_inside_strings() -> None:
    """A `//` inside a quoted value is data, not a comment."""
    kept = strip_jsonc('{"url": "https://example.com/x"} // trailing')
    assert 'https://example.com/x' in kept
    assert 'trailing' not in kept
