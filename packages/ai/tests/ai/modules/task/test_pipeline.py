"""
Unit tests for ai.modules.task.pipeline.

``resolve_implied_source`` is a pure helper used when a pipeline submission
omits an explicit ``source`` field. It scans every component, returns the id
of the single ``config.mode == 'Source'`` component, and refuses to guess
when the pipeline contains more than one.
"""

import pytest

from ai.modules.task.pipeline import resolve_implied_source


# ---------------------------------------------------------------------------
# Empty / degenerate input
# ---------------------------------------------------------------------------


def test_empty_pipeline_returns_none():
    """A pipeline with no components returns None."""
    assert resolve_implied_source({}) is None


def test_pipeline_with_empty_components_returns_none():
    """``components`` present but empty also returns None."""
    assert resolve_implied_source({'components': []}) is None


def test_pipeline_with_no_source_mode_returns_none():
    """Components without any ``config.mode == 'Source'`` return None."""
    pipeline = {
        'components': [
            {'id': 'a', 'config': {'mode': 'Filter'}},
            {'id': 'b', 'config': {'mode': 'Sink'}},
            {'id': 'c'},  # no config at all
        ],
    }
    assert resolve_implied_source(pipeline) is None


# ---------------------------------------------------------------------------
# Single source component (happy path)
# ---------------------------------------------------------------------------


def test_single_source_returns_its_id():
    """When exactly one component has mode='Source', its id is returned."""
    pipeline = {
        'components': [
            {'id': 'reader', 'config': {'mode': 'Source'}},
            {'id': 'classifier', 'config': {'mode': 'Filter'}},
        ],
    }
    assert resolve_implied_source(pipeline) == 'reader'


def test_single_source_returns_none_if_id_missing():
    """If the source component has no ``id`` field, the function returns None."""
    pipeline = {'components': [{'config': {'mode': 'Source'}}]}
    assert resolve_implied_source(pipeline) is None


def test_source_position_in_list_does_not_matter():
    """The source can appear anywhere in the components list."""
    pipeline = {
        'components': [
            {'id': 'a', 'config': {'mode': 'Filter'}},
            {'id': 'b', 'config': {'mode': 'Filter'}},
            {'id': 'src', 'config': {'mode': 'Source'}},  # last
            {'id': 'c', 'config': {'mode': 'Sink'}},
        ],
    }
    assert resolve_implied_source(pipeline) == 'src'


# ---------------------------------------------------------------------------
# Multiple sources (error path)
# ---------------------------------------------------------------------------


def test_multiple_sources_raises_value_error():
    """A pipeline with more than one source component is ambiguous and rejected."""
    pipeline = {
        'components': [
            {'id': 'src1', 'config': {'mode': 'Source'}},
            {'id': 'src2', 'config': {'mode': 'Source'}},
        ],
    }
    with pytest.raises(ValueError, match='multiple source components'):
        resolve_implied_source(pipeline)


# ---------------------------------------------------------------------------
# Robustness against odd shapes
# ---------------------------------------------------------------------------


def test_component_without_config_is_ignored():
    """Missing ``config`` defaults to empty dict; component contributes nothing."""
    pipeline = {
        'components': [
            {'id': 'no_config'},
            {'id': 'src', 'config': {'mode': 'Source'}},
        ],
    }
    assert resolve_implied_source(pipeline) == 'src'


def test_component_with_empty_mode_is_ignored():
    """Empty-string mode is treated as 'not a source'."""
    pipeline = {
        'components': [
            {'id': 'blank', 'config': {'mode': ''}},
            {'id': 'src', 'config': {'mode': 'Source'}},
        ],
    }
    assert resolve_implied_source(pipeline) == 'src'


@pytest.mark.parametrize('mode_value', ['source', 'SOURCE', 'src', 'Sink'])
def test_mode_match_is_case_sensitive_and_exact(mode_value):
    """Only the literal string 'Source' counts; case / abbreviations do not."""
    pipeline = {'components': [{'id': 'maybe', 'config': {'mode': mode_value}}]}
    assert resolve_implied_source(pipeline) is None
