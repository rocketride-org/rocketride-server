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
Account package initialiser.

Bootstraps third-party dependencies declared in the local requirements.txt,
selects the correct Account implementation (SaaS vs. OSS), and re-exports
every symbol that downstream modules need from a single import point.

SaaS builds overlay the ``account/auth/`` subpackage at build time.  When that
subpackage is absent the open-source ``account/oss/`` implementation is used
instead so that the rest of the server code never needs to branch on which
edition is running.
"""

import os
from depends import depends

# Resolve the absolute path to this package's requirements file and install
# any missing dependencies before any account submodule is imported.
requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
depends(requirements)


# =============================================================================
# ACCOUNT IMPLEMENTATION
# If --saas is present on the command line, load the SaaS implementation
# (extension/saas/).  Otherwise use the OSS implementation (account/oss/).
# =============================================================================

import sys as _sys

if '--saas' in _sys.argv:
    # SaaS mode explicitly requested — import the SaaS Account class.
    # Raises ImportError loudly if the extension overlay was not deployed.
    from extension.saas import Account  # type: ignore[import]
else:
    # OSS mode — authenticate via ROCKETRIDE_APIKEY environment variable.
    from .oss import Account  # type: ignore[assignment]

# Instantiate the single shared Account object used by the entire process.
# All command handlers import this singleton rather than creating their own.
account: Account = Account()

# Re-export supporting subsystems so callers only need one import.
from .keystore import KeyStore
from .report import Reporter
from .store import Store, IStore, StorageError, VersionMismatchError, STORE_MAX_RETRY_ATTEMPTS, LOG_PAGE_SIZE
from .models import AccountInfo, resolve_team_permissions

__all__ = [
    'Account',
    'AccountInfo',
    'resolve_team_permissions',
    'account',
    'KeyStore',
    'Reporter',
    'Store',
    'IStore',
    'StorageError',
    'VersionMismatchError',
    'STORE_MAX_RETRY_ATTEMPTS',
    'LOG_PAGE_SIZE',
]
