# =============================================================================
# RocketRide Engine
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

"""Revenue subscription tools: recurring and installment payment plans on deals."""

from __future__ import annotations

from ..pipedrive_client import clean_subscription
from ..tool_groups import pipedrive_tool
from ._base import (
    ARR,
    BOOL,
    ENUM,
    INT,
    NUM,
    STR,
    PipedriveToolsBase,
    args_of,
    body_from,
    require_id,
    require_text,
    schema,
)

_PAYMENTS_DESC = 'Installment payments, e.g. [{"amount": 100, "description": "Deposit", "due_at": "2026-03-01"}].'


class SubscriptionsMixin(PipedriveToolsBase):
    """Tools for the ``subscriptions`` group."""

    @pipedrive_tool(
        group='subscriptions',
        input_schema=schema(required=['subscription_id'], subscription_id=INT('Subscription id.')),
        description='Get a single revenue subscription.',
    )
    def subscription_get(self, args):
        args = args_of(args)
        sub_id = require_id(args, 'subscription_id', 'subscription_get')
        return self._get(f'/subscriptions/{sub_id}', clean_subscription)

    @pipedrive_tool(
        group='subscriptions',
        input_schema=schema(required=['deal_id'], deal_id=INT('Deal id.')),
        description='Find the subscription attached to a deal.',
    )
    def subscription_find_by_deal(self, args):
        args = args_of(args)
        deal_id = require_id(args, 'deal_id', 'subscription_find_by_deal')
        return self._get(f'/subscriptions/find/{deal_id}', clean_subscription)

    @pipedrive_tool(
        group='subscriptions',
        input_schema=schema(required=['subscription_id'], subscription_id=INT('Subscription id.')),
        description='List the payments of a subscription.',
    )
    def subscription_payments_list(self, args):
        args = args_of(args)
        sub_id = require_id(args, 'subscription_id', 'subscription_payments_list')
        data = self._call('GET', f'/subscriptions/{sub_id}/payments')
        return {'items': list(data or [])}

    @pipedrive_tool(
        group='subscriptions',
        input_schema=schema(
            required=['deal_id', 'currency', 'cadence_type', 'cycle_amount', 'start_date'],
            deal_id=INT('Deal the subscription belongs to.'),
            currency=STR('3-letter currency code.'),
            description=STR('Subscription description.'),
            cadence_type=ENUM('Billing cadence.', ['weekly', 'monthly', 'quarterly', 'yearly']),
            cycles_count=INT('How many billing cycles to run. Omit together with infinite=true.'),
            cycle_amount=NUM('Amount charged per cycle.'),
            start_date=STR('Date of the first payment, YYYY-MM-DD.'),
            infinite=BOOL('Whether the subscription runs forever.'),
            update_deal_value=BOOL('Update the deal value to match the subscription total.'),
        ),
        description='Create a recurring revenue subscription on a deal.',
    )
    def subscription_recurring_create(self, args):
        args = args_of(args)
        require_id(args, 'deal_id', 'subscription_recurring_create')
        for key in ('currency', 'cadence_type', 'start_date'):
            require_text(args, key, 'subscription_recurring_create')
        body = body_from(
            args,
            (
                'deal_id',
                'currency',
                'description',
                'cadence_type',
                'cycles_count',
                'cycle_amount',
                'start_date',
                'infinite',
                'update_deal_value',
            ),
        )
        return self._write('POST', '/subscriptions/recurring', clean_subscription, body=body)

    @pipedrive_tool(
        group='subscriptions',
        input_schema=schema(
            required=['deal_id', 'currency', 'payments'],
            deal_id=INT('Deal the subscription belongs to.'),
            currency=STR('3-letter currency code.'),
            payments=ARR(_PAYMENTS_DESC, 'object'),
            update_deal_value=BOOL('Update the deal value to match the payment total.'),
        ),
        description='Create an installment subscription on a deal.',
    )
    def subscription_installment_create(self, args):
        args = args_of(args)
        require_id(args, 'deal_id', 'subscription_installment_create')
        require_text(args, 'currency', 'subscription_installment_create')
        if not isinstance(args.get('payments'), list) or not args['payments']:
            raise ValueError('subscription_installment_create: "payments" must be a non-empty array')
        body = body_from(args, ('deal_id', 'currency', 'payments', 'update_deal_value'))
        return self._write('POST', '/subscriptions/installment', clean_subscription, body=body)

    @pipedrive_tool(
        group='subscriptions',
        input_schema=schema(
            required=['subscription_id', 'effective_date'],
            subscription_id=INT('Recurring subscription id.'),
            effective_date=STR('Date the change takes effect, YYYY-MM-DD.'),
            cycle_amount=NUM('New amount per cycle.'),
            cycles_count=INT('New number of cycles.'),
            description=STR('New description.'),
            payments=ARR('Replacement payment schedule.', 'object'),
            update_deal_value=BOOL('Update the deal value to match.'),
        ),
        description='Update a recurring subscription from a given date onward.',
    )
    def subscription_recurring_update(self, args):
        args = args_of(args)
        sub_id = require_id(args, 'subscription_id', 'subscription_recurring_update')
        require_text(args, 'effective_date', 'subscription_recurring_update')
        body = body_from(
            args,
            ('description', 'cycle_amount', 'cycles_count', 'payments', 'update_deal_value', 'effective_date'),
        )
        return self._write('PUT', f'/subscriptions/recurring/{sub_id}', clean_subscription, body=body)

    @pipedrive_tool(
        group='subscriptions',
        input_schema=schema(
            required=['subscription_id', 'payments'],
            subscription_id=INT('Installment subscription id.'),
            payments=ARR(_PAYMENTS_DESC, 'object'),
            update_deal_value=BOOL('Update the deal value to match the payment total.'),
        ),
        description='Replace the payment schedule of an installment subscription.',
    )
    def subscription_installment_update(self, args):
        args = args_of(args)
        sub_id = require_id(args, 'subscription_id', 'subscription_installment_update')
        if not isinstance(args.get('payments'), list) or not args['payments']:
            raise ValueError('subscription_installment_update: "payments" must be a non-empty array')
        body = body_from(args, ('payments', 'update_deal_value'))
        return self._write('PUT', f'/subscriptions/installment/{sub_id}', clean_subscription, body=body)

    @pipedrive_tool(
        group='subscriptions',
        input_schema=schema(
            required=['subscription_id'],
            subscription_id=INT('Recurring subscription id to cancel.'),
            end_date=STR('Date the subscription ends, YYYY-MM-DD. Defaults to today.'),
        ),
        description='Cancel a recurring subscription.',
    )
    def subscription_recurring_cancel(self, args):
        args = args_of(args)
        sub_id = require_id(args, 'subscription_id', 'subscription_recurring_cancel')
        return self._write(
            'PUT', f'/subscriptions/recurring/{sub_id}/cancel', clean_subscription, body=body_from(args, ('end_date',))
        )

    @pipedrive_tool(
        group='subscriptions',
        input_schema=schema(required=['subscription_id'], subscription_id=INT('Subscription id to delete.')),
        description='Delete a subscription and detach it from its deal.',
    )
    def subscription_delete(self, args):
        args = args_of(args)
        sub_id = require_id(args, 'subscription_id', 'subscription_delete')
        return self._delete(f'/subscriptions/{sub_id}')
