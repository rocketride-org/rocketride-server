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

"""get_task_status return shape tests — no server required.

The method used to be annotated ``-> TASK_STATUS`` (a pydantic model) while its
docstring and example documented a dict and called ``.get()``, and the body
returned whatever ``call()`` yielded — validated into neither. Callers had to
guess which shape they got.

These tests pin the documented contract: a plain dict. They also pin that
``state`` is an int from ``TASK_STATE``, which the old docstring described as
strings like ``'running'`` — a comparison that could never be true.
"""

import inspect

import pytest

from rocketride.mixins.execution import ExecutionMixin
from rocketride.types.task import TASK_STATE, TASK_STATUS


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


class _ClientShell(ExecutionMixin):
    """Detached client shell: mixin methods available, no socket.

    Returns a canned body from ``call()`` so the response shape can be
    asserted without a transport.
    """

    def __init__(self, body):
        # Deliberately skip DAPClient.__init__ — these tests exercise the
        # return shape, never the connection.
        self._body = body
        self.calls = []

    async def call(self, command, *, token=None, timeout=None, **kwargs):
        """Record the wire call and hand back the canned body."""
        self.calls.append((command, token))
        return self._body


# ---------------------------------------------------------------------------
# Return shape
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_return_value_is_a_dict():
    """A plain dict, not a TASK_STATUS model — the annotation used to lie."""
    shell = _ClientShell({'state': TASK_STATE.RUNNING.value, 'completedCount': 4, 'totalCount': 10})
    status = await shell.get_task_status('task-token')

    assert isinstance(status, dict)
    assert not isinstance(status, TASK_STATUS)


@pytest.mark.asyncio
async def test_documented_get_access_works():
    """The docstring's ``status.get('state')`` path has to work on the real value."""
    shell = _ClientShell({'state': TASK_STATE.RUNNING.value, 'completedCount': 4, 'totalCount': 10})
    status = await shell.get_task_status('task-token')

    assert status.get('state') == TASK_STATE.RUNNING.value
    assert status.get('completedCount') == 4


@pytest.mark.asyncio
async def test_empty_body_does_not_raise():
    """``call()`` falls back to ``{}`` when the response carries no body."""
    shell = _ClientShell({})
    status = await shell.get_task_status('task-token')

    assert status == {}
    assert status.get('state') is None


@pytest.mark.asyncio
async def test_wire_arguments_unchanged():
    """The fix is typing and docs only: the request is still the same one."""
    shell = _ClientShell({'state': TASK_STATE.NONE.value})
    await shell.get_task_status('task-token')

    assert shell.calls == [('rrext_get_task_status', 'task-token')]


# ---------------------------------------------------------------------------
# Annotation
# ---------------------------------------------------------------------------


def test_annotation_is_not_the_model():
    """Re-annotating to TASK_STATUS would send callers back to attribute access."""
    annotation = inspect.signature(ExecutionMixin.get_task_status).return_annotation

    assert annotation is not TASK_STATUS
    assert 'Dict' in str(annotation)


def test_state_is_an_int():
    """``state`` is a TASK_STATE value, not one of the strings the docstring listed."""
    assert isinstance(TASK_STATUS.model_fields['state'].default, int)
