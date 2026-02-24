# MIT License
#
# Copyright (c) 2025 RocketRide Corporation
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
Chargebee metered usage reporting client.

Reports compute-token consumption to Chargebee's Usage API so that
subscriptions are billed accurately at the end of each billing cycle.
"""

import os
import asyncio
import httpx
from rocketlib import debug

from ai.constants import (
    CONST_BILLING_API_TIMEOUT,
    CONST_CHARGEBEE_ITEM_PRICE_ID,
    CONST_CHARGEBEE_USAGE_RETRY_COUNT,
    CONST_CHARGEBEE_USAGE_RETRY_DELAY,
)


class ChargebeeClient:
    """
    Async client for reporting metered usage to Chargebee.

    Reads configuration from constructor arguments or environment variables.
    If either ``site`` or ``api_key`` is missing the client silently disables
    itself so that local / test environments work without Chargebee credentials.

    Usage::

        client = ChargebeeClient()
        await client.report_usage(subscription_id='sub_abc', quantity=1500)
    """

    def __init__(self, site: str = '', api_key: str = '') -> None:
        """
        Initialize the Chargebee client.

        Args:
            site: Chargebee site name (falls back to ``CHARGEBEE_SITE`` env var).
            api_key: Chargebee API key (falls back to ``CHARGEBEE_API_KEY`` env var).
        """
        self._site = site or os.environ.get('CHARGEBEE_SITE', '')
        self._api_key = api_key or os.environ.get('CHARGEBEE_API_KEY', '')
        self._item_price_id = os.environ.get(
            'CHARGEBEE_ITEM_PRICE_ID', CONST_CHARGEBEE_ITEM_PRICE_ID
        )
        self.enabled = bool(self._site and self._api_key)

    async def report_usage(
        self, subscription_id: str, quantity: int, usage_date: str = ''
    ) -> None:
        """
        Report metered usage for a subscription.

        Args:
            subscription_id: The Chargebee subscription identifier.
            quantity: Number of compute tokens consumed.
            usage_date: Optional ISO date string (``YYYY-MM-DD``). Chargebee
                defaults to today when omitted.
        """
        # Noop when disabled or missing subscription
        if not self.enabled or not subscription_id:
            return

        url = (
            f'https://{self._site}.chargebee.com'
            f'/api/v2/subscriptions/{subscription_id}/usages'
        )

        data: dict[str, str] = {
            'item_price_id': self._item_price_id,
            'quantity': str(quantity),
        }
        if usage_date:
            data['usage_date'] = usage_date

        auth = (self._api_key, '')

        attempts = 1 + CONST_CHARGEBEE_USAGE_RETRY_COUNT  # initial + retries

        for attempt in range(attempts):
            try:
                async with httpx.AsyncClient(
                    timeout=CONST_BILLING_API_TIMEOUT
                ) as client:
                    response = await client.post(url, data=data, auth=auth)

                # Auth errors: disable and bail out immediately
                if response.status_code in (401, 403):
                    debug(
                        f'Chargebee auth error ({response.status_code}), '
                        f'disabling usage reporting'
                    )
                    self.enabled = False
                    return

                # Server errors: retry if we have attempts left
                if response.status_code >= 500:
                    raise Exception(
                        f'Chargebee server error: {response.status_code}'
                    )

                # Success
                response.raise_for_status()
                return

            except Exception as e:
                is_last = attempt >= attempts - 1
                if is_last:
                    debug(f'Chargebee usage report failed after retries: {e}')
                    return

                debug(
                    f'Chargebee usage report attempt {attempt + 1} failed: {e}, '
                    f'retrying in {CONST_CHARGEBEE_USAGE_RETRY_DELAY}s'
                )
                await asyncio.sleep(CONST_CHARGEBEE_USAGE_RETRY_DELAY)
