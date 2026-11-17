# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Entry-point invariant for the bundled pipeline files.

When a pipeline names no top-level ``source``, the task server falls back to
``resolve_implied_source()`` (``packages/ai/src/ai/modules/task/pipeline.py``),
which needs exactly one component with ``config.mode == 'Source'``. With two or
more it raises ``Pipeline has multiple source components, please specify one
explicitly``, so ``client.use(filepath=...)`` without a ``source=`` argument is
refused. That is how ``examples/rag-pipeline.pipe`` shipped broken (#1812).

This checks every ``*.pipe`` under ``examples/`` and ``nodes/src/nodes/``: a
pipeline with more than one Source component must set ``source`` to one of them.
Files are read the way ``client.use(filepath=...)`` reads them (JSON5 when
available, unwrapping a top-level ``pipeline`` key). No server is needed.

Usage:
    pytest nodes/test/test_pipe_sources.py -v
"""

import json
from pathlib import Path

import pytest

try:
    import json5
except ImportError:  # the client falls back to plain JSON the same way
    json5 = None

REPO_ROOT = Path(__file__).resolve().parents[2]
PIPE_ROOTS = (REPO_ROOT / 'examples', REPO_ROOT / 'nodes' / 'src' / 'nodes')


def _bundled_pipes():
    """Every ``*.pipe`` under the bundled roots, as sorted repo-relative paths."""
    return sorted(path.relative_to(REPO_ROOT).as_posix() for root in PIPE_ROOTS for path in root.rglob('*.pipe'))


def _load_pipeline(path: Path) -> dict:
    """Parse a .pipe file as ``client.use(filepath=...)`` does."""
    with open(path, encoding='utf-8') as handle:
        parsed = json5.load(handle) if json5 else json.load(handle)
    return parsed.get('pipeline', parsed) if isinstance(parsed, dict) else parsed


def test_bundled_pipes_are_discovered():
    # Guard against a vacuous pass: an empty parameter set is reported as a
    # skip, not a failure, so a moved directory would silently check nothing.
    for root in PIPE_ROOTS:
        assert any(root.rglob('*.pipe')), f'no .pipe files found under {root}'


@pytest.mark.parametrize('relpath', _bundled_pipes())
def test_multi_source_pipe_names_its_source(relpath):
    pipeline = _load_pipeline(REPO_ROOT / relpath)
    sources = [
        component.get('id')
        for component in pipeline.get('components', [])
        if isinstance(component.get('config'), dict) and component['config'].get('mode') == 'Source'
    ]
    if len(sources) < 2:
        return

    source = pipeline.get('source')
    if not source:
        problem = (
            'but no top-level "source", so client.use(filepath=...) without source= is refused with '
            '"Pipeline has multiple source components".'
        )
    else:
        problem = f'but its top-level "source" is {source!r}, which is not one of them.'
    assert source in sources, (
        f'{relpath} has {len(sources)} Source components {sources} {problem} '
        'Set "source" to the Source component that should start by default.'
    )
