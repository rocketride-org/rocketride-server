# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Unit tests for the approval node IInstance.

Mocks rocketlib so the node can be loaded without a built engine. The same
trick is used by other node tests in this directory (e.g. local_text_output).
"""

import sys
import threading
import time
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

# 1. Mock engine-bundled modules before any node import.
mock_rocketlib = MagicMock()
mock_rocketlib.IInstanceBase = type('IInstanceBase', (), {})
mock_rocketlib.IGlobalBase = type('IGlobalBase', (), {})
mock_rocketlib.OPEN_MODE = SimpleNamespace(CONFIG='config', NORMAL='normal')
mock_rocketlib.debug = MagicMock()
sys.modules['rocketlib'] = mock_rocketlib

mock_depends = MagicMock()
mock_depends.depends = MagicMock(return_value=None)
sys.modules['depends'] = mock_depends

# 2. Make ``ai.approvals`` and the node package importable.
REPO_ROOT = Path(__file__).resolve().parent.parent.parent.parent
sys.path.insert(0, str(REPO_ROOT / 'packages' / 'ai' / 'src'))
sys.path.insert(0, str(REPO_ROOT / 'nodes' / 'src' / 'nodes'))

from ai.approvals import (  # noqa: E402
    ApprovalManager,
    TimeoutAction,
    reset_manager,
    set_manager,
)
from approval.IInstance import IInstance  # noqa: E402


class _FakeAnswer:
    """Stand-in for ai.common.schema.Answer.

    Only implements the surface IInstance touches: ``isJson``, ``getJson``,
    ``getText``, ``setJson``, ``setText``. Tests verify that the node:
      * extracts a payload via these getters,
      * calls the corresponding setter when modified_payload is supplied.
    """

    def __init__(self, *, json=None, text=None):
        self._json = json
        self._text = text

    def isJson(self) -> bool:
        return self._json is not None

    def getJson(self):
        return self._json

    def getText(self) -> str:
        return self._text or ''

    def setJson(self, value) -> None:
        self._json = value

    def setText(self, value) -> None:
        self._text = value


def _make_instance(manager: ApprovalManager, **overrides) -> IInstance:
    inst = IInstance()
    iglobal = MagicMock()
    iglobal.manager = manager
    iglobal.profile = overrides.get('profile', 'auto')
    iglobal.timeout_seconds = overrides.get('timeout_seconds', 5.0)
    iglobal.timeout_action = overrides.get('timeout_action', TimeoutAction.REJECT)
    inst.IGlobal = iglobal

    instance_proxy = MagicMock()
    inst.instance = instance_proxy
    return inst


@pytest.fixture(autouse=True)
def _reset_registry():
    reset_manager()
    yield
    reset_manager()


class TestBlockingGate:
    def test_writeAnswers_emits_after_approve(self):
        manager = ApprovalManager()
        set_manager(manager)
        inst = _make_instance(manager)
        answer = _FakeAnswer(text='draft response')

        # Run writeAnswers on a worker; resolve from the main thread.
        thread = threading.Thread(target=inst.writeAnswers, args=(answer,), daemon=True)
        thread.start()

        # Wait for the request to register.
        deadline = time.monotonic() + 2.0
        while manager.pending_count == 0 and time.monotonic() < deadline:
            time.sleep(0.01)
        assert manager.pending_count == 1

        approval_id = manager.list_requests()[0].approval_id
        manager.approve(approval_id, decided_by='reviewer')

        thread.join(timeout=2.0)
        assert not thread.is_alive(), 'pipeline thread should have unblocked'
        inst.instance.writeAnswers.assert_called_once_with(answer)

    def test_writeAnswers_does_not_emit_after_reject(self):
        manager = ApprovalManager()
        set_manager(manager)
        inst = _make_instance(manager)
        answer = _FakeAnswer(text='draft')

        thread = threading.Thread(target=inst.writeAnswers, args=(answer,), daemon=True)
        thread.start()

        deadline = time.monotonic() + 2.0
        while manager.pending_count == 0 and time.monotonic() < deadline:
            time.sleep(0.01)
        approval_id = manager.list_requests()[0].approval_id
        manager.reject(approval_id, reason='unsafe')

        thread.join(timeout=2.0)
        assert not thread.is_alive()
        inst.instance.writeAnswers.assert_not_called()

    def test_modified_payload_is_applied_to_answer(self):
        manager = ApprovalManager()
        set_manager(manager)
        inst = _make_instance(manager)
        answer = _FakeAnswer(text='original')

        thread = threading.Thread(target=inst.writeAnswers, args=(answer,), daemon=True)
        thread.start()

        deadline = time.monotonic() + 2.0
        while manager.pending_count == 0 and time.monotonic() < deadline:
            time.sleep(0.01)
        approval_id = manager.list_requests()[0].approval_id
        manager.approve(approval_id, modified_payload={'text': 'edited'})

        thread.join(timeout=2.0)
        assert not thread.is_alive()
        # Setter was used; emitted answer carries the new text.
        emitted = inst.instance.writeAnswers.call_args.args[0]
        assert emitted.getText() == 'edited'

    def test_json_answer_payload_round_trips(self):
        manager = ApprovalManager()
        set_manager(manager)
        inst = _make_instance(manager)
        answer = _FakeAnswer(json={'verdict': 'unsafe'})

        thread = threading.Thread(target=inst.writeAnswers, args=(answer,), daemon=True)
        thread.start()

        deadline = time.monotonic() + 2.0
        while manager.pending_count == 0 and time.monotonic() < deadline:
            time.sleep(0.01)
        approval_id = manager.list_requests()[0].approval_id

        # The reviewer should see a JSON payload in the registered request.
        stored = manager.get_request(approval_id)
        assert stored.payload == {'json': {'verdict': 'unsafe'}}

        manager.approve(approval_id, modified_payload={'json': {'verdict': 'safe'}})
        thread.join(timeout=2.0)
        emitted = inst.instance.writeAnswers.call_args.args[0]
        assert emitted.getJson() == {'verdict': 'safe'}


class TestTimeoutBehavior:
    def test_timeout_with_reject_action_does_not_emit(self):
        manager = ApprovalManager()
        set_manager(manager)
        inst = _make_instance(manager, timeout_seconds=0.05, timeout_action=TimeoutAction.REJECT)
        inst.writeAnswers(_FakeAnswer(text='ignored'))
        inst.instance.writeAnswers.assert_not_called()

    def test_timeout_with_approve_action_does_emit(self):
        manager = ApprovalManager()
        set_manager(manager)
        inst = _make_instance(manager, timeout_seconds=0.05, timeout_action=TimeoutAction.APPROVE)
        answer = _FakeAnswer(text='allowed-by-timeout')
        inst.writeAnswers(answer)
        inst.instance.writeAnswers.assert_called_once()


class TestPassThrough:
    def test_no_manager_passes_through(self):
        """In CONFIG mode IGlobal sets manager=None — node must not block."""
        inst = _make_instance(MagicMock())  # placeholder manager; we override:
        inst.IGlobal.manager = None
        answer = _FakeAnswer(text='hi')
        inst.writeAnswers(answer)
        inst.instance.writeAnswers.assert_called_once_with(answer)
