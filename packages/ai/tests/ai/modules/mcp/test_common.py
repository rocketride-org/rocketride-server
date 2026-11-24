# Copyright 2026 Aparavi Software AG. MIT License.
"""Tests for `tools/_common.py`: `load_pipeline` and `CallBudget`."""

import pytest

from ai.modules.mcp.tools._common import CallBudget, load_pipeline


def test_load_pipeline_inline_dict():
    pipeline = {'source': 'a', 'components': []}

    assert load_pipeline({'pipeline': pipeline}) == pipeline


def test_load_pipeline_unwraps_nested_wrapper():
    inner = {'source': 'a', 'components': []}

    assert load_pipeline({'pipeline': {'pipeline': inner}}) == inner


def test_load_pipeline_raises_when_pipeline_missing():
    with pytest.raises(ValueError):
        load_pipeline({})


def test_load_pipeline_ignores_filepath_and_requires_inline():
    """Server-side file reads are removed by design: a ``filepath`` argument
    must never cause a filesystem read — without an inline ``pipeline`` the
    call fails, exactly as if the argument were absent.
    """
    with pytest.raises(ValueError):
        load_pipeline({'filepath': '/etc/passwd'})


def test_load_pipeline_raises_when_not_an_object():
    with pytest.raises(ValueError):
        load_pipeline({'pipeline': ['not', 'an', 'object']})


def test_call_budget_left_shrinks_and_stays_between_floor_and_cap():
    now = [0.0]
    budget = CallBudget(200, clock=lambda: now[0])

    assert budget.left(120) == 120
    now[0] = 150
    assert budget.left(120) == 50
    now[0] = 250
    assert budget.left(120) == 0
    assert budget.left(120, floor=5) == 5
