# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""HTTP-level tests for the approvals REST module.

Mounts the routes returned by ``build_routes`` on a bare FastAPI app so we
exercise FastAPI request parsing, validation, and status-code mapping without
pulling in ``ai.web.WebServer`` and its rocketlib transitive imports.
"""

import threading
import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from ai.approvals.manager import ApprovalManager
from ai.approvals.models import ApprovalStatus
from ai.modules.approvals.endpoints import build_routes


@pytest.fixture
def manager() -> ApprovalManager:
    return ApprovalManager()


@pytest.fixture
def client(manager: ApprovalManager) -> TestClient:
    app = FastAPI()
    for path, handler, methods in build_routes(manager):
        app.router.add_api_route(path, handler, methods=methods)
    return TestClient(app)


class TestList:
    def test_empty_list(self, client: TestClient):
        resp = client.get('/approvals')
        assert resp.status_code == 200
        body = resp.json()
        assert body['status'] == 'OK'
        assert body['data']['count'] == 0
        assert body['data']['approvals'] == []

    def test_lists_pending(self, client: TestClient, manager: ApprovalManager):
        manager.create({'k': 1})
        manager.create({'k': 2})
        body = client.get('/approvals').json()
        assert body['data']['count'] == 2

    def test_status_filter(self, client: TestClient, manager: ApprovalManager):
        a = manager.create({'k': 1})
        manager.create({'k': 2})
        manager.approve(a.approval_id)
        body = client.get('/approvals?status=approved').json()
        assert body['data']['count'] == 1
        assert body['data']['approvals'][0]['status'] == 'approved'

    def test_invalid_status_filter_returns_400(self, client: TestClient):
        resp = client.get('/approvals?status=lol')
        assert resp.status_code == 400
        assert 'invalid status filter' in resp.json()['detail']


class TestGet:
    def test_returns_request(self, client: TestClient, manager: ApprovalManager):
        req = manager.create({'text': 'hi'})
        body = client.get(f'/approvals/{req.approval_id}').json()
        assert body['data']['approval_id'] == req.approval_id
        assert body['data']['payload'] == {'text': 'hi'}

    def test_404_when_missing(self, client: TestClient):
        resp = client.get('/approvals/does-not-exist')
        assert resp.status_code == 404


class TestApprove:
    def test_approves_pending_request(self, client: TestClient, manager: ApprovalManager):
        req = manager.create({'text': 'draft'})
        resp = client.post(
            f'/approvals/{req.approval_id}/approve',
            json={'decided_by': 'alice'},
        )
        assert resp.status_code == 200
        assert resp.json()['data']['status'] == 'approved'
        assert resp.json()['data']['decided_by'] == 'alice'

    def test_approve_with_modified_payload(self, client: TestClient, manager: ApprovalManager):
        req = manager.create({'text': 'draft'})
        resp = client.post(
            f'/approvals/{req.approval_id}/approve',
            json={'modified_payload': {'text': 'final'}, 'decided_by': 'bob'},
        )
        assert resp.json()['data']['modified_payload'] == {'text': 'final'}

    def test_approve_unblocks_waiter(self, client: TestClient, manager: ApprovalManager):
        """End-to-end: pipeline thread waits, REST call resolves."""
        req = manager.create({'text': 'draft'})
        results = {}

        def waiter():
            results['decision'] = manager.wait(req.approval_id, timeout=5.0)

        t = threading.Thread(target=waiter, daemon=True)
        t.start()
        time.sleep(0.05)
        resp = client.post(f'/approvals/{req.approval_id}/approve', json={})
        assert resp.status_code == 200
        t.join(timeout=5.0)
        assert not t.is_alive()
        assert results['decision'].approved

    def test_404_when_unknown(self, client: TestClient):
        resp = client.post('/approvals/nope/approve', json={})
        assert resp.status_code == 404

    def test_409_when_already_resolved(self, client: TestClient, manager: ApprovalManager):
        req = manager.create({'k': 'v'})
        manager.approve(req.approval_id)
        resp = client.post(f'/approvals/{req.approval_id}/approve', json={})
        assert resp.status_code == 409

    def test_extra_fields_rejected(self, client: TestClient, manager: ApprovalManager):
        """Pydantic extra='forbid' catches typos in request bodies."""
        req = manager.create({'k': 'v'})
        resp = client.post(
            f'/approvals/{req.approval_id}/approve',
            json={'desided_by': 'typo'},
        )
        assert resp.status_code == 422


class TestReject:
    def test_rejects_with_reason(self, client: TestClient, manager: ApprovalManager):
        req = manager.create({'k': 'v'})
        resp = client.post(
            f'/approvals/{req.approval_id}/reject',
            json={'reason': 'unsafe', 'decided_by': 'reviewer'},
        )
        body = resp.json()['data']
        assert body['status'] == 'rejected'
        assert body['decision_reason'] == 'unsafe'

    def test_404_when_unknown(self, client: TestClient):
        resp = client.post('/approvals/nope/reject', json={})
        assert resp.status_code == 404

    def test_409_when_already_resolved(self, client: TestClient, manager: ApprovalManager):
        req = manager.create({'k': 'v'})
        manager.approve(req.approval_id)
        resp = client.post(f'/approvals/{req.approval_id}/reject', json={})
        assert resp.status_code == 409

    def test_400_when_reason_required_but_missing(self, client: TestClient, manager: ApprovalManager):
        """Compliance: refuse rejection without a reason, distinct status from 409."""
        req = manager.create({'k': 'v'}, require_reason_on_reject=True)
        resp = client.post(f'/approvals/{req.approval_id}/reject', json={})
        assert resp.status_code == 400
        assert 'requires a non-empty reason' in resp.json()['detail']
        # Request must still be PENDING — failed reject does not consume the gate.
        assert manager.get_request(req.approval_id).status == ApprovalStatus.PENDING

    def test_400_when_reason_required_but_blank(self, client: TestClient, manager: ApprovalManager):
        req = manager.create({'k': 'v'}, require_reason_on_reject=True)
        resp = client.post(f'/approvals/{req.approval_id}/reject', json={'reason': '   '})
        assert resp.status_code == 400

    def test_reject_succeeds_with_reason_when_required(self, client: TestClient, manager: ApprovalManager):
        req = manager.create({'k': 'v'}, require_reason_on_reject=True)
        resp = client.post(
            f'/approvals/{req.approval_id}/reject',
            json={'reason': 'fails policy', 'decided_by': 'reviewer'},
        )
        assert resp.status_code == 200
        assert resp.json()['data']['decision_reason'] == 'fails policy'
