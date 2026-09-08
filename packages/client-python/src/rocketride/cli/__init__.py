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
Command Line Interface for the RocketRide client.

Plain, line-oriented CLI kept in exact command parity with the
TypeScript client's ``rocketride`` executable. Every command also
accepts ``--json`` / ``--json=<file>`` for a machine-readable result.

Commands:
    init: Initialize a workspace (login + provisioning)
    login: (Re-)authenticate and save .env credentials
    list / start / stop / upload: Task lifecycle
    store dir/type/write/rm/mkdir/stat: File store operations
    app create/deploy/verify: App lifecycle
    deploy add/list/get/versions/history/publish/run/artifact/
        enable/disable/remove/log/schedule: Deploy lifecycle

For detailed help:
    rocketride --help
    rocketride <command> --help
"""

from .main import main

__all__ = ['main']
