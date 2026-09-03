# MIT License
#
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.


"""Task failures carry a machine-readable code (#2097).

``build_exception`` copies an exception's ``code`` onto the DAP error packet,
and ``DAPException`` exposes ``code`` / ``hint`` so a caller classifies a
failure without matching the English message.
"""

from rocketride.core.dap_base import DAPBase
from rocketride.core.exceptions import DAPException, PipeException


class _Base(DAPBase):
    """DAPBase with the transport left out: only the packet builders are used."""

    def __init__(self):
        self._seq_counter = 0


class _Coded(RuntimeError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


REQUEST = {'seq': 1, 'command': 'rrext_process'}


def test_build_exception_carries_a_code_when_the_error_has_one():
    """A coded exception reaches the wire with its code beside the message."""
    packet = _Base().build_exception(REQUEST, _Coded('TASK_NOT_REGISTERED', 'Your pipeline is not running'))

    assert packet['success'] is False
    assert packet['message'] == 'Your pipeline is not running'
    assert packet['code'] == 'TASK_NOT_REGISTERED'


def test_build_exception_omits_the_code_for_a_plain_exception():
    """A plain exception still produces the packet it produced before."""
    packet = _Base().build_exception(REQUEST, RuntimeError('boom'))

    assert 'code' not in packet
    assert packet['message'] == 'boom'


def test_build_exception_ignores_a_non_string_code():
    """An unrelated attribute named code cannot inject a non-string into the packet."""
    packet = _Base().build_exception(REQUEST, _Coded(42, 'boom'))

    assert 'code' not in packet


def test_exception_exposes_code_and_hint():
    """The SDK exception surfaces both fields, and the message stays clean."""
    e = PipeException(
        {'message': 'Your pipeline is not running', 'code': 'TASK_NOT_REGISTERED', 'hint': 'Common causes:\n- ...'}
    )

    assert str(e) == 'Your pipeline is not running'
    assert e.code == 'TASK_NOT_REGISTERED'
    assert e.hint.startswith('Common causes:')


def test_exception_code_and_hint_default_to_none():
    """Neither field is required; both read as None when absent."""
    e = DAPException({'message': 'boom'})

    assert e.code is None
    assert e.hint is None
