# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
error_text: an exception's message for text a user reads, without the engine's source path.

The engine turns its own errors into an Exception whose str() ends in
" at (<engine source path>:<line>)" and keeps the bare message in ``message``
(engLib store/python/bindings.cpp). Answers are shown to customers.
"""

from ai.common.utils import error_text


def _engine_error(message: str) -> Exception:
    """An exception shaped the way the engine's translator builds one."""
    exc = Exception(f'Exception: {message} at (/opt/rocketride/ai/common/chat.py:412)')
    setattr(exc, '__formatted', True)
    exc.message = message
    exc.filename = '/opt/rocketride/ai/common/chat.py'
    exc.line = 412
    return exc


def test_an_engine_error_gives_the_bare_message():
    assert error_text(_engine_error('Invalid API key.')) == 'Invalid API key.'


def test_an_engine_error_with_no_message_falls_back_to_str():
    exc = _engine_error('')
    assert error_text(exc) == str(exc)


def test_any_other_exception_is_its_str():
    assert error_text(ValueError('verify_tool is not a connected tool')) == 'verify_tool is not a connected tool'


def test_an_exception_whose_str_raises_gives_an_empty_string():
    class Broken(Exception):
        def __str__(self):
            raise RuntimeError('no')

    assert error_text(Broken()) == ''
