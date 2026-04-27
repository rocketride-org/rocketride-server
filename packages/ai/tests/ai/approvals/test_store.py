# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Unit tests for ai.approvals.store.InMemoryStore."""

from ai.approvals.models import ApprovalRequest, ApprovalStatus
from ai.approvals.store import InMemoryStore


def _make_request(approval_id: str = 'r1', status: ApprovalStatus = ApprovalStatus.PENDING) -> ApprovalRequest:
    return ApprovalRequest(
        approval_id=approval_id,
        pipeline_id=None,
        node_id=None,
        payload={'k': 'v'},
        status=status,
    )


class TestInMemoryStore:
    def test_put_and_get_round_trip(self):
        store = InMemoryStore()
        store.put(_make_request())
        got = store.get('r1')
        assert got is not None
        assert got.approval_id == 'r1'

    def test_get_returns_deep_copy(self):
        store = InMemoryStore()
        original = _make_request()
        store.put(original)
        retrieved = store.get('r1')
        retrieved.payload['k'] = 'mutated'
        # Mutating the retrieved copy must not bleed back into the store.
        again = store.get('r1')
        assert again.payload['k'] == 'v'

    def test_get_missing_returns_none(self):
        assert InMemoryStore().get('nope') is None

    def test_delete_returns_true_when_existed(self):
        store = InMemoryStore()
        store.put(_make_request())
        assert store.delete('r1') is True
        assert store.delete('r1') is False

    def test_list_returns_all_when_no_filter(self):
        store = InMemoryStore()
        store.put(_make_request('r1', ApprovalStatus.PENDING))
        store.put(_make_request('r2', ApprovalStatus.APPROVED))
        ids = sorted(r.approval_id for r in store.list())
        assert ids == ['r1', 'r2']

    def test_list_filters_by_status(self):
        store = InMemoryStore()
        store.put(_make_request('r1', ApprovalStatus.PENDING))
        store.put(_make_request('r2', ApprovalStatus.APPROVED))
        pending = store.list(status=ApprovalStatus.PENDING)
        assert len(pending) == 1 and pending[0].approval_id == 'r1'

    def test_put_replaces_existing(self):
        store = InMemoryStore()
        store.put(_make_request('r1', ApprovalStatus.PENDING))
        store.put(_make_request('r1', ApprovalStatus.APPROVED))
        got = store.get('r1')
        assert got.status == ApprovalStatus.APPROVED
