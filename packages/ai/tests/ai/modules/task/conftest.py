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
Standalone-run shims for task-module unit tests.

The ``ai`` package's import chain reaches modules that only exist in the
assembled dist/server environment (``depends``, ``rocketlib``). Under the
builder-managed test run those are real; when running
``python -m pytest packages/ai/tests/...`` directly against the source tree
they are absent, so this conftest installs inert stand-ins BEFORE the test
modules import ``ai``. Real modules always win: stubs are only registered
when the import is unavailable.
"""

import sys
import types


class _AutoStubMeta(type):
    """Metaclass that returns 0 for any attribute accessed on the class itself."""

    def __getattr__(cls, name: str):
        if name.startswith('_'):
            raise AttributeError(name)
        return 0


class _AutoStubModule(types.ModuleType):
    """Module stub that auto-creates any attribute accessed on it.

    The ``rocketlib`` native extension exports dozens of classes and
    functions; under the builder-managed test run the real .so is on the
    path, but when running directly against the source tree it is absent.
    Rather than enumerate every symbol (fragile), this stub returns a
    dummy type for Capitalised names and a no-op callable for everything
    else, so any ``from rocketlib import X`` succeeds.
    """

    def __getattr__(self, name: str):
        if name.startswith('_'):
            raise AttributeError(name)
        if name and name[0].isupper():
            return _AutoStubMeta(name, (), {})
        return lambda *_args, **_kwargs: None


def _stub_module(name: str, **attrs) -> None:
    """Register an inert module stub for ``name`` if it cannot be imported."""
    if name in sys.modules:
        return
    try:
        __import__(name)
        return
    except ImportError:
        pass
    module = _AutoStubModule(name)
    for key, value in attrs.items():
        setattr(module, key, value)
    sys.modules[name] = module


# dist/server dependency-bootstrap: a no-op satisfies the source tree.
_stub_module('depends', depends=lambda *_args, **_kwargs: None)

# dist/server native extension: classes + helpers used across the import chain.
_stub_module(
    'rocketlib',
    debug=lambda *_args, **_kwargs: None,
    warning=lambda *_args, **_kwargs: None,
    args=lambda *_args, **_kwargs: [],
)
