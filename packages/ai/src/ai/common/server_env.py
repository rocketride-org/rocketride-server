# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""
The server's own settings live under ``RR_*``; ``ROCKETRIDE_*`` is not theirs.

``ROCKETRIDE_*`` is the pipeline-facing namespace and what clients read (the
SDKs, the CLIs and the extension take ``ROCKETRIDE_URI`` and
``ROCKETRIDE_APIKEY``). Every ``ROCKETRIDE_*`` variable in the server's
environment is a value a pipeline may reference (``${ROCKETRIDE_*}``) and one
every engine process inherits, so a setting the server reads for itself is an
``RR_*`` name, which neither reaches.

A retired ``ROCKETRIDE_*`` spelling of a server setting is a hard error at
startup, never a fallback, as ``STORE_URL`` -> ``RR_STORE_URL`` is
(``ai.account.store``): a fallback is never removed, and a value the operator
set that the server silently ignored would be worse than refusing to start.
"""

import os
from typing import Mapping, Optional

# ==== Constants ==================================================================

#: Each retired ``ROCKETRIDE_*`` spelling and the ``RR_*`` setting that replaced it.
RENAMED_SETTINGS = {
    'ROCKETRIDE_MOCK': 'RR_MOCK',
}


# ==== The startup check ==========================================================


def check_server_environment(environ: Optional[Mapping[str, str]] = None) -> None:
    """
    Refuse to start with a retired ``ROCKETRIDE_*`` spelling of a server setting in the environment.

    Called once the server has loaded its ``.env``, before anything reads a
    setting. Engine processes never call it: they read the values the server
    hands them.

    Args:
        environ: The environment to check (default: this process's).

    Raises:
        EnvironmentError: Naming every retired variable that is set and what
            replaced it.
    """
    environ = os.environ if environ is None else environ

    # Step 1: every retired name that is set, with its replacement
    problems = [f'{old} has been renamed to {new}' for old, new in RENAMED_SETTINGS.items() if environ.get(old)]

    # Step 2: one error naming them all, so one restart fixes the whole list
    if problems:
        raise EnvironmentError('; '.join(problems) + ' — update the deployment configuration.')


def mocks_path(environ: Optional[Mapping[str, str]] = None) -> str:
    """
    The test-mock module directory a server or engine runs with (``RR_MOCK``), or ''.

    Args:
        environ: The environment to read (default: this process's).

    Returns:
        The directory, or '' when mocks are off.
    """
    environ = os.environ if environ is None else environ
    return str(environ.get('RR_MOCK') or '')
