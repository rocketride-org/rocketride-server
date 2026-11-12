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
Deployment settings of the shell module, read from the environment in one place.

A leaf module: it imports only the standard library, so every shell module can
import it without a cycle. Each accessor reads the environment when called, so
a deployment change applies to the next build and a test sets the variable
with ``monkeypatch.setenv``. None of them runs per request.
"""

import os
from typing import FrozenSet

# Root claimants when RR_PUBLIC_ROOT_APPS is unset: the home app.
DEFAULT_ROOT_APPS = 'rocketride.home'


def public_root_apps() -> FrozenSet[str]:
    """The app ids allowed to declare root pages.

    Read at publish and at every page map build, never per request.

    Returns:
        The comma-separated ids in ``RR_PUBLIC_ROOT_APPS`` (blanks dropped),
        or the home app when the variable is unset.
    """
    raw = os.environ.get('RR_PUBLIC_ROOT_APPS', DEFAULT_ROOT_APPS)
    return frozenset(a.strip() for a in raw.split(',') if a.strip())
