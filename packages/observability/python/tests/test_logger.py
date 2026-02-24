# MIT License
#
# Copyright (c) 2026 RocketRide, Inc.

"""Tests for the structured logger."""

import json
import logging

import pytest

from rocketride_observability import configure_logging, get_logger
from rocketride_observability.logger import _configured


@pytest.fixture(autouse=True)
def _reset_logging():
    """Reset the configured flag and logging state between tests."""
    import rocketride_observability.logger as mod

    mod._configured = False
    # Remove all handlers from root logger
    root = logging.getLogger()
    root.handlers.clear()
    yield
    mod._configured = False
    root.handlers.clear()


def test_get_logger_returns_bound_logger():
    """get_logger should return a structlog logger with standard methods."""
    logger = get_logger('test')
    assert callable(getattr(logger, 'info', None))
    assert callable(getattr(logger, 'debug', None))
    assert callable(getattr(logger, 'warning', None))
    assert callable(getattr(logger, 'error', None))


def test_logger_output_is_valid_json(capsys):
    """Logger output should be valid JSON with expected fields."""
    configure_logging(level=logging.DEBUG)
    logger = get_logger('myapp')
    logger.info('server started', port=8080)

    captured = capsys.readouterr()
    # structlog writes to stderr via our handler
    line = captured.err.strip().split('\n')[-1]
    record = json.loads(line)

    assert record['event'] == 'server started'
    assert record['level'] == 'info'
    assert record['port'] == 8080
    assert 'timestamp' in record


def test_logger_context_binding(capsys):
    """Bound context should appear in every log line."""
    configure_logging(level=logging.DEBUG)
    logger = get_logger('ctx-test', node_id='node-42')
    logger.info('processing')

    captured = capsys.readouterr()
    line = captured.err.strip().split('\n')[-1]
    record = json.loads(line)

    assert record['node_id'] == 'node-42'


def test_logger_pii_scrubbing_in_output(capsys):
    """PII should be scrubbed from log output."""
    configure_logging(level=logging.DEBUG)
    logger = get_logger('pii-test')
    logger.info('user login', email='alice@example.com')

    captured = capsys.readouterr()
    line = captured.err.strip().split('\n')[-1]
    record = json.loads(line)

    assert record['email'] == '***@example.com'
    assert 'alice' not in record['email']


def test_missing_otel_context_produces_empty_trace_fields(capsys):
    """Without OTel instrumentation, trace fields should be empty strings."""
    configure_logging(level=logging.DEBUG)
    logger = get_logger('otel-test')
    logger.info('no trace')

    captured = capsys.readouterr()
    line = captured.err.strip().split('\n')[-1]
    record = json.loads(line)

    assert record.get('trace_id') == ''
    assert record.get('span_id') == ''


def test_configure_logging_is_idempotent():
    """Calling configure_logging multiple times should be safe."""
    configure_logging()
    configure_logging()
    configure_logging()

    root = logging.getLogger()
    # Should only have one handler
    assert len(root.handlers) == 1
