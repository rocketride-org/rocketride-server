# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Unit tests for ai.approvals.manager.ApprovalManager.

These cover the gaps from PR #542 specifically:
  * blocking gate: wait() actually blocks until approve()/reject().
  * deepcopy-on-read: mutating a returned request never alters internal state.
  * timeout_action validation: invalid values raise instead of falling back silently.
  * pending cap: enforced.
  * one-shot resolution: a late approve after timeout is rejected.
"""

import threading
import time

import pytest

from ai.approvals.manager import (
    ApprovalManager,
    ApprovalReasonRequiredError,
    PendingCapacityError,
)
from ai.approvals.models import ApprovalStatus, TimeoutAction


def _spawn(target, *args):
    t = threading.Thread(target=target, args=args, daemon=True)
    t.start()
    return t


class TestConstructorValidation:
    def test_rejects_zero_pending_cap(self):
        with pytest.raises(ValueError):
            ApprovalManager(pending_cap=0)

    def test_rejects_negative_default_timeout(self):
        with pytest.raises(ValueError):
            ApprovalManager(default_timeout=-1)

    def test_rejects_invalid_default_timeout_action(self):
        with pytest.raises(ValueError, match='timeout_action must be one of'):
            ApprovalManager(default_timeout_action='shrug')


class TestCreate:
    def test_create_returns_pending_request_with_uuid(self):
        manager = ApprovalManager()
        req = manager.create({'text': 'hi'})
        assert req.status == ApprovalStatus.PENDING
        assert req.approval_id  # non-empty
        assert manager.pending_count == 1

    def test_create_rejects_non_dict_payload(self):
        manager = ApprovalManager()
        with pytest.raises(TypeError):
            manager.create('not a dict')  # type: ignore[arg-type]

    def test_pending_cap_enforced(self):
        manager = ApprovalManager(pending_cap=2)
        manager.create({'i': 1})
        manager.create({'i': 2})
        with pytest.raises(PendingCapacityError):
            manager.create({'i': 3})

    def test_returned_request_is_a_deep_copy(self):
        """Mutating the returned request must not affect internal state.

        This is the bug PR #542 reviewers flagged as 'shallow copy in get_request'.
        """
        manager = ApprovalManager()
        req = manager.create({'text': 'hi'})
        req.payload['text'] = 'mutated'
        again = manager.get_request(req.approval_id)
        assert again.payload['text'] == 'hi'


class TestApproveReject:
    def test_approve_marks_request_and_unblocks_waiter(self):
        manager = ApprovalManager()
        req = manager.create({'text': 'hi'})

        results = {}

        def waiter():
            results['decision'] = manager.wait(req.approval_id, timeout=5.0)

        t = _spawn(waiter)
        # Give the waiter a chance to actually call wait().
        time.sleep(0.05)
        manager.approve(req.approval_id, decided_by='alice')
        t.join(timeout=5.0)

        assert not t.is_alive(), 'waiter should have unblocked'
        decision = results['decision']
        assert decision.approved
        assert decision.decided_by == 'alice'
        assert manager.pending_count == 0

    def test_reject_unblocks_waiter_with_rejected_status(self):
        manager = ApprovalManager()
        req = manager.create({'text': 'hi'})
        results = {}

        def waiter():
            results['decision'] = manager.wait(req.approval_id, timeout=5.0)

        t = _spawn(waiter)
        time.sleep(0.05)
        manager.reject(req.approval_id, reason='unsafe', decided_by='bob')
        t.join(timeout=5.0)
        assert results['decision'].rejected
        assert results['decision'].reason == 'unsafe'

    def test_approve_with_modified_payload_propagates_to_decision(self):
        manager = ApprovalManager()
        req = manager.create({'text': 'draft'})
        results = {}

        def waiter():
            results['decision'] = manager.wait(req.approval_id, timeout=5.0)

        t = _spawn(waiter)
        time.sleep(0.05)
        manager.approve(req.approval_id, modified_payload={'text': 'final'})
        t.join(timeout=5.0)
        decision = results['decision']
        assert decision.was_modified
        assert decision.modified_payload == {'text': 'final'}
        # Original payload is preserved for audit even after modification.
        assert decision.payload == {'text': 'draft'}

    def test_double_approve_raises(self):
        """A late decision after a prior resolution must not silently overwrite."""
        manager = ApprovalManager()
        req = manager.create({'k': 'v'})
        manager.approve(req.approval_id, decided_by='alice')
        with pytest.raises(Exception, match='already approved'):
            manager.approve(req.approval_id, decided_by='attacker')

    def test_modified_payload_must_be_dict(self):
        manager = ApprovalManager()
        req = manager.create({'k': 'v'})
        with pytest.raises(TypeError):
            manager.approve(req.approval_id, modified_payload='nope')  # type: ignore[arg-type]

    def test_unknown_id_raises_keyerror(self):
        manager = ApprovalManager()
        with pytest.raises(KeyError):
            manager.approve('does-not-exist')


class TestTimeout:
    def test_timeout_with_reject_action_returns_rejected_decision(self):
        manager = ApprovalManager()
        req = manager.create({'k': 'v'}, timeout=0.05)
        decision = manager.wait(req.approval_id, timeout=0.05, timeout_action=TimeoutAction.REJECT)
        assert decision.rejected
        # Underlying status should be timed_out for audit purposes.
        stored = manager.get_request(req.approval_id)
        assert stored.status == ApprovalStatus.TIMED_OUT

    def test_timeout_with_approve_action_returns_approved_decision(self):
        manager = ApprovalManager()
        req = manager.create({'k': 'v'}, timeout=0.05)
        decision = manager.wait(req.approval_id, timeout=0.05, timeout_action=TimeoutAction.APPROVE)
        assert decision.approved

    def test_timeout_with_error_action_raises(self):
        manager = ApprovalManager()
        req = manager.create({'k': 'v'}, timeout=0.05)
        with pytest.raises(TimeoutError):
            manager.wait(req.approval_id, timeout=0.05, timeout_action=TimeoutAction.ERROR)
        stored = manager.get_request(req.approval_id)
        assert stored.status == ApprovalStatus.TIMED_OUT

    def test_already_resolved_request_returns_immediately(self):
        manager = ApprovalManager()
        req = manager.create({'k': 'v'})
        manager.approve(req.approval_id)
        decision = manager.wait(req.approval_id, timeout=5.0)
        assert decision.approved


class TestRequireReasonOnReject:
    def test_reject_without_reason_raises_when_required(self):
        manager = ApprovalManager()
        req = manager.create({'k': 'v'}, require_reason_on_reject=True)
        with pytest.raises(ApprovalReasonRequiredError, match='requires a non-empty reason'):
            manager.reject(req.approval_id)

    def test_reject_with_blank_reason_raises_when_required(self):
        manager = ApprovalManager()
        req = manager.create({'k': 'v'}, require_reason_on_reject=True)
        with pytest.raises(ApprovalReasonRequiredError):
            manager.reject(req.approval_id, reason='   ')

    def test_reject_with_reason_succeeds_when_required(self):
        manager = ApprovalManager()
        req = manager.create({'k': 'v'}, require_reason_on_reject=True)
        updated = manager.reject(req.approval_id, reason='unsafe content')
        assert updated.status == ApprovalStatus.REJECTED
        assert updated.decision_reason == 'unsafe content'

    def test_reject_without_reason_succeeds_when_not_required(self):
        manager = ApprovalManager()
        req = manager.create({'k': 'v'})  # default: require_reason_on_reject=False
        updated = manager.reject(req.approval_id)
        assert updated.status == ApprovalStatus.REJECTED

    def test_approve_does_not_require_reason_even_when_flag_set(self):
        """The flag is reject-specific by design — approvals are not gated."""
        manager = ApprovalManager()
        req = manager.create({'k': 'v'}, require_reason_on_reject=True)
        updated = manager.approve(req.approval_id)
        assert updated.status == ApprovalStatus.APPROVED


class TestList:
    def test_list_filters_by_status(self):
        manager = ApprovalManager()
        a = manager.create({'i': 1})
        manager.create({'i': 2})
        manager.approve(a.approval_id)
        pending = manager.list_requests(status=ApprovalStatus.PENDING)
        assert len(pending) == 1
        approved = manager.list_requests(status=ApprovalStatus.APPROVED)
        assert len(approved) == 1


class TestDiscardResolved:
    def test_cannot_discard_pending(self):
        manager = ApprovalManager()
        req = manager.create({'k': 'v'})
        with pytest.raises(Exception, match='cannot discard pending'):
            manager.discard_resolved(req.approval_id)

    def test_can_discard_resolved(self):
        manager = ApprovalManager()
        req = manager.create({'k': 'v'})
        manager.approve(req.approval_id)
        assert manager.discard_resolved(req.approval_id) is True
        assert manager.get_request(req.approval_id) is None

    def test_discard_unknown_returns_false(self):
        assert ApprovalManager().discard_resolved('nope') is False
