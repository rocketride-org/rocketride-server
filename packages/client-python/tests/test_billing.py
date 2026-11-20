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

"""Wire compatibility and retry identity for billing actions."""

from unittest.mock import AsyncMock, call

import pytest

from rocketride.billing import BillingApi


@pytest.mark.asyncio
async def test_omitted_attempt_preserves_legacy_wire_payloads():
    client = AsyncMock()
    billing = BillingApi(client)
    await billing.create_checkout_session('org-1', 'app-1', 'price-1', 'SUMMER')
    await billing.redeem_promo_code('org-1', 'GRANT')

    assert client.call.await_args_list == [
        call(
            'rrext_account_billing',
            subcommand='subscribe',
            orgId='org-1',
            appId='app-1',
            priceId='price-1',
            promotionCode='SUMMER',
        ),
        call('rrext_account_billing', subcommand='promo_redeem', orgId='org-1', code='GRANT'),
    ]


@pytest.mark.parametrize('action', ['subscribe', 'promo_redeem'])
@pytest.mark.asyncio
async def test_same_attempt_identifier_is_forwarded_on_retry(action):
    attempt_id = 'adad1fc37c3f45158d2175d1c55421ba'
    client = AsyncMock()
    response = {'status': 'active'}
    client.call.side_effect = [TimeoutError('response lost'), response]
    billing = BillingApi(client)
    if action == 'subscribe':
        invoke = billing.create_checkout_session
        arguments = ('org-1', 'app-1', 'price-1')
        payload = {'appId': 'app-1', 'priceId': 'price-1'}
    else:
        invoke = billing.redeem_promo_code
        arguments = ('org-1', 'GRANT')
        payload = {'code': 'GRANT'}

    with pytest.raises(TimeoutError, match='response lost'):
        await invoke(*arguments, attempt_id=attempt_id)
    assert await invoke(*arguments, attempt_id=attempt_id) == response

    expected = call('rrext_account_billing', subcommand=action, orgId='org-1', attemptId=attempt_id, **payload)
    assert client.call.await_args_list == [expected, expected]
