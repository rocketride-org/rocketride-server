# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
error_text: an exception's text for a user to read, without the engine's source path.

The engine turns its own errors into an Exception whose str() is
"<code>: <message> at (<engine source path>:<line>)" and keeps the path and line in
``filename`` and ``line`` (engLib store/python/bindings.cpp). Answers are shown to customers.
"""

from ai.common.utils import error_text


def _engine_error(message: str, code: str = 'Exception') -> Exception:
    """An exception shaped the way the engine's translator builds one."""
    exc = Exception(f'{code}: {message} at (/opt/rocketride/ai/common/chat.py:412)')
    setattr(exc, '__formatted', True)
    exc.message = message
    exc.filename = '/opt/rocketride/ai/common/chat.py'
    exc.line = 412
    return exc


def _formatted(text: str) -> Exception:
    """An engine error whose whole str() is given."""
    exc = Exception(text)
    setattr(exc, '__formatted', True)
    return exc


def test_an_engine_error_keeps_its_code_and_message_without_the_path():
    assert error_text(_engine_error('Invalid API key.')) == 'Exception: Invalid API key.'


def test_the_code_stays_so_an_error_answer_still_reads_as_one():
    """Discord's sanitizeReplies tells an error answer by a leading "<Name>:" label."""
    assert error_text(_engine_error('Bad credentials.', code='InvalidParam')) == 'InvalidParam: Bad credentials.'


def test_an_engine_error_with_no_message_keeps_its_code_and_colon_without_the_path():
    """Discord's generic error pattern needs the colon after the label."""
    assert error_text(_engine_error('')) == 'Exception:'


def test_a_windows_path_with_parentheses_is_dropped():
    exc = _formatted(r'Exception: Invalid key. at (C:\Program Files (x86)\RocketRide\ai\chat.py:412)')

    assert error_text(exc) == 'Exception: Invalid key.'


def test_the_location_the_engine_gives_without_a_traceback_is_dropped():
    """The engine reports "<Unknown>" and line -1 when it has no usable traceback (engLib python/call.hpp)."""
    assert error_text(_formatted('Exception: Invalid key. at (<Unknown>:-1)')) == 'Exception: Invalid key.'


def test_an_engine_error_that_quotes_another_loses_both_locations():
    exc = _formatted('Exception: tool failed: Exception: Bad. at (/opt/a.py:1) at (/opt/b.py:9)')

    assert error_text(exc) == 'Exception: tool failed: Exception: Bad.'


def test_an_unmarked_exception_that_quotes_an_engine_error_loses_the_path():
    exc = ValueError('due to error: Exception: Bad. at (/opt/rr/chat.py:1)')

    assert error_text(exc) == 'due to error: Exception: Bad.'


def test_an_error_text_given_as_a_string_loses_the_path():
    """A framework event carries the error as str() of the exception."""
    assert error_text('Exception: Bad. at (/opt/rr/chat.py:1)') == 'Exception: Bad.'


def test_a_message_ending_in_a_time_keeps_it():
    assert error_text(ValueError('retry at (10:30)')) == 'retry at (10:30)'


def test_with_type_names_the_exception():
    assert error_text(ValueError('bad input'), with_type=True) == 'ValueError: bad input'


def test_with_type_does_not_label_an_engine_error_twice():
    """The engine's text already opens with its code."""
    assert error_text(_engine_error('Invalid API key.'), with_type=True) == 'Exception: Invalid API key.'


def test_a_message_that_says_at_keeps_it():
    assert error_text(_engine_error('Timed out at (step 3)')) == 'Exception: Timed out at (step 3)'


def test_any_other_exception_is_its_str():
    assert error_text(ValueError('verify_tool is not a connected tool')) == 'verify_tool is not a connected tool'


def test_an_exception_whose_str_raises_gives_an_empty_string():
    class Broken(Exception):
        def __str__(self):
            raise RuntimeError('no')

    assert error_text(Broken()) == ''
