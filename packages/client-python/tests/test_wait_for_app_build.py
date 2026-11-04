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

"""wait_for_app_build polls the version rail until the server build finishes (TS waitForAppBuild twin)."""

import pytest

from rocketride.mixins.apps import AppsMixin


class _FakeRail:
    """Just the list_deployments the waiter polls, replaying canned rails."""

    def __init__(self, *rails):
        self._rails = list(rails)

    async def list_deployments(self, app_id):
        return self._rails.pop(0) if len(self._rails) > 1 else self._rails[0]


def _rail(build_status, state='private'):
    return [{'registryVersion': 2, 'buildStatus': build_status, 'state': state}]


async def test_returns_once_built_reporting_each_status_once():
    fake = _FakeRail(_rail('queued'), _rail('building'), _rail('building'), _rail('ok'))
    statuses = []

    row = await AppsMixin.wait_for_app_build(fake, 'acme.clock', 2, interval=0, on_status=statuses.append)

    assert row['buildStatus'] == 'ok'
    assert statuses == ['queued', 'building', 'ok']


async def test_failed_build_raises_naming_build_log():
    with pytest.raises(RuntimeError, match='failed its server build.*build_log'):
        await AppsMixin.wait_for_app_build(_FakeRail(_rail('failed')), 'acme.clock', 2, interval=0)


async def test_unknown_version_and_timeout_raise():
    with pytest.raises(RuntimeError, match='not found'):
        await AppsMixin.wait_for_app_build(_FakeRail(_rail('building')), 'acme.clock', 9, interval=0)
    with pytest.raises(RuntimeError, match='Timed out'):
        await AppsMixin.wait_for_app_build(_FakeRail(_rail('building')), 'acme.clock', 2, interval=0, timeout=0)
