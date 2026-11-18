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

"""
Stand-ins for the engine's native modules (``depends``, ``rocketlib``, ``engLib``).

The e2e server runs the engine's Python web stack (``ai.eaas``) in a plain
interpreter, so the modules the ``engine`` binary would provide are replaced by
inert stubs. Everything the isolation work touches (the shell module, the app
host, the account and its store, the DAP task service) is real Python and runs
unchanged. Anything that needs the native engine (pipeline execution) does not.
"""

import sys
import types


class _Meta(type):
    """Class attributes read as small ints, so ``Lvl.DebugOut`` and friends work."""

    def __getattr__(cls, name):
        if name.startswith('__'):
            raise AttributeError(name)
        return 0


def _stub_class(name):
    return _Meta(name, (), {'__init__': lambda self, *a, **k: None, '__getattr__': lambda self, n: _noop})


def _noop(*_a, **_k):
    return None


class _Mod(types.ModuleType):
    def __getattr__(self, name):
        if name.startswith('__'):
            raise AttributeError(name)
        if name[:1].isupper():
            value = _stub_class(name)
        elif name == 'tool_function':
            value = lambda *a, **k: a[0] if len(a) == 1 and callable(a[0]) and not k else (lambda fn: fn)  # noqa: E731
        else:
            value = _noop
        setattr(self, name, value)
        return value


def install():
    """Register the stubs (idempotent)."""
    for name in ('depends', 'rocketlib', 'engLib'):
        if name not in sys.modules:
            sys.modules[name] = _Mod(name)
