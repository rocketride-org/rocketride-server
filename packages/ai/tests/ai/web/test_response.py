"""
Unit tests for ai.web.response.

This module builds the standardised JSONResponse envelopes that every web
endpoint returns: ``response()`` for success, ``error()`` / ``error_dap()`` for
errors, and ``exception()`` / ``formatException()`` for unhandled exceptions.

The tests construct each response, decode the underlying JSON body, and
assert the shape that downstream consumers (clients, the JS UI, browser
tests) depend on.
"""

import json

import pytest

from ai.web.response import (
    Result,
    ResultError,
    ResultSuccess,
    error,
    error_dap,
    exception,
    formatException,
    response,
)


def _decode_body(json_response):
    """
    Decode a fastapi JSONResponse body into a Python dict.

    Args:
        json_response: a starlette/fastapi Response with a JSON body.

    Returns:
        dict: the decoded body.
    """
    return json.loads(json_response.body.decode('utf-8'))


# ---------------------------------------------------------------------------
# response() — success envelope
# ---------------------------------------------------------------------------


def test_response_default_status_is_200():
    """Without an explicit status, the success envelope is HTTP 200."""
    r = response(data={'x': 1})
    assert r.status_code == 200


def test_response_carries_data_payload():
    """Data dict is round-tripped under the 'data' key with status='OK'."""
    r = response(data={'x': 1, 'y': [1, 2, 3]})
    body = _decode_body(r)
    assert body == {'status': 'OK', 'data': {'x': 1, 'y': [1, 2, 3]}}


def test_response_omits_none_fields():
    """None-valued envelope fields (data, warnings, metrics) are excluded."""
    r = response()
    body = _decode_body(r)
    assert body == {'status': 'OK'}
    assert 'data' not in body
    assert 'warnings' not in body


def test_response_includes_warnings_when_provided():
    """When warnings are passed, they appear under the 'warnings' key."""
    r = response(data={'a': 1}, warnings=['deprecated field'])
    body = _decode_body(r)
    assert body['warnings'] == ['deprecated field']


def test_response_custom_http_status():
    """The httpStatus argument overrides the default 200."""
    r = response(data={'a': 1}, httpStatus=201)
    assert r.status_code == 201


# ---------------------------------------------------------------------------
# error() — generic error envelope
# ---------------------------------------------------------------------------


def test_error_default_status_is_400():
    """Generic errors default to HTTP 400."""
    r = error('boom')
    assert r.status_code == 400


def test_error_basic_message_only():
    """A bare error('msg') call yields {'status': 'Error', 'error': {'error': 'msg'}}."""
    r = error('boom')
    body = _decode_body(r)
    assert body == {'status': 'Error', 'error': {'error': 'boom'}}


def test_error_with_file_and_line():
    """File and lineno enrich the inner error dict."""
    r = error('boom', file='x.py', lineno=42)
    body = _decode_body(r)
    inner = body['error']
    assert inner['error'] == 'boom'
    assert inner['file'] == 'x.py'
    # NOTE: response.error wraps lineno in a 1-tuple — preserve that quirk
    # to avoid surprising any client that already accepts the current shape.
    # The tuple becomes a list after JSON serialisation, so the decoded
    # value MUST be [42], never the bare scalar 42.
    assert inner['lineno'] == [42]


def test_error_custom_http_status():
    """The httpStatus argument overrides 400."""
    r = error('forbidden', httpStatus=403)
    assert r.status_code == 403


# ---------------------------------------------------------------------------
# error_dap() — DAP error envelope
# ---------------------------------------------------------------------------


def test_error_dap_default_400():
    """error_dap() defaults to HTTP 400 like error()."""
    r = error_dap({'message': 'boom'})
    assert r.status_code == 400


def test_error_dap_extracts_message_and_trace():
    """error_dap pulls 'message' + nested 'trace.file' / 'trace.lineno' from the dap packet."""
    r = error_dap({'message': 'task failed', 'trace': {'file': 'task.py', 'lineno': 99}})
    body = _decode_body(r)
    assert body['status'] == 'Error'
    assert body['error']['error'] == 'task failed'
    assert body['error']['file'] == 'task.py'
    assert body['error']['lineno'] == 99


def test_error_dap_falls_back_to_unknown_error():
    """A dap packet with no 'message' key produces 'Unknown error'."""
    r = error_dap({})
    body = _decode_body(r)
    assert body['error']['error'] == 'Unknown error'


def test_error_dap_handles_missing_trace():
    """
    When 'trace' is absent, file and lineno are set to None inside the
    inner ``error`` dict.

    ``model_dump(exclude_none=True)`` only drops None-valued *fields* at the
    Pydantic model level; values inside a nested plain dict (like the
    ``error`` payload here) are preserved as-is. The client can therefore
    rely on the keys always being present.
    """
    r = error_dap({'message': 'boom'})
    body = _decode_body(r)
    assert body['error']['error'] == 'boom'
    assert body['error']['file'] is None
    assert body['error']['lineno'] is None


def test_error_dap_custom_http_status():
    """The httpStatus argument overrides the default 400."""
    r = error_dap({'message': 'gone'}, httpStatus=410)
    assert r.status_code == 410


# ---------------------------------------------------------------------------
# formatException()
# ---------------------------------------------------------------------------


def test_format_exception_plain_uses_traceback():
    """For a plain exception, formatException reads filename and line from the traceback."""
    try:
        raise RuntimeError('plain failure')
    except RuntimeError as e:
        content = formatException(e)
    assert isinstance(content, ResultError)
    body = content.model_dump(exclude_none=True)
    assert body['status'] == 'Error'
    assert body['error']['message'] == 'plain failure'
    # The traceback walk reaches the deepest frame (this test file).
    assert body['error']['file'].endswith('test_response.py')
    assert isinstance(body['error']['lineno'], int)


def test_format_exception_dap_results_branch():
    """An exception with __dap_results__ uses the DAP trace dict, not the traceback."""
    e = RuntimeError('dap failure')
    e.__dap_results__ = {'trace': {'file': 'pipeline.py', 'lineno': 7}}
    content = formatException(e)
    body = content.model_dump(exclude_none=True)
    assert body['error']['message'] == 'dap failure'
    assert body['error']['file'] == 'pipeline.py'
    assert body['error']['lineno'] == 7


def test_format_exception_internal_formatted_branch():
    """An exception with __formatted, .filename, .line, .message uses those fields."""

    class _CustomError(Exception):
        """Stand-in for the project's mapped Error type."""

        __formatted = True

        def __init__(self):
            """Set the message/filename/line attributes formatException expects."""
            super().__init__()
            self.message = 'mapped failure'
            self.filename = '/abs/path/to/widget.py'
            self.line = 11

    e = _CustomError()
    # Bypass Python's name-mangling rule by going through object.__setattr__
    # so the literal attribute name '__formatted' is set on the instance —
    # which is exactly what hasattr(e, '__formatted') in formatException probes for.
    object.__setattr__(e, '__formatted', True)

    content = formatException(e)
    body = content.model_dump(exclude_none=True)
    assert body['error']['message'].endswith('mapped failure')
    # Only the basename is kept.
    assert body['error']['file'] == 'widget.py'
    assert body['error']['lineno'] == 11


def test_format_exception_no_traceback():
    """An exception with no __traceback__ still produces a message-only error."""
    e = RuntimeError('no traceback here')
    e.__traceback__ = None
    content = formatException(e)
    body = content.model_dump(exclude_none=True)
    assert body['error'] == {'message': 'no traceback here'}


# ---------------------------------------------------------------------------
# exception() — wraps formatException() in JSONResponse
# ---------------------------------------------------------------------------


def test_exception_returns_400_json_response():
    """exception() wraps formatException output as an HTTP 400 JSONResponse."""
    try:
        raise ValueError('bad input')
    except ValueError as e:
        r = exception(e)
    assert r.status_code == 400
    body = _decode_body(r)
    assert body['status'] == 'Error'
    assert body['error']['message'] == 'bad input'


# ---------------------------------------------------------------------------
# Pydantic model invariants
# ---------------------------------------------------------------------------


def test_result_success_default_status():
    """ResultSuccess always has status='OK'."""
    assert ResultSuccess().status == 'OK'


def test_result_error_default_status():
    """ResultError always has status='Error'."""
    assert ResultError().status == 'Error'


@pytest.mark.parametrize('status', ['OK', 'Error'])
def test_result_accepts_either_status(status):
    """The base Result model accepts either OK or Error."""
    r = Result(status=status)
    assert r.status == status
