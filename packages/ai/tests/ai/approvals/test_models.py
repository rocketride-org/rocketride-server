# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Unit tests for ai.approvals.models."""

import pytest

from ai.approvals.models import (
    ApprovalDecision,
    ApprovalRequest,
    ApprovalStatus,
    TimeoutAction,
)


class TestTimeoutAction:
    def test_parse_accepts_enum_member(self):
        assert TimeoutAction.parse(TimeoutAction.APPROVE) is TimeoutAction.APPROVE

    def test_parse_accepts_lowercase_string(self):
        assert TimeoutAction.parse('reject') is TimeoutAction.REJECT

    def test_parse_normalizes_whitespace_and_case(self):
        assert TimeoutAction.parse('  ERROR  ') is TimeoutAction.ERROR

    def test_parse_rejects_unknown_values(self):
        with pytest.raises(ValueError, match='timeout_action must be one of'):
            TimeoutAction.parse('shrug')

    def test_parse_rejects_non_string_non_enum(self):
        with pytest.raises(ValueError):
            TimeoutAction.parse(42)


class TestApprovalRequest:
    def test_to_dict_includes_all_fields(self):
        request = ApprovalRequest(
            approval_id='id-1',
            pipeline_id='p',
            node_id='n',
            payload={'text': 'hi'},
            status=ApprovalStatus.PENDING,
            created_at=1.0,
            deadline_at=2.0,
        )
        d = request.to_dict()
        assert d['approval_id'] == 'id-1'
        assert d['payload'] == {'text': 'hi'}
        assert d['status'] == 'pending'
        assert d['deadline_at'] == 2.0
        assert d['decided_by'] is None


class TestApprovalDecision:
    def test_approved_property(self):
        d = ApprovalDecision(status=ApprovalStatus.APPROVED, payload={})
        assert d.approved
        assert not d.rejected
        assert not d.timed_out

    def test_rejected_property(self):
        d = ApprovalDecision(status=ApprovalStatus.REJECTED, payload={})
        assert d.rejected
        assert not d.approved

    def test_timed_out_property(self):
        d = ApprovalDecision(status=ApprovalStatus.TIMED_OUT, payload={})
        assert d.timed_out
        assert not d.approved
        assert not d.rejected
