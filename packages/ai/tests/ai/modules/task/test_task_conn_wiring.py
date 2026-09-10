# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""How TaskConn wires its command mixins together.

``TaskConn`` initialises its mixins by hand, calling
``SomeCommands.__init__(self, connection_id, server, transport, **kwargs)``
on each. That only works for a mixin that defines its own three-argument
constructor: one that does not falls through to ``DAPConn.__init__``, which
takes a single positional, and **every connection then dies with a TypeError
before it can serve anything**.

Nothing catches that today, because the command tests all use connection
stand-ins rather than the real class. This pins the invariant instead: a
mixin is either explicitly initialised AND has its own constructor, or it is
neither.
"""

from __future__ import annotations

import inspect
import re
from pathlib import Path

import pytest

from ai.common.dap import DAPConn
from ai.modules.task import task_conn as task_conn_module

#: `SomeCommands.__init__(self, connection_id, ...)` as TaskConn writes it.
_EXPLICIT_INIT = re.compile(r'^\s*(\w+Commands)\.__init__\(self,', re.M)


def _explicitly_initialised() -> list[str]:
    """Mixin class names TaskConn initialises by hand, in source order."""
    source = Path(inspect.getfile(task_conn_module)).read_text(encoding='utf-8')
    return _EXPLICIT_INIT.findall(source)


def test_taskconn_initialises_some_mixins_by_hand():
    """Guards the guard: if the pattern ever changes, this file must too."""
    assert len(_explicitly_initialised()) > 3


@pytest.mark.parametrize('name', _explicitly_initialised())
def test_an_explicitly_initialised_mixin_owns_its_constructor(name):
    mixin = getattr(task_conn_module, name)
    assert '__init__' in mixin.__dict__, (
        f'TaskConn calls {name}.__init__(self, connection_id, server, transport), '
        f'but {name} defines no constructor — that call resolves to '
        f'DAPConn.__init__, which takes one positional argument, and every '
        f'connection dies. Either give {name} the three-argument constructor '
        f'its siblings have, or stop initialising it explicitly.'
    )


@pytest.mark.parametrize('name', _explicitly_initialised())
def test_that_constructor_takes_the_three_arguments_it_is_handed(name):
    signature = inspect.signature(getattr(task_conn_module, name).__init__)
    positional = [
        parameter.name
        for parameter in signature.parameters.values()
        if parameter.kind in (parameter.POSITIONAL_ONLY, parameter.POSITIONAL_OR_KEYWORD)
    ]
    assert positional[:4] == ['self', 'connection_id', 'server', 'transport'], (
        f'{name}.__init__ takes {positional[:4]}, but TaskConn hands it (self, connection_id, server, transport).'
    )


def test_dap_conn_takes_only_module():
    """The reason the rule above exists — the fallback that swallows the call."""
    positional = [
        parameter.name
        for parameter in inspect.signature(DAPConn.__init__).parameters.values()
        if parameter.kind in (parameter.POSITIONAL_ONLY, parameter.POSITIONAL_OR_KEYWORD)
    ]
    assert positional == ['self', 'module']
