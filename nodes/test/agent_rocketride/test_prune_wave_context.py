# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Unit tests for RocketRideDriver._prune_wave_context.

These tests exercise the REAL production method on the REAL class (not a stub
or verbatim copy).  Import changes to the algorithm are caught immediately.

Design:
  - ``RocketRideDriver.__new__`` bypasses ``__init__`` (which requires a live
    ``iGlobal`` context) so that the pruning logic can be tested in isolation.
  - Only ``_context_window_waves`` and ``_wave_context_budget_chars`` are set;
    no other driver state is needed by ``_prune_wave_context``.
  - The method now returns a pruned *copy*; the master list passed in must
    remain unchanged.  This invariant is explicitly verified by every test.

Pattern mirrors: nodes/test/astra_db/test_convert_filter.py
"""

from typing import Any

import pytest

# ---------------------------------------------------------------------------
# rocketlib stub — registered once by conftest.py (repo root) before any
# test module is imported.  Do NOT add inline sys.modules patches here;
# that pattern is order-dependent across test files collected in the same
# pytest session.
# ---------------------------------------------------------------------------

from nodes.agent_rocketride.rocketride_agent import RocketRideDriver  # noqa: E402




# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _driver(
    context_window_waves: int = 5,
    wave_context_budget_chars: int = 12_000,
) -> RocketRideDriver:
    """Return a bare RocketRideDriver with only the pruning config set.

    Uses ``__new__`` to skip ``__init__`` (which requires a live iGlobal).
    This mirrors the established pattern in the nodes test suite
    (e.g. ``nodes/test/astra_db/test_convert_filter.py``).
    """
    driver = RocketRideDriver.__new__(RocketRideDriver)
    driver._context_window_waves = context_window_waves
    driver._wave_context_budget_chars = wave_context_budget_chars
    return driver


def _wave(wave_num: int, summary_chars: int = 100) -> dict[str, Any]:
    """Build a synthetic wave entry with a deterministic summary length."""
    return {
        'wave_num': wave_num,
        'calls': [{'tool': 'test.noop', 'args': {}}],
        'results': [
            {
                'tool': 'test.noop',
                'key': f'wave-{wave_num}.r0',
                'summary': 'x' * summary_chars,
            }
        ],
    }


def _build_session(n: int, summary_chars: int = 100) -> list[dict[str, Any]]:
    return [_wave(i, summary_chars) for i in range(n)]


# ---------------------------------------------------------------------------
# Core contract: returns a copy, never mutates master list
# ---------------------------------------------------------------------------


class TestReturnsCopy:
    """_prune_wave_context must return a list and never mutate its argument."""

    def test_returns_a_list(self) -> None:
        driver = _driver()
        waves = _build_session(3)
        result = driver._prune_wave_context(waves)
        assert isinstance(result, list)

    def test_master_list_never_mutated_by_window_eviction(self) -> None:
        """Sliding-window eviction must only affect the returned copy."""
        driver = _driver(context_window_waves=2)
        waves = _build_session(5)
        original_ids = [w['wave_num'] for w in waves]

        driver._prune_wave_context(waves)

        assert [w['wave_num'] for w in waves] == original_ids, (
            'Master waves list was mutated by _prune_wave_context'
        )

    def test_master_list_never_mutated_by_budget_eviction(self) -> None:
        """Character-budget eviction must only affect the returned copy."""
        driver = _driver(context_window_waves=10, wave_context_budget_chars=150)
        # 3 waves * 100 chars = 300 chars -> budget eviction will fire
        waves = _build_session(3, summary_chars=100)
        original_ids = [w['wave_num'] for w in waves]

        driver._prune_wave_context(waves)

        assert [w['wave_num'] for w in waves] == original_ids

    def test_result_is_independent_list_object(self) -> None:
        """The returned list must be a distinct object from the input."""
        driver = _driver()
        waves = _build_session(3)
        result = driver._prune_wave_context(waves)
        assert result is not waves


# ---------------------------------------------------------------------------
# Strategy 1: Sliding window
# ---------------------------------------------------------------------------


class TestSlidingWindow:

    def test_within_window_returns_full_list(self) -> None:
        driver = _driver(context_window_waves=5)
        waves = _build_session(3)
        result = driver._prune_wave_context(waves)
        assert len(result) == 3

    def test_exceeds_window_returns_newest(self) -> None:
        driver = _driver(context_window_waves=3)
        waves = _build_session(6)  # wave_nums 0..5
        result = driver._prune_wave_context(waves)
        assert len(result) == 3
        assert [w['wave_num'] for w in result] == [3, 4, 5]

    def test_window_one_keeps_only_latest(self) -> None:
        driver = _driver(context_window_waves=1)
        waves = _build_session(10)
        result = driver._prune_wave_context(waves)
        assert len(result) == 1
        assert result[0]['wave_num'] == 9

    def test_empty_list_returns_empty(self) -> None:
        driver = _driver()
        result = driver._prune_wave_context([])
        assert result == []

    def test_window_zero_clamped_to_one(self) -> None:
        """window=0 must be clamped to 1; always keeps at least the latest wave."""
        driver = _driver(context_window_waves=0)
        waves = _build_session(5)
        result = driver._prune_wave_context(waves)
        assert len(result) == 1
        assert result[0]['wave_num'] == 4

    def test_negative_window_clamped_to_one(self) -> None:
        driver = _driver(context_window_waves=-10)
        waves = _build_session(5)
        result = driver._prune_wave_context(waves)
        assert len(result) == 1

    def test_window_equals_count_no_eviction(self) -> None:
        driver = _driver(context_window_waves=5)
        waves = _build_session(5)
        result = driver._prune_wave_context(waves)
        assert len(result) == 5


# ---------------------------------------------------------------------------
# Strategy 2: Character budget
# ---------------------------------------------------------------------------


class TestCharacterBudget:

    def test_under_budget_no_eviction(self) -> None:
        """3 waves * 100 chars = 300 chars < 1_000 budget -> no eviction."""
        driver = _driver(context_window_waves=10, wave_context_budget_chars=1_000)
        waves = _build_session(3, summary_chars=100)
        result = driver._prune_wave_context(waves)
        assert len(result) == 3

    def test_over_budget_evicts_oldest_first(self) -> None:
        """3 waves * 300 chars = 900 > 500 budget -> evict until <= 500."""
        driver = _driver(context_window_waves=10, wave_context_budget_chars=500)
        waves = _build_session(3, summary_chars=300)
        result = driver._prune_wave_context(waves)
        # 1 wave * 300 chars = 300 <= 500
        assert len(result) == 1
        assert result[0]['wave_num'] == 2  # newest

    def test_budget_zero_disables_char_limit(self) -> None:
        """budget=0 means unlimited; even massive summaries are not evicted."""
        driver = _driver(context_window_waves=10, wave_context_budget_chars=0)
        waves = _build_session(5, summary_chars=100_000)
        result = driver._prune_wave_context(waves)
        assert len(result) == 5

    def test_single_wave_never_evicted_by_budget(self) -> None:
        """The last remaining wave must never be evicted even if it exceeds budget."""
        driver = _driver(context_window_waves=10, wave_context_budget_chars=10)
        waves = _build_session(1, summary_chars=100_000)
        result = driver._prune_wave_context(waves)
        assert len(result) == 1

    def test_exactly_at_budget_no_eviction(self) -> None:
        """Total chars == budget -> no eviction (boundary condition)."""
        driver = _driver(context_window_waves=10, wave_context_budget_chars=300)
        waves = _build_session(3, summary_chars=100)  # 3 * 100 = 300
        result = driver._prune_wave_context(waves)
        assert len(result) == 3


# ---------------------------------------------------------------------------
# Combined strategy ordering
# ---------------------------------------------------------------------------


class TestCombinedStrategies:

    def test_window_applied_before_budget(self) -> None:
        """Window must reduce list before budget calculation.

        window=2, budget=400, 5 waves * 200 chars each:
          After window: 2 waves = 400 chars -> exactly at budget, no budget eviction.
        """
        driver = _driver(context_window_waves=2, wave_context_budget_chars=400)
        waves = _build_session(5, summary_chars=200)
        result = driver._prune_wave_context(waves)
        assert len(result) == 2
        assert [w['wave_num'] for w in result] == [3, 4]

    def test_large_session_context_stays_bounded(self) -> None:
        """Simulate 10 sequential plan iterations, each appending one wave."""
        driver = _driver(context_window_waves=5, wave_context_budget_chars=12_000)
        master_waves: list[dict[str, Any]] = []

        for i in range(10):
            master_waves.append(_wave(i, summary_chars=500))
            context_waves = driver._prune_wave_context(master_waves)

            # The planning context must always be within the window
            assert len(context_waves) <= 5
            # The master trace must always grow unbounded
            assert len(master_waves) == i + 1
            # Newest wave always present in planning context
            assert context_waves[-1]['wave_num'] == i

    def test_trace_grows_while_context_stays_bounded(self) -> None:
        """Key invariant: master list grows, planning copy stays within window."""
        driver = _driver(context_window_waves=3, wave_context_budget_chars=0)
        master_waves: list[dict[str, Any]] = []

        for i in range(10):
            master_waves.append(_wave(i))

        context = driver._prune_wave_context(master_waves)

        # Master trace has all 10 waves
        assert len(master_waves) == 10
        # Planning context has only the 3 most recent
        assert len(context) == 3
        assert [w['wave_num'] for w in context] == [7, 8, 9]
