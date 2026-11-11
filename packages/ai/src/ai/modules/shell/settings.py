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
a test sets the variable with ``monkeypatch.setenv``.
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


def app_url() -> str:
    """
    Return the public base URL of the hosted SaaS deployment, if configured.

    ``RR_APP_URL`` (also honored by ``ai.web.endpoints.auth_callback``) pins
    the externally visible origin and doubles as the "this is the hosted
    SaaS" signal. It is deliberately the ONLY source of absolute URLs here:
    deriving them from ``X-Forwarded-Proto`` / ``X-Forwarded-Host`` would
    let any client poison sitemap URLs through shared caches.

    Returns:
        Base URL without a trailing slash (e.g. ``https://app.example.com``),
        or an empty string when unset.
    """
    return os.environ.get('RR_APP_URL', '').rstrip('/')


def indexnow_key() -> str:
    """The IndexNow key as configured, unvalidated (``indexnow.key`` checks it).

    Read at startup and once per page map build, never per page request.

    Returns:
        ``RR_INDEXNOW_KEY`` with surrounding whitespace stripped, or an empty
        string when unset.
    """
    return os.environ.get('RR_INDEXNOW_KEY', '').strip()
