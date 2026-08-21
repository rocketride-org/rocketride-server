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
CLI command implementations.

Each module exposes async ``run_*`` entry points dispatched from
``cli.main``; all of them route their output through the shared
``Output`` channel so human and ``--json`` modes behave identically.

Modules:
    auth: ``login`` and ``init``
    tasks: ``start``, ``stop``, ``upload``, ``list``
    store: ``store`` subcommands
    app: ``app`` subcommands
    deploy: ``deploy`` subcommands
"""

from .app import run_app
from .auth import run_init, run_login
from .deploy import run_deploy
from .store import run_store
from .tasks import run_list, run_start, run_stop, run_upload

__all__ = [
    'run_app',
    'run_deploy',
    'run_init',
    'run_list',
    'run_login',
    'run_start',
    'run_stop',
    'run_store',
    'run_upload',
]
