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

"""Tests for the task module's initModule wiring."""

import sys
import types
from unittest.mock import MagicMock

import ai.modules.task as task_module
from ai.modules.task import task_metrics


def test_init_module_registers_the_ledger_status_callback(monkeypatch):
    # The tally is process-wide; failure tests in other modules can leave it nonzero.
    monkeypatch.setitem(task_metrics._LEDGER_HEALTH, 'failures', 0)
    monkeypatch.setattr(task_module, 'sweep_spool_root', MagicMock())
    monkeypatch.setattr(task_module, 'TaskServer', MagicMock())
    monkeypatch.setattr(task_module, 'TaskScheduler', MagicMock())

    account_pkg = types.ModuleType('ai.account')
    account_pkg.__path__ = []
    app_build = types.ModuleType('ai.account.app_build')
    app_build.init_worker = MagicMock(return_value=MagicMock())
    monkeypatch.setitem(sys.modules, 'ai.account', account_pkg)
    monkeypatch.setitem(sys.modules, 'ai.account.app_build', app_build)

    server = MagicMock()
    task_module.initModule(server, {})

    server.registerStatusCallback.assert_called_once_with(task_metrics.billing_ledger_status)
    status = {}
    server.registerStatusCallback.call_args.args[0](status)
    assert status['billing']['ledgerWriteFailures'] == 0
