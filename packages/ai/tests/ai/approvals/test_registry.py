# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Unit tests for the process-wide manager registry."""

from ai.approvals import get_manager, reset_manager, set_manager
from ai.approvals.manager import ApprovalManager


def setup_function(_func):
    reset_manager()


def teardown_function(_func):
    reset_manager()


def test_first_get_creates_default_manager():
    m = get_manager()
    assert isinstance(m, ApprovalManager)


def test_subsequent_get_returns_same_instance():
    a = get_manager()
    b = get_manager()
    assert a is b


def test_set_manager_replaces_instance():
    custom = ApprovalManager(pending_cap=7)
    set_manager(custom)
    assert get_manager() is custom


def test_reset_manager_drops_instance():
    a = get_manager()
    reset_manager()
    b = get_manager()
    assert a is not b
