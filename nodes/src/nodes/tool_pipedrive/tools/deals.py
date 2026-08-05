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

"""Deal tools: the deal record plus its products, followers, participants and flow."""

from __future__ import annotations

from ..pipedrive_client import (
    clean_activity,
    clean_deal,
    clean_file,
    clean_mail_message,
    clean_person,
    clean_search_item,
    paginated,
    paginated_v2,
)
from ..tool_groups import pipedrive_tool
from ._base import (
    ARR,
    BOOL,
    ENUM,
    EXTRA,
    INT,
    NUM,
    OBJ,
    PAGING,
    PAGING_V2,
    STR,
    PipedriveToolsBase,
    args_of,
    body_from,
    paging_params,
    paging_params_v2,
    params_from,
    passthrough,
    require_id,
    require_text,
    schema,
)

_DEAL_WRITE_KEYS = (
    'title',
    'value',
    'currency',
    'user_id',
    'person_id',
    'org_id',
    'stage_id',
    'pipeline_id',
    'status',
    'expected_close_date',
    'probability',
    'lost_reason',
    'visible_to',
    'add_time',
    'label',
)

_DEAL_WRITE_PROPS = {
    'title': STR('Deal title.'),
    'value': NUM('Deal value as a number.'),
    'currency': STR('3-letter currency code, e.g. "USD". Defaults to the company currency.'),
    'user_id': INT('Owner user id. Defaults to the authenticated user.'),
    'person_id': INT('Linked person id.'),
    'org_id': INT('Linked organization id.'),
    'stage_id': INT('Stage id. Determines the pipeline when pipeline_id is omitted.'),
    'pipeline_id': INT('Pipeline id.'),
    'status': ENUM('Deal status.', ['open', 'won', 'lost', 'deleted']),
    'expected_close_date': STR('Expected close date, YYYY-MM-DD.'),
    'probability': NUM('Success probability percentage (0-100).'),
    'lost_reason': STR('Free-text reason, only meaningful when status is "lost".'),
    'visible_to': ENUM('Visibility group id.', ['1', '3', '5', '7']),
    'label': STR('Deal label id, or a comma-separated list of label ids.'),
    'add_time': STR('Creation timestamp, YYYY-MM-DD HH:MM:SS. Use to backdate an imported record.'),
    'extra': EXTRA(),
}


class DealsMixin(PipedriveToolsBase):
    """Tools for the ``deals`` group."""

    # -- the deal record --------------------------------------------------

    @pipedrive_tool(
        group='deals',
        input_schema=schema(
            **PAGING(),
            user_id=INT('Only deals owned by this user id.'),
            filter_id=INT('Apply a saved filter by id (see filter_list).'),
            stage_id=INT('Only deals in this stage.'),
            status=ENUM(
                'Filter by status (default all_not_deleted).', ['open', 'won', 'lost', 'deleted', 'all_not_deleted']
            ),
            sort=STR('Sort clause, e.g. "update_time DESC, id ASC". Field names must be in the deal table.'),
            owned_by_you=INT('Set to 1 to return only deals owned by the authenticated user.'),
        ),
        description='List deals, optionally filtered by owner, stage, status or a saved filter.',
    )
    def deal_list(self, args):
        args = args_of(args)
        return self._list(
            '/deals',
            args,
            clean_deal,
            extra=params_from(args, ('user_id', 'filter_id', 'stage_id', 'status', 'sort', 'owned_by_you')),
        )

    @pipedrive_tool(
        group='deals',
        input_schema=schema(required=['deal_id'], deal_id=INT('Deal id.')),
        description='Get a single deal by id, including its custom fields.',
    )
    def deal_get(self, args):
        args = args_of(args)
        return self._get(f'/deals/{require_id(args, "deal_id", "deal_get")}', clean_deal)

    @pipedrive_tool(
        group='deals',
        input_schema=schema(
            required=['term'],
            term=STR('Search term, at least 2 characters (1 when exact_match is true).'),
            fields=STR('Comma-separated fields to search in: custom_fields, notes, title.'),
            exact_match=BOOL('Require an exact, case-sensitive match.'),
            person_id=INT('Only deals linked to this person.'),
            organization_id=INT('Only deals linked to this organization.'),
            status=ENUM('Only deals with this status.', ['open', 'won', 'lost']),
            include_fields=STR('Extra fields to include, e.g. "deal.cc_email".'),
            **PAGING_V2(),
        ),
        description='Search deals by title, notes or custom field values.',
    )
    def deal_search(self, args):
        # v2: Pipedrive retired /api/v1/deals/search (404 "Unknown method .").
        args = args_of(args)
        params = paging_params_v2(args)
        params['term'] = require_text(args, 'term', 'deal_search')
        params.update(
            params_from(args, ('fields', 'exact_match', 'person_id', 'organization_id', 'status', 'include_fields'))
        )
        envelope = self._call_envelope_v2('GET', '/deals/search', params=params)
        items = ((envelope.get('data') or {}).get('items')) or []
        return paginated_v2(envelope, [clean_search_item(i) for i in items])

    @pipedrive_tool(
        group='deals',
        input_schema=schema(required=['title'], **_DEAL_WRITE_PROPS),
        description='Create a deal.',
    )
    def deal_create(self, args):
        args = args_of(args)
        require_text(args, 'title', 'deal_create')
        return self._write('POST', '/deals', clean_deal, body=body_from(args, _DEAL_WRITE_KEYS))

    @pipedrive_tool(
        group='deals',
        input_schema=schema(required=['deal_id'], deal_id=INT('Deal id to update.'), **_DEAL_WRITE_PROPS),
        description='Update a deal. Only the fields you pass are changed.',
    )
    def deal_update(self, args):
        args = args_of(args)
        deal_id = require_id(args, 'deal_id', 'deal_update')
        return self._write('PUT', f'/deals/{deal_id}', clean_deal, body=body_from(args, _DEAL_WRITE_KEYS))

    @pipedrive_tool(
        group='deals',
        input_schema=schema(required=['deal_id'], deal_id=INT('Deal id to delete.')),
        description='Delete a deal. Pipedrive keeps it recoverable for 30 days.',
    )
    def deal_delete(self, args):
        args = args_of(args)
        return self._delete(f'/deals/{require_id(args, "deal_id", "deal_delete")}')

    @pipedrive_tool(
        group='deals',
        input_schema=schema(required=['deal_id'], deal_id=INT('Deal id to duplicate.')),
        description='Duplicate a deal.',
    )
    def deal_duplicate(self, args):
        args = args_of(args)
        deal_id = require_id(args, 'deal_id', 'deal_duplicate')
        return self._write('POST', f'/deals/{deal_id}/duplicate', clean_deal)

    @pipedrive_tool(
        group='deals',
        input_schema=schema(
            required=['deal_id', 'merge_with_id'],
            deal_id=INT('Deal id that will be merged away.'),
            merge_with_id=INT('Deal id that survives the merge.'),
        ),
        description='Merge one deal into another. The source deal is removed.',
    )
    def deal_merge(self, args):
        args = args_of(args)
        deal_id = require_id(args, 'deal_id', 'deal_merge')
        merge_with_id = require_id(args, 'merge_with_id', 'deal_merge')
        return self._write('PUT', f'/deals/{deal_id}/merge', clean_deal, body={'merge_with_id': merge_with_id})

    # -- reporting --------------------------------------------------------

    @pipedrive_tool(
        group='deals',
        input_schema=schema(
            status=ENUM('Only count deals with this status.', ['open', 'won', 'lost']),
            filter_id=INT('Apply a saved filter by id.'),
            user_id=INT('Only deals owned by this user id.'),
            stage_id=INT('Only deals in this stage.'),
        ),
        description='Get a summary of deals: total count and value, grouped by currency.',
    )
    def deal_summary(self, args):
        args = args_of(args)
        params = params_from(args, ('status', 'filter_id', 'user_id', 'stage_id'))
        return self._call('GET', '/deals/summary', params=params)

    @pipedrive_tool(
        group='deals',
        input_schema=schema(
            required=['start_date', 'interval', 'amount', 'field_key'],
            start_date=STR('First period start, YYYY-MM-DD.'),
            interval=ENUM('Period length.', ['day', 'week', 'month', 'quarter']),
            amount=INT('How many periods to return, counting forward from start_date.'),
            field_key=STR('Date field the deals are grouped by, e.g. "add_time" or "expected_close_date".'),
            user_id=INT('Only deals owned by this user id.'),
            pipeline_id=INT('Only deals in this pipeline.'),
            filter_id=INT('Apply a saved filter by id.'),
            exclude_deals=INT('Set to 1 to return only totals, without the deal records.'),
            totals_convert_currency=STR('Convert totals to this 3-letter currency code, or "default_currency".'),
        ),
        description='Get deals grouped into time periods, with per-period totals. Useful for pipeline trend questions.',
    )
    def deal_timeline(self, args):
        args = args_of(args)
        params = {
            'start_date': require_text(args, 'start_date', 'deal_timeline'),
            'interval': require_text(args, 'interval', 'deal_timeline'),
            'amount': require_id(args, 'amount', 'deal_timeline'),
            'field_key': require_text(args, 'field_key', 'deal_timeline'),
        }
        params.update(
            params_from(
                args,
                ('user_id', 'pipeline_id', 'filter_id', 'exclude_deals', 'totals_convert_currency'),
            )
        )
        return self._call('GET', '/deals/timeline', params=params)

    # -- related records --------------------------------------------------

    @pipedrive_tool(
        group='deals',
        input_schema=schema(
            required=['deal_id'],
            deal_id=INT('Deal id.'),
            done=INT('0 for pending activities, 1 for completed. Omit for both.'),
            exclude=STR('Comma-separated activity ids to leave out.'),
            **PAGING(),
        ),
        description='List activities associated with a deal.',
    )
    def deal_activities_list(self, args):
        args = args_of(args)
        deal_id = require_id(args, 'deal_id', 'deal_activities_list')
        return self._list(
            f'/deals/{deal_id}/activities', args, clean_activity, extra=params_from(args, ('done', 'exclude'))
        )

    @pipedrive_tool(
        group='deals',
        input_schema=schema(
            required=['deal_id'],
            deal_id=INT('Deal id.'),
            sort=STR('Sort clause, e.g. "add_time DESC".'),
            **PAGING(),
        ),
        description='List files attached to a deal.',
    )
    def deal_files_list(self, args):
        args = args_of(args)
        deal_id = require_id(args, 'deal_id', 'deal_files_list')
        return self._list(f'/deals/{deal_id}/files', args, clean_file, extra=params_from(args, ('sort',)))

    @pipedrive_tool(
        group='deals',
        input_schema=schema(
            required=['deal_id'],
            deal_id=INT('Deal id.'),
            all_changes=STR('Set to "1" to include changes from Pipedrive automations and integrations.'),
            items=STR('Comma-separated update types to include, e.g. "activity,note,change".'),
            **PAGING(),
        ),
        description='Get the update history (flow) of a deal: field changes, notes, activities and emails.',
    )
    def deal_updates_list(self, args):
        args = args_of(args)
        deal_id = require_id(args, 'deal_id', 'deal_updates_list')
        params = paging_params(args)
        params.update(params_from(args, ('all_changes', 'items')))
        envelope = self._call_envelope('GET', f'/deals/{deal_id}/flow', params=params)
        data = envelope.get('data') if isinstance(envelope, dict) else None
        return paginated(envelope, list(data or []))

    @pipedrive_tool(
        group='deals',
        input_schema=schema(required=['deal_id'], deal_id=INT('Deal id.'), **PAGING()),
        description='List persons linked to a deal, either directly or through its organization.',
    )
    def deal_persons_list(self, args):
        args = args_of(args)
        deal_id = require_id(args, 'deal_id', 'deal_persons_list')
        return self._list(f'/deals/{deal_id}/persons', args, clean_person)

    @pipedrive_tool(
        group='deals',
        input_schema=schema(required=['deal_id'], deal_id=INT('Deal id.'), **PAGING()),
        description='List email messages associated with a deal.',
    )
    def deal_mail_messages_list(self, args):
        args = args_of(args)
        deal_id = require_id(args, 'deal_id', 'deal_mail_messages_list')
        return self._list(f'/deals/{deal_id}/mailMessages', args, clean_mail_message)

    @pipedrive_tool(
        group='deals',
        input_schema=schema(required=['deal_id'], deal_id=INT('Deal id.')),
        description='List users who have permission to see or edit a deal.',
    )
    def deal_permitted_users_list(self, args):
        args = args_of(args)
        deal_id = require_id(args, 'deal_id', 'deal_permitted_users_list')
        return {'user_ids': self._call('GET', f'/deals/{deal_id}/permittedUsers')}

    # -- followers --------------------------------------------------------

    @pipedrive_tool(
        group='deals',
        input_schema=schema(required=['deal_id'], deal_id=INT('Deal id.'), **PAGING()),
        description='List followers of a deal.',
    )
    def deal_followers_list(self, args):
        args = args_of(args)
        deal_id = require_id(args, 'deal_id', 'deal_followers_list')
        return self._list(f'/deals/{deal_id}/followers', args, passthrough)

    @pipedrive_tool(
        group='deals',
        input_schema=schema(
            required=['deal_id', 'user_id'], deal_id=INT('Deal id.'), user_id=INT('User id to add as a follower.')
        ),
        description='Add a follower to a deal.',
    )
    def deal_follower_add(self, args):
        args = args_of(args)
        deal_id = require_id(args, 'deal_id', 'deal_follower_add')
        user_id = require_id(args, 'user_id', 'deal_follower_add')
        return self._write('POST', f'/deals/{deal_id}/followers', passthrough, body={'user_id': user_id})

    @pipedrive_tool(
        group='deals',
        input_schema=schema(
            required=['deal_id', 'follower_id'],
            deal_id=INT('Deal id.'),
            follower_id=INT('Follower id (from deal_followers_list, not the user id).'),
        ),
        description='Remove a follower from a deal.',
    )
    def deal_follower_delete(self, args):
        args = args_of(args)
        deal_id = require_id(args, 'deal_id', 'deal_follower_delete')
        follower_id = require_id(args, 'follower_id', 'deal_follower_delete')
        return self._delete(f'/deals/{deal_id}/followers/{follower_id}')

    # -- participants -----------------------------------------------------

    @pipedrive_tool(
        group='deals',
        input_schema=schema(required=['deal_id'], deal_id=INT('Deal id.'), **PAGING()),
        description='List participants (persons) of a deal.',
    )
    def deal_participants_list(self, args):
        args = args_of(args)
        deal_id = require_id(args, 'deal_id', 'deal_participants_list')
        return self._list(f'/deals/{deal_id}/participants', args, clean_person)

    @pipedrive_tool(
        group='deals',
        input_schema=schema(
            required=['deal_id', 'person_id'], deal_id=INT('Deal id.'), person_id=INT('Person id to add.')
        ),
        description='Add a person as a participant of a deal.',
    )
    def deal_participant_add(self, args):
        args = args_of(args)
        deal_id = require_id(args, 'deal_id', 'deal_participant_add')
        person_id = require_id(args, 'person_id', 'deal_participant_add')
        return self._write('POST', f'/deals/{deal_id}/participants', passthrough, body={'person_id': person_id})

    @pipedrive_tool(
        group='deals',
        input_schema=schema(
            required=['deal_id', 'participant_id'],
            deal_id=INT('Deal id.'),
            participant_id=INT('Participant id (from deal_participants_list).'),
        ),
        description='Remove a participant from a deal.',
    )
    def deal_participant_delete(self, args):
        args = args_of(args)
        deal_id = require_id(args, 'deal_id', 'deal_participant_delete')
        participant_id = require_id(args, 'participant_id', 'deal_participant_delete')
        return self._delete(f'/deals/{deal_id}/participants/{participant_id}')

    # -- products ---------------------------------------------------------

    @pipedrive_tool(
        group='deals',
        input_schema=schema(
            required=['deal_id'],
            deal_id=INT('Deal id.'),
            include_product_data=INT('Set to 1 to embed the full product record in each row.'),
            **PAGING(),
        ),
        description='List products attached to a deal, with their quantities and prices.',
    )
    def deal_products_list(self, args):
        args = args_of(args)
        deal_id = require_id(args, 'deal_id', 'deal_products_list')
        return self._list(
            f'/deals/{deal_id}/products', args, passthrough, extra=params_from(args, ('include_product_data',))
        )

    @pipedrive_tool(
        group='deals',
        input_schema=schema(
            required=['deal_id', 'product_id', 'item_price', 'quantity'],
            deal_id=INT('Deal id.'),
            product_id=INT('Product id to attach.'),
            item_price=NUM('Price per unit for this deal.'),
            quantity=NUM('Number of units.'),
            discount=NUM('Discount amount or percentage, see discount_type.'),
            discount_type=ENUM('How discount is interpreted (default percentage).', ['percentage', 'amount']),
            tax=NUM('Tax amount or percentage, see tax_method.'),
            tax_method=ENUM('How tax is applied.', ['exclusive', 'inclusive', 'none']),
            duration=NUM('Billing duration for recurring products.'),
            duration_unit=ENUM('Unit for duration.', ['hourly', 'daily', 'weekly', 'monthly', 'yearly']),
            product_variation_id=INT('Product variation id, when the product has variations.'),
            comments=STR('Free-text comment shown on the deal.'),
            enabled_flag=BOOL('Whether the product is active on the deal (default true).'),
            extra=EXTRA(),
        ),
        description='Attach a product to a deal.',
    )
    def deal_product_add(self, args):
        args = args_of(args)
        deal_id = require_id(args, 'deal_id', 'deal_product_add')
        require_id(args, 'product_id', 'deal_product_add')
        body = body_from(
            args,
            (
                'product_id',
                'item_price',
                'quantity',
                'discount',
                'discount_type',
                'tax',
                'tax_method',
                'duration',
                'duration_unit',
                'product_variation_id',
                'comments',
                'enabled_flag',
            ),
        )
        return self._write('POST', f'/deals/{deal_id}/products', passthrough, body=body)

    @pipedrive_tool(
        group='deals',
        input_schema=schema(
            required=['deal_id', 'product_attachment_id'],
            deal_id=INT('Deal id.'),
            product_attachment_id=INT('Attachment id from deal_products_list (not the product id).'),
            item_price=NUM('New price per unit.'),
            quantity=NUM('New number of units.'),
            discount=NUM('New discount.'),
            discount_type=ENUM('How discount is interpreted.', ['percentage', 'amount']),
            tax=NUM('New tax.'),
            tax_method=ENUM('How tax is applied.', ['exclusive', 'inclusive', 'none']),
            duration=NUM('Billing duration for recurring products.'),
            duration_unit=ENUM('Unit for duration.', ['hourly', 'daily', 'weekly', 'monthly', 'yearly']),
            product_variation_id=INT('Product variation id.'),
            comments=STR('Free-text comment.'),
            enabled_flag=BOOL('Whether the product is active on the deal.'),
            extra=EXTRA(),
        ),
        description='Update a product already attached to a deal.',
    )
    def deal_product_update(self, args):
        args = args_of(args)
        deal_id = require_id(args, 'deal_id', 'deal_product_update')
        attachment_id = require_id(args, 'product_attachment_id', 'deal_product_update')
        body = body_from(
            args,
            (
                'item_price',
                'quantity',
                'discount',
                'discount_type',
                'tax',
                'tax_method',
                'duration',
                'duration_unit',
                'product_variation_id',
                'comments',
                'enabled_flag',
            ),
        )
        return self._write('PUT', f'/deals/{deal_id}/products/{attachment_id}', passthrough, body=body)

    @pipedrive_tool(
        group='deals',
        input_schema=schema(
            required=['deal_id', 'product_attachment_id'],
            deal_id=INT('Deal id.'),
            product_attachment_id=INT('Attachment id from deal_products_list.'),
        ),
        description='Detach a product from a deal.',
    )
    def deal_product_delete(self, args):
        args = args_of(args)
        deal_id = require_id(args, 'deal_id', 'deal_product_delete')
        attachment_id = require_id(args, 'product_attachment_id', 'deal_product_delete')
        return self._delete(f'/deals/{deal_id}/products/{attachment_id}')

    # -- misc -------------------------------------------------------------

    # There is no deal_followers_users_list tool: it would GET the same
    # /deals/{id}/followers as deal_followers_list and only differ by running the
    # rows through clean_user, which builds a user-shaped object out of follower
    # fields. Resolving followers to users needs a /users/{id} call per follower —
    # not worth another entry in an already large tool surface.

    @pipedrive_tool(
        group='deals',
        input_schema=schema(
            required=['ids'],
            ids=ARR('Deal ids to delete.', 'integer'),
            extra=OBJ('Additional query parameters passed straight through.'),
        ),
        description='Delete multiple deals in one call.',
    )
    def deal_delete_bulk(self, args):
        return self._delete_bulk('/deals', args_of(args), 'deal_delete_bulk', extra_key='extra')
