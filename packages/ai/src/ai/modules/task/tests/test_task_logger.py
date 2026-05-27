import sys
from unittest.mock import MagicMock, AsyncMock

# Mock engLib and depends modules before importing any packages
mock_englib = MagicMock()
mock_englib.debug = MagicMock()
mock_englib.monitorStatus = MagicMock()
mock_englib.error = MagicMock()
sys.modules['engLib'] = mock_englib

mock_depends = MagicMock()
sys.modules['depends'] = mock_depends

import json
import logging
import pytest
import traceback
from ai.modules.task.task_logger import get_task_logger, _StructuredFormatter
from ai.modules.task.task_engine import Task


# Test 1: No duplicate handlers
def test_no_duplicate_handlers():
    default_logger = logging.getLogger("test_engine_dup")
    default_logger.handlers.clear()
    logger1 = get_task_logger("test_engine_dup")
    logger2 = get_task_logger("test_engine_dup")
    assert len(logger1.handlers) == 1


# Test 2: Logger isolation by name
def test_logger_isolation():
    logger1 = get_task_logger("engine_A")
    logger2 = get_task_logger("engine_B")
    assert logger1 is not logger2


# Test 3: JSON output is always valid
def test_json_validity():
    logger = get_task_logger("test_json")
    formatter = logger.handlers[0].formatter
    record = logging.LogRecord(
        name="test", level=logging.INFO,
        pathname="", lineno=0,
        msg="test message", args=(), exc_info=None
    )
    output = formatter.format(record)
    parsed = json.loads(output)
    assert "timestamp" in parsed
    assert "level" in parsed
    assert "message" in parsed


# Test 4: Non-serializable extra does not crash formatter
def test_non_serializable_extra():
    logger = get_task_logger("test_serial")
    formatter = logger.handlers[0].formatter
    record = logging.LogRecord(
        name="test", level=logging.ERROR,
        pathname="", lineno=0,
        msg="error", args=(), exc_info=None
    )
    record.__dict__["custom_obj"] = object()  # non-serializable
    output = formatter.format(record)
    assert json.loads(output)  # must not throw


# Test 5: Traceback is list not string
def test_traceback_is_list():
    logger = get_task_logger("test_tb")
    formatter = logger.handlers[0].formatter
    record = logging.LogRecord(
        name="test", level=logging.ERROR,
        pathname="", lineno=0,
        msg="error", args=(), exc_info=None
    )
    record.__dict__["traceback"] = ["line1", "line2"]
    output = formatter.format(record)
    parsed = json.loads(output)
    assert isinstance(parsed.get("traceback"), list)


# Test 6: propagate is False
def test_propagate_false():
    logger = get_task_logger("test_propagate")
    assert logger.propagate is False


# Test 7: termination warning on non-zero exit code
@pytest.mark.asyncio
async def test_termination_log_level():
    mock_server = MagicMock()
    mock_server.assign_port.return_value = 1234
    
    # Instantiate Task with dummy parameters
    task_instance = Task(
        server=mock_server,
        id="test-task-123",
        project_id="proj-123",
        source="source-123",
        token="token-123",
        public_auth="auth-123",
        pipeline={"components": [{"id": "source-123", "config": {}}]},
        launch_args={"noDebug": True},
    )
    
    # Mock logger on task
    task_instance.logger = MagicMock()
    
    # Case 1: exit_code is non-zero
    task_instance._status.exitCode = 1
    task_instance._terminated_called = False
    task_instance._engine_process = None
    
    # Stub asyncio methods that _terminated calls
    task_instance._send_status_update = AsyncMock()
    task_instance._forward_task_event = AsyncMock()
    task_instance._server.broadcast_server_event = AsyncMock()
    
    await task_instance._terminated()
    
    # Assert self.logger.warning was called
    task_instance.logger.warning.assert_called_once()
    task_instance.logger.info.assert_not_called()
    
    # Case 2: exit_code is zero (clean exit)
    task_instance.logger.reset_mock()
    task_instance._terminated_called = False
    task_instance._status.exitCode = 0
    await task_instance._terminated()
    
    # Assert self.logger.info was called
    task_instance.logger.info.assert_called_once()
    task_instance.logger.warning.assert_not_called()
