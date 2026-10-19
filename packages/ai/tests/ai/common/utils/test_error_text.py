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


def test_an_engine_error_keeps_its_code_and_message_without_the_path():
    assert error_text(_engine_error('Invalid API key.')) == 'Exception: Invalid API key.'


def test_the_code_stays_so_an_error_answer_still_reads_as_one():
    """Discord's sanitizeReplies tells an error answer by a leading "<Name>:" label."""
    assert error_text(_engine_error('Bad credentials.', code='InvalidParam')) == 'InvalidParam: Bad credentials.'


def test_an_engine_error_with_no_message_keeps_its_code_without_the_path():
    assert error_text(_engine_error('')) == 'Exception'


def test_a_message_that_says_at_keeps_it():
    assert error_text(_engine_error('Timed out at (step 3)')) == 'Exception: Timed out at (step 3)'


def test_a_location_that_does_not_match_the_attributes_is_still_dropped():
    exc = _engine_error('Invalid API key.')
    exc.filename = 'elsewhere.py'

    assert error_text(exc) == 'Exception: Invalid API key.'


def test_any_other_exception_is_its_str():
    assert error_text(ValueError('verify_tool is not a connected tool')) == 'verify_tool is not a connected tool'


def test_an_exception_whose_str_raises_gives_an_empty_string():
    class Broken(Exception):
        def __str__(self):
            raise RuntimeError('no')

    assert error_text(Broken()) == ''
