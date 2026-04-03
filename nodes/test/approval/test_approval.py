# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Unit tests for the Human Approval pipeline node (no engine server required).

Covers:
- ApprovalManager: request creation, status tracking, approve/reject,
  timeout auto-approve/reject, pending list, max-pending cap, thread safety.
- ApprovalNotifier: webhook payload formatting, log entry, URL validation (SSRF).
- IGlobal / IInstance lifecycle and deep-copy mutation prevention.
"""

import sys
import threading
from pathlib import Path
from types import ModuleType
from unittest.mock import Mock, patch

import pytest

# ---------------------------------------------------------------------------
# Bootstrap: stub out rocketlib and ai.common.* so the node can be imported
# without the full engine.
# ---------------------------------------------------------------------------

NODES_SRC = Path(__file__).parent.parent.parent / 'src' / 'nodes'
if str(NODES_SRC) not in sys.path:
    sys.path.insert(0, str(NODES_SRC))


def _stub_rocketlib():
    """Create minimal stubs for rocketlib and ai.common so imports succeed."""
    # -- rocketlib -----------------------------------------------------------
    rocketlib = ModuleType('rocketlib')

    class IGlobalBase:
        IEndpoint = None
        glb = None

        def preventDefault(self):
            raise Exception('No default to prevent')

    class IInstanceBase:
        IEndpoint = None
        IGlobal = None
        instance = None

        def preventDefault(self):
            raise Exception('No default to prevent')

    class Entry:
        pass

    class OPEN_MODE:
        CONFIG = 'config'

    rocketlib.IGlobalBase = IGlobalBase
    rocketlib.IInstanceBase = IInstanceBase
    rocketlib.Entry = Entry
    rocketlib.OPEN_MODE = OPEN_MODE
    rocketlib.debug = lambda *a, **kw: None
    rocketlib.warning = lambda *a, **kw: None

    sys.modules['rocketlib'] = rocketlib
    sys.modules['rocketlib.types'] = ModuleType('rocketlib.types')

    # -- ai.common.schema ---------------------------------------------------
    ai_pkg = ModuleType('ai')
    common_pkg = ModuleType('ai.common')
    schema_mod = ModuleType('ai.common.schema')
    config_mod = ModuleType('ai.common.config')

    class Answer:
        def __init__(self, expectJson=False):
            self._answer = None
            self._expectJson = expectJson

        def setAnswer(self, value):
            self._answer = value

        def isJson(self):
            return isinstance(self._answer, (dict, list))

        def getJson(self):
            return self._answer

        def getText(self):
            if self._answer is None:
                return ''
            return str(self._answer)

    class Config:
        @staticmethod
        def getNodeConfig(_provider, _connConfig):
            return {}

    schema_mod.Answer = Answer
    schema_mod.Doc = Mock
    schema_mod.DocMetadata = Mock
    schema_mod.Question = Mock
    schema_mod.QuestionType = Mock
    config_mod.Config = Config

    ai_pkg.common = common_pkg
    sys.modules['ai'] = ai_pkg
    sys.modules['ai.common'] = common_pkg
    sys.modules['ai.common.schema'] = schema_mod
    sys.modules['ai.common.config'] = config_mod

    return Answer, Config


Answer, Config = _stub_rocketlib()

# Now we can safely import the node code
from approval.approval_manager import ApprovalManager, MAX_PENDING_REQUESTS  # noqa: E402
from approval.notifier import ApprovalNotifier  # noqa: E402
from approval.IGlobal import IGlobal  # noqa: E402
from approval.IInstance import IInstance  # noqa: E402


# ===========================================================================
# ApprovalManager tests
# ===========================================================================


class TestApprovalManagerRequestCreation:
    """Test creating approval requests."""

    def test_request_creates_pending_entry(self):
        mgr = ApprovalManager()
        req = mgr.request_approval('item-1', 'Review this text')
        assert req['status'] == 'pending'
        assert req['item_id'] == 'item-1'
        assert req['content_preview'] == 'Review this text'
        assert req['approval_id']  # UUID assigned

    def test_request_stores_metadata(self):
        mgr = ApprovalManager()
        meta = {'pipeline': 'test', 'step': 3}
        req = mgr.request_approval('item-2', 'content', metadata=meta)
        assert req['metadata'] == meta

    def test_request_truncates_long_content_preview(self):
        mgr = ApprovalManager()
        long_content = 'x' * 1000
        req = mgr.request_approval('item-3', long_content)
        assert len(req['content_preview']) == 500

    def test_request_empty_item_id_raises(self):
        mgr = ApprovalManager()
        with pytest.raises(ValueError, match='item_id must be a non-empty string'):
            mgr.request_approval('', 'content')

    def test_request_none_content_stores_empty_preview(self):
        mgr = ApprovalManager()
        req = mgr.request_approval('item-4', None)
        assert req['content_preview'] == ''

    def test_request_assigns_unique_approval_ids(self):
        mgr = ApprovalManager()
        ids = {mgr.request_approval(f'item-{i}', 'c')['approval_id'] for i in range(50)}
        assert len(ids) == 50  # all unique UUIDs


class TestApprovalManagerStatusTracking:
    """Test status checks and transitions."""

    def test_check_status_returns_pending(self):
        mgr = ApprovalManager()
        req = mgr.request_approval('item-1', 'c')
        assert mgr.check_status(req['approval_id']) == 'pending'

    def test_check_status_unknown_id_raises(self):
        mgr = ApprovalManager()
        with pytest.raises(KeyError):
            mgr.check_status('nonexistent-id')

    def test_get_request_returns_copy(self):
        mgr = ApprovalManager()
        req = mgr.request_approval('item-1', 'c')
        fetched = mgr.get_request(req['approval_id'])
        fetched['status'] = 'tampered'
        assert mgr.check_status(req['approval_id']) == 'pending'


class TestApprovalManagerApproveReject:
    """Test approve/reject workflows."""

    def test_approve_sets_status(self):
        mgr = ApprovalManager()
        req = mgr.request_approval('item-1', 'c')
        result = mgr.approve(req['approval_id'], 'alice', 'Looks good')
        assert result['status'] == 'approved'
        assert result['reviewer'] == 'alice'
        assert result['review_comment'] == 'Looks good'

    def test_reject_sets_status(self):
        mgr = ApprovalManager()
        req = mgr.request_approval('item-1', 'c')
        result = mgr.reject(req['approval_id'], 'bob', 'Needs rework')
        assert result['status'] == 'rejected'
        assert result['reviewer'] == 'bob'
        assert result['review_comment'] == 'Needs rework'

    def test_approve_already_approved_raises(self):
        mgr = ApprovalManager()
        req = mgr.request_approval('item-1', 'c')
        mgr.approve(req['approval_id'], 'alice')
        with pytest.raises(ValueError, match='Cannot approve'):
            mgr.approve(req['approval_id'], 'bob')

    def test_reject_already_rejected_raises(self):
        mgr = ApprovalManager()
        req = mgr.request_approval('item-1', 'c')
        mgr.reject(req['approval_id'], 'alice')
        with pytest.raises(ValueError, match='Cannot reject'):
            mgr.reject(req['approval_id'], 'bob')

    def test_approve_nonexistent_raises(self):
        mgr = ApprovalManager()
        with pytest.raises(KeyError):
            mgr.approve('no-such-id', 'alice')

    def test_reject_nonexistent_raises(self):
        mgr = ApprovalManager()
        with pytest.raises(KeyError):
            mgr.reject('no-such-id', 'alice')

    def test_approve_without_comment(self):
        mgr = ApprovalManager()
        req = mgr.request_approval('item-1', 'c')
        result = mgr.approve(req['approval_id'], 'alice')
        assert result['review_comment'] is None

    def test_reject_without_reason(self):
        mgr = ApprovalManager()
        req = mgr.request_approval('item-1', 'c')
        result = mgr.reject(req['approval_id'], 'bob')
        assert result['review_comment'] is None


class TestApprovalManagerRequireComment:
    """Test require_comment enforcement."""

    def test_approve_without_comment_raises_when_required(self):
        mgr = ApprovalManager(require_comment=True)
        req = mgr.request_approval('item-1', 'c')
        with pytest.raises(ValueError, match='comment is required'):
            mgr.approve(req['approval_id'], 'alice')

    def test_approve_with_empty_comment_raises_when_required(self):
        mgr = ApprovalManager(require_comment=True)
        req = mgr.request_approval('item-1', 'c')
        with pytest.raises(ValueError, match='comment is required'):
            mgr.approve(req['approval_id'], 'alice', comment='')

    def test_approve_with_comment_succeeds_when_required(self):
        mgr = ApprovalManager(require_comment=True)
        req = mgr.request_approval('item-1', 'c')
        result = mgr.approve(req['approval_id'], 'alice', comment='Looks good')
        assert result['status'] == 'approved'
        assert result['review_comment'] == 'Looks good'

    def test_reject_without_reason_raises_when_required(self):
        mgr = ApprovalManager(require_comment=True)
        req = mgr.request_approval('item-1', 'c')
        with pytest.raises(ValueError, match='reason is required'):
            mgr.reject(req['approval_id'], 'bob')

    def test_reject_with_reason_succeeds_when_required(self):
        mgr = ApprovalManager(require_comment=True)
        req = mgr.request_approval('item-1', 'c')
        result = mgr.reject(req['approval_id'], 'bob', reason='Needs rework')
        assert result['status'] == 'rejected'
        assert result['review_comment'] == 'Needs rework'

    def test_require_comment_false_allows_no_comment(self):
        mgr = ApprovalManager(require_comment=False)
        req = mgr.request_approval('item-1', 'c')
        result = mgr.approve(req['approval_id'], 'alice')
        assert result['status'] == 'approved'
        assert result['review_comment'] is None


class TestApprovalManagerTimeout:
    """Test timeout auto-approve and auto-reject."""

    def test_timeout_auto_approve(self):
        mgr = ApprovalManager(timeout_seconds=0, timeout_action='approve')
        req = mgr.request_approval('item-1', 'c')
        # Checking status should trigger timeout resolution
        status = mgr.check_status(req['approval_id'])
        assert status == 'approved'

    def test_timeout_auto_reject(self):
        mgr = ApprovalManager(timeout_seconds=0, timeout_action='reject')
        req = mgr.request_approval('item-1', 'c')
        status = mgr.check_status(req['approval_id'])
        assert status == 'rejected'

    def test_timeout_sets_reviewer_to_timeout_sentinel(self):
        mgr = ApprovalManager(timeout_seconds=0, timeout_action='approve')
        req = mgr.request_approval('item-1', 'c')
        mgr.check_status(req['approval_id'])
        fetched = mgr.get_request(req['approval_id'])
        assert fetched['reviewer'] == '__timeout__'

    def test_no_timeout_when_within_deadline(self):
        mgr = ApprovalManager(timeout_seconds=9999, timeout_action='reject')
        req = mgr.request_approval('item-1', 'c')
        assert mgr.check_status(req['approval_id']) == 'pending'

    def test_approve_after_timeout_raises(self):
        mgr = ApprovalManager(timeout_seconds=0, timeout_action='reject')
        req = mgr.request_approval('item-1', 'c')
        mgr.check_status(req['approval_id'])  # trigger timeout
        with pytest.raises(ValueError, match='Cannot approve'):
            mgr.approve(req['approval_id'], 'alice')


class TestApprovalManagerPendingList:
    """Test listing pending approvals."""

    def test_list_pending_returns_only_pending(self):
        mgr = ApprovalManager()
        r1 = mgr.request_approval('item-1', 'c')
        r2 = mgr.request_approval('item-2', 'c')
        mgr.approve(r1['approval_id'], 'alice')
        pending = mgr.list_pending()
        assert len(pending) == 1
        assert pending[0]['approval_id'] == r2['approval_id']

    def test_list_pending_empty_when_none(self):
        mgr = ApprovalManager()
        assert mgr.list_pending() == []

    def test_list_pending_resolves_timeouts(self):
        mgr = ApprovalManager(timeout_seconds=0, timeout_action='approve')
        mgr.request_approval('item-1', 'c')
        # After list_pending, the timed-out item should be resolved
        assert mgr.list_pending() == []

    def test_max_pending_cap(self):
        mgr = ApprovalManager()
        # Fill to capacity
        for i in range(MAX_PENDING_REQUESTS):
            mgr.request_approval(f'item-{i}', 'c')
        with pytest.raises(ValueError, match='Maximum pending requests'):
            mgr.request_approval('one-too-many', 'c')


class TestApprovalManagerThreadSafety:
    """Test concurrent access to ApprovalManager."""

    def test_concurrent_requests_no_race(self):
        mgr = ApprovalManager()
        errors = []

        def create_requests(start):
            try:
                for i in range(100):
                    mgr.request_approval(f'thread-{start}-item-{i}', f'content-{i}')
            except Exception as e:
                errors.append(e)

        threads = [threading.Thread(target=create_requests, args=(t,)) for t in range(5)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert not errors
        assert len(mgr.list_pending()) == 500

    def test_concurrent_approve_reject_no_crash(self):
        mgr = ApprovalManager()
        reqs = [mgr.request_approval(f'item-{i}', 'c') for i in range(50)]
        errors = []

        def approve_half():
            try:
                for r in reqs[:25]:
                    mgr.approve(r['approval_id'], 'alice')
            except Exception as e:
                errors.append(e)

        def reject_half():
            try:
                for r in reqs[25:]:
                    mgr.reject(r['approval_id'], 'bob')
            except Exception as e:
                errors.append(e)

        t1 = threading.Thread(target=approve_half)
        t2 = threading.Thread(target=reject_half)
        t1.start()
        t2.start()
        t1.join()
        t2.join()

        assert not errors
        assert mgr.list_pending() == []


# ===========================================================================
# ApprovalNotifier tests
# ===========================================================================


class TestApprovalNotifierWebhook:
    """Test webhook payload formatting and validation."""

    @staticmethod
    def _fake_public_getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
        """Return a fake public IP for DNS resolution in tests."""
        import socket as _sock

        return [(_sock.AF_INET, _sock.SOCK_STREAM, 6, '', ('93.184.216.34', 0))]

    def test_webhook_payload_structure(self):
        notifier = ApprovalNotifier(notification_type='webhook', webhook_url='https://hooks.example.com/approve')
        req = {
            'approval_id': 'abc-123',
            'item_id': 'item-1',
            'content_preview': 'hello',
            'metadata': {'key': 'val'},
            'status': 'pending',
            'timeout_seconds': 3600,
            'timeout_action': 'approve',
        }
        with patch('approval.notifier.urllib.request.urlopen'), patch('approval.notifier.socket.getaddrinfo', side_effect=self._fake_public_getaddrinfo):
            payload = notifier.notify(req)
        assert payload['event'] == 'approval_requested'
        assert payload['approval_id'] == 'abc-123'
        assert payload['webhook_url'] == 'https://hooks.example.com/approve'

    def test_webhook_actually_sends_http_post(self):
        notifier = ApprovalNotifier(notification_type='webhook', webhook_url='https://hooks.example.com/approve')
        req = {
            'approval_id': 'abc-123',
            'item_id': 'item-1',
            'content_preview': 'hello',
            'metadata': {},
            'status': 'pending',
            'timeout_seconds': 3600,
            'timeout_action': 'approve',
        }
        with patch('approval.notifier.urllib.request.urlopen') as mock_urlopen, patch('approval.notifier.socket.getaddrinfo', side_effect=self._fake_public_getaddrinfo):
            notifier.notify(req)
            mock_urlopen.assert_called_once()
            call_args = mock_urlopen.call_args
            posted_request = call_args[0][0]
            assert posted_request.method == 'POST'
            assert posted_request.get_header('Content-type') == 'application/json'

    def test_webhook_delivery_failure_does_not_raise(self):
        notifier = ApprovalNotifier(notification_type='webhook', webhook_url='https://hooks.example.com/approve')
        req = {'approval_id': 'abc-123', 'item_id': 'item-1', 'status': 'pending'}
        with patch('approval.notifier.urllib.request.urlopen', side_effect=Exception('connection refused')), patch('approval.notifier.socket.getaddrinfo', side_effect=self._fake_public_getaddrinfo):
            # Should not raise -- delivery failures are logged only
            payload = notifier.notify(req)
        assert payload['approval_id'] == 'abc-123'

    def test_webhook_dns_rebinding_private_ip_blocked(self):
        """DNS rebinding: hostname resolves to a private IP -> blocked."""
        import socket as _sock

        def _fake_private_getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
            return [(_sock.AF_INET, _sock.SOCK_STREAM, 6, '', ('10.0.0.1', 0))]

        notifier = ApprovalNotifier(notification_type='webhook', webhook_url='https://hooks.example.com/approve')
        req = {'approval_id': 'abc-123', 'item_id': 'item-1', 'status': 'pending'}
        with patch('approval.notifier.socket.getaddrinfo', side_effect=_fake_private_getaddrinfo), pytest.raises(ValueError, match='blocked address'):
            notifier.notify(req)

    def test_webhook_dns_resolution_failure_raises(self):
        """Unresolvable hostname raises ValueError."""
        import socket as _sock

        notifier = ApprovalNotifier(notification_type='webhook', webhook_url='https://hooks.example.com/approve')
        req = {'approval_id': 'abc-123', 'item_id': 'item-1', 'status': 'pending'}
        with patch('approval.notifier.socket.getaddrinfo', side_effect=_sock.gaierror('fake')), pytest.raises(ValueError, match='Cannot resolve'):
            notifier.notify(req)

    def test_webhook_missing_url_raises(self):
        with pytest.raises(ValueError, match='webhook_url is required'):
            ApprovalNotifier(notification_type='webhook', webhook_url=None)

    def test_webhook_empty_url_raises(self):
        with pytest.raises(ValueError, match='webhook_url is required'):
            ApprovalNotifier(notification_type='webhook', webhook_url='')

    def test_webhook_non_http_scheme_raises(self):
        with pytest.raises(ValueError, match='scheme must be http or https'):
            ApprovalNotifier(notification_type='webhook', webhook_url='ftp://evil.com/hook')

    def test_webhook_localhost_blocked(self):
        with pytest.raises(ValueError, match='loopback'):
            ApprovalNotifier(notification_type='webhook', webhook_url='http://localhost/hook')

    def test_webhook_127_blocked(self):
        with pytest.raises(ValueError, match='loopback'):
            ApprovalNotifier(notification_type='webhook', webhook_url='http://127.0.0.1/hook')

    def test_webhook_private_10_blocked(self):
        with pytest.raises(ValueError, match='private network'):
            ApprovalNotifier(notification_type='webhook', webhook_url='http://10.0.0.1/hook')

    def test_webhook_private_192_168_blocked(self):
        with pytest.raises(ValueError, match='private network'):
            ApprovalNotifier(notification_type='webhook', webhook_url='http://192.168.1.1/hook')

    def test_webhook_private_172_16_blocked(self):
        with pytest.raises(ValueError, match='private network'):
            ApprovalNotifier(notification_type='webhook', webhook_url='http://172.16.0.1/hook')


class TestApprovalNotifierLog:
    """Test log notification channel."""

    def test_log_entry_structure(self):
        notifier = ApprovalNotifier(notification_type='log')
        req = {
            'approval_id': 'abc-123',
            'item_id': 'item-1',
            'content_preview': 'hello',
            'status': 'pending',
        }
        entry = notifier.notify(req)
        assert entry['event'] == 'approval_requested'
        assert entry['approval_id'] == 'abc-123'
        assert entry['item_id'] == 'item-1'


class TestApprovalNotifierNone:
    """Test the 'none' notification channel."""

    def test_none_returns_none(self):
        notifier = ApprovalNotifier(notification_type='none')
        assert notifier.notify({'approval_id': 'x'}) is None

    def test_invalid_type_raises(self):
        with pytest.raises(ValueError, match='Invalid notification_type'):
            ApprovalNotifier(notification_type='email')


# ===========================================================================
# IGlobal lifecycle tests
# ===========================================================================


class TestIGlobalLifecycle:
    """Test IGlobal initialisation and teardown."""

    def _make_iglobal(self, config=None):
        iglobal = IGlobal()
        iglobal.glb = Mock()
        iglobal.glb.logicalType = 'approval'
        iglobal.glb.connConfig = config or {}

        with patch.object(Config, 'getNodeConfig', return_value=config or {}):
            iglobal.beginGlobal()
        return iglobal

    def test_begin_creates_manager_and_notifier(self):
        iglobal = self._make_iglobal()
        assert iglobal.approval_manager is not None
        assert iglobal.notifier is not None

    def test_begin_reads_auto_approve(self):
        iglobal = self._make_iglobal({'auto_approve': True})
        assert iglobal.auto_approve is True

    def test_begin_default_notification_is_log(self):
        iglobal = self._make_iglobal()
        assert iglobal.notifier._notification_type == 'log'

    def test_begin_invalid_timeout_action_defaults_to_approve(self):
        iglobal = self._make_iglobal({'timeout_action': 'ignore'})
        assert iglobal.approval_manager._timeout_action == 'approve'

    def test_begin_valid_timeout_action_reject(self):
        iglobal = self._make_iglobal({'timeout_action': 'reject'})
        assert iglobal.approval_manager._timeout_action == 'reject'

    def test_begin_invalid_timeout_seconds_defaults(self):
        iglobal = self._make_iglobal({'timeout_seconds': 'not-a-number'})
        assert iglobal.approval_manager._timeout_seconds == 3600

    def test_end_clears_manager_and_notifier(self):
        iglobal = self._make_iglobal()
        iglobal.endGlobal()
        assert iglobal.approval_manager is None
        assert iglobal.notifier is None


# ===========================================================================
# IInstance tests
# ===========================================================================


def _make_instance(auto_approve=False, timeout_seconds=3600, notification_type='log'):
    """Create an IInstance wired to a mock IGlobal."""
    inst = IInstance()

    iglobal = Mock()
    iglobal.auto_approve = auto_approve
    iglobal.approval_manager = ApprovalManager(timeout_seconds=timeout_seconds, timeout_action='approve')
    iglobal.notifier = ApprovalNotifier(notification_type=notification_type)

    inst.IGlobal = iglobal

    # Mock the engine instance that receives forwarded answers
    inst.instance = Mock()
    inst.instance.writeAnswers = Mock()

    return inst


class TestIInstanceAutoApprove:
    """Test auto-approve pass-through mode."""

    def test_auto_approve_forwards_approved_answer(self):
        inst = _make_instance(auto_approve=True)
        answer = Answer(expectJson=True)
        answer.setAnswer({'result': 42})

        inst.writeAnswers(answer)

        inst.instance.writeAnswers.assert_called_once()
        forwarded = inst.instance.writeAnswers.call_args[0][0]
        data = forwarded.getJson()
        assert data['status'] == 'approved'
        assert data['reviewer'] == '__auto__'
        assert data['content'] == {'result': 42}

    def test_auto_approve_text_answer(self):
        inst = _make_instance(auto_approve=True)
        answer = Answer()
        answer.setAnswer('plain text response')

        inst.writeAnswers(answer)

        forwarded = inst.instance.writeAnswers.call_args[0][0]
        data = forwarded.getJson()
        assert data['status'] == 'approved'
        assert data['content'] == 'plain text response'


class TestIInstanceManualMode:
    """Test manual review mode."""

    def test_manual_forwards_pending_answer(self):
        inst = _make_instance(auto_approve=False)
        answer = Answer(expectJson=True)
        answer.setAnswer({'result': 42})

        inst.writeAnswers(answer)

        inst.instance.writeAnswers.assert_called_once()
        forwarded = inst.instance.writeAnswers.call_args[0][0]
        data = forwarded.getJson()
        assert data['status'] == 'pending'
        assert 'approval_id' in data
        assert data['content'] == {'result': 42}

    def test_manual_creates_approval_request(self):
        inst = _make_instance(auto_approve=False)
        answer = Answer(expectJson=True)
        answer.setAnswer({'result': 42})

        inst.writeAnswers(answer)

        forwarded = inst.instance.writeAnswers.call_args[0][0]
        approval_id = forwarded.getJson()['approval_id']
        # Verify the request exists in the manager
        status = inst.IGlobal.approval_manager.check_status(approval_id)
        assert status == 'pending'


class TestIInstanceDeepCopy:
    """Verify deep-copy prevents mutation of the original answer."""

    def test_original_answer_not_mutated(self):
        inst = _make_instance(auto_approve=True)
        original_data = {'result': [1, 2, 3], 'nested': {'key': 'value'}}
        answer = Answer(expectJson=True)
        answer.setAnswer(original_data)

        inst.writeAnswers(answer)

        # The original answer should still be untouched
        assert answer.getJson() == {'result': [1, 2, 3], 'nested': {'key': 'value'}}

    def test_forwarded_answer_is_independent(self):
        inst = _make_instance(auto_approve=False)
        answer = Answer(expectJson=True)
        answer.setAnswer({'items': [1, 2]})

        inst.writeAnswers(answer)

        # Mutate the original
        answer.getJson()['items'].append(999)

        # Forwarded answer should not be affected
        forwarded = inst.instance.writeAnswers.call_args[0][0]
        assert 999 not in forwarded.getJson().get('content', {}).get('items', [])


class TestIInstanceOpen:
    """Test the open() lifecycle method."""

    def test_open_does_not_raise(self):
        inst = _make_instance()
        entry = Mock()
        inst.open(entry)  # Should not raise
