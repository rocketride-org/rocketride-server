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

"""Product catalogue tools, including variations and per-product followers."""

from __future__ import annotations

from ..pipedrive_client import clean_deal, clean_file, clean_product, clean_search_item, paginated_v2
from ..tool_groups import pipedrive_tool
from ._base import (
    ARR,
    BOOL,
    ENUM,
    EXTRA,
    INT,
    NUM,
    PAGING,
    PAGING_V2,
    STR,
    PipedriveToolsBase,
    args_of,
    body_from,
    paging_params_v2,
    params_from,
    passthrough,
    require_id,
    require_text,
    schema,
)

_PRODUCT_WRITE_KEYS = (
    'name',
    'code',
    'description',
    'unit',
    'tax',
    'category',
    'active_flag',
    'selectable',
    'visible_to',
    'owner_id',
    'prices',
    'billing_frequency',
    'billing_frequency_cycles',
)

_PRODUCT_WRITE_PROPS = {
    'name': STR('Product name.'),
    'code': STR('Product code / SKU.'),
    'description': STR('Product description.'),
    'unit': STR('Unit the product is sold in, e.g. "licence" or "hour".'),
    'tax': NUM('Default tax percentage.'),
    'category': STR('Product category.'),
    'active_flag': BOOL('Whether the product can be added to deals.'),
    'selectable': BOOL('Whether the product is visible in the product picker.'),
    'visible_to': ENUM('Visibility group id.', ['1', '3', '5', '7']),
    'owner_id': INT('Owner user id.'),
    'prices': {
        'type': 'array',
        'items': {'type': 'object'},
        'description': 'Prices per currency, e.g. [{"currency": "USD", "price": 100, "cost": 40}].',
    },
    'billing_frequency': ENUM(
        'Billing cadence for recurring products.',
        ['one-time', 'annually', 'semi-annually', 'quarterly', 'monthly', 'weekly'],
    ),
    'billing_frequency_cycles': INT('How many billing cycles the product runs for.'),
    'extra': EXTRA(),
}


class ProductsMixin(PipedriveToolsBase):
    """Tools for the ``products`` group."""

    @pipedrive_tool(
        group='products',
        input_schema=schema(
            **PAGING(),
            user_id=INT('Only products owned by this user id.'),
            filter_id=INT('Apply a saved filter by id.'),
            ids=ARR('Only these product ids.', 'integer'),
            first_char=STR('Only products whose name starts with this letter.'),
            get_summary=BOOL('Include the total product count in the response.'),
        ),
        description='List products from the catalogue.',
    )
    def product_list(self, args):
        args = args_of(args)
        extra = params_from(args, ('user_id', 'filter_id', 'first_char', 'get_summary'))
        if isinstance(args.get('ids'), list) and args['ids']:
            extra['ids'] = ','.join(str(int(i)) for i in args['ids'])
        return self._list('/products', args, clean_product, extra=extra)

    @pipedrive_tool(
        group='products',
        input_schema=schema(required=['product_id'], product_id=INT('Product id.')),
        description='Get a single product by id, including its prices.',
    )
    def product_get(self, args):
        args = args_of(args)
        return self._get(f'/products/{require_id(args, "product_id", "product_get")}', clean_product)

    @pipedrive_tool(
        group='products',
        input_schema=schema(
            required=['term'],
            term=STR('Search term, at least 2 characters (1 when exact_match is true).'),
            fields=STR('Comma-separated fields to search in: code, custom_fields, name.'),
            exact_match=BOOL('Require an exact, case-sensitive match.'),
            include_fields=STR('Extra fields to include, e.g. "product.price".'),
            **PAGING_V2(),
        ),
        description='Search products by name, code or custom field values.',
    )
    def product_search(self, args):
        # v2: Pipedrive retired /api/v1/products/search (404 "Unknown method .").
        args = args_of(args)
        params = paging_params_v2(args)
        params['term'] = require_text(args, 'term', 'product_search')
        params.update(params_from(args, ('fields', 'exact_match', 'include_fields')))
        envelope = self._call_envelope_v2('GET', '/products/search', params=params)
        items = ((envelope.get('data') or {}).get('items')) or []
        return paginated_v2(envelope, [clean_search_item(i) for i in items])

    @pipedrive_tool(
        group='products',
        input_schema=schema(required=['name'], **_PRODUCT_WRITE_PROPS),
        description='Create a product in the catalogue.',
    )
    def product_create(self, args):
        args = args_of(args)
        require_text(args, 'name', 'product_create')
        return self._write('POST', '/products', clean_product, body=body_from(args, _PRODUCT_WRITE_KEYS))

    @pipedrive_tool(
        group='products',
        input_schema=schema(required=['product_id'], product_id=INT('Product id to update.'), **_PRODUCT_WRITE_PROPS),
        description='Update a product.',
    )
    def product_update(self, args):
        args = args_of(args)
        product_id = require_id(args, 'product_id', 'product_update')
        return self._write('PUT', f'/products/{product_id}', clean_product, body=body_from(args, _PRODUCT_WRITE_KEYS))

    @pipedrive_tool(
        group='products',
        input_schema=schema(required=['product_id'], product_id=INT('Product id to delete.')),
        description='Delete a product from the catalogue.',
    )
    def product_delete(self, args):
        args = args_of(args)
        return self._delete(f'/products/{require_id(args, "product_id", "product_delete")}')

    # -- related records --------------------------------------------------

    @pipedrive_tool(
        group='products',
        input_schema=schema(
            required=['product_id'],
            product_id=INT('Product id.'),
            status=ENUM(
                'Only deals with this status (default all_not_deleted).',
                ['open', 'won', 'lost', 'deleted', 'all_not_deleted'],
            ),
            **PAGING(),
        ),
        description='List deals a product is attached to.',
    )
    def product_deals_list(self, args):
        args = args_of(args)
        product_id = require_id(args, 'product_id', 'product_deals_list')
        return self._list(f'/products/{product_id}/deals', args, clean_deal, extra=params_from(args, ('status',)))

    @pipedrive_tool(
        group='products',
        input_schema=schema(required=['product_id'], product_id=INT('Product id.'), **PAGING()),
        description='List files attached to a product.',
    )
    def product_files_list(self, args):
        args = args_of(args)
        product_id = require_id(args, 'product_id', 'product_files_list')
        return self._list(f'/products/{product_id}/files', args, clean_file)

    @pipedrive_tool(
        group='products',
        input_schema=schema(required=['product_id'], product_id=INT('Product id.')),
        description='List users who have permission to see or edit a product.',
    )
    def product_permitted_users_list(self, args):
        args = args_of(args)
        product_id = require_id(args, 'product_id', 'product_permitted_users_list')
        return {'user_ids': self._call('GET', f'/products/{product_id}/permittedUsers')}

    # -- followers --------------------------------------------------------

    @pipedrive_tool(
        group='products',
        input_schema=schema(required=['product_id'], product_id=INT('Product id.'), **PAGING()),
        description='List followers of a product.',
    )
    def product_followers_list(self, args):
        args = args_of(args)
        product_id = require_id(args, 'product_id', 'product_followers_list')
        return self._list(f'/products/{product_id}/followers', args, passthrough)

    @pipedrive_tool(
        group='products',
        input_schema=schema(
            required=['product_id', 'user_id'],
            product_id=INT('Product id.'),
            user_id=INT('User id to add as a follower.'),
        ),
        description='Add a follower to a product.',
    )
    def product_follower_add(self, args):
        args = args_of(args)
        product_id = require_id(args, 'product_id', 'product_follower_add')
        user_id = require_id(args, 'user_id', 'product_follower_add')
        return self._write('POST', f'/products/{product_id}/followers', passthrough, body={'user_id': user_id})

    @pipedrive_tool(
        group='products',
        input_schema=schema(
            required=['product_id', 'follower_id'],
            product_id=INT('Product id.'),
            follower_id=INT('Follower id (from product_followers_list, not the user id).'),
        ),
        description='Remove a follower from a product.',
    )
    def product_follower_delete(self, args):
        args = args_of(args)
        product_id = require_id(args, 'product_id', 'product_follower_delete')
        follower_id = require_id(args, 'follower_id', 'product_follower_delete')
        return self._delete(f'/products/{product_id}/followers/{follower_id}')

    # -- variations -------------------------------------------------------

    @pipedrive_tool(
        group='products',
        input_schema=schema(required=['product_id'], product_id=INT('Product id.'), **PAGING()),
        description='List the variations of a product.',
    )
    def product_variation_list(self, args):
        args = args_of(args)
        product_id = require_id(args, 'product_id', 'product_variation_list')
        return self._list(f'/products/{product_id}/variations', args, passthrough)

    @pipedrive_tool(
        group='products',
        input_schema=schema(
            required=['product_id', 'name'],
            product_id=INT('Product id.'),
            name=STR('Variation name.'),
            prices={
                'type': 'array',
                'items': {'type': 'object'},
                'description': 'Prices per currency, e.g. [{"currency": "USD", "price": 120}].',
            },
        ),
        description='Create a product variation.',
    )
    def product_variation_create(self, args):
        args = args_of(args)
        product_id = require_id(args, 'product_id', 'product_variation_create')
        require_text(args, 'name', 'product_variation_create')
        return self._write(
            'POST', f'/products/{product_id}/variations', passthrough, body=body_from(args, ('name', 'prices'))
        )

    @pipedrive_tool(
        group='products',
        input_schema=schema(
            required=['product_id', 'variation_id'],
            product_id=INT('Product id.'),
            variation_id=INT('Variation id.'),
            name=STR('New variation name.'),
            prices={'type': 'array', 'items': {'type': 'object'}, 'description': 'New prices per currency.'},
        ),
        description='Update a product variation.',
    )
    def product_variation_update(self, args):
        args = args_of(args)
        product_id = require_id(args, 'product_id', 'product_variation_update')
        variation_id = require_id(args, 'variation_id', 'product_variation_update')
        return self._write(
            'PUT',
            f'/products/{product_id}/variations/{variation_id}',
            passthrough,
            body=body_from(args, ('name', 'prices')),
        )

    @pipedrive_tool(
        group='products',
        input_schema=schema(
            required=['product_id', 'variation_id'],
            product_id=INT('Product id.'),
            variation_id=INT('Variation id to delete.'),
        ),
        description='Delete a product variation.',
    )
    def product_variation_delete(self, args):
        args = args_of(args)
        product_id = require_id(args, 'product_id', 'product_variation_delete')
        variation_id = require_id(args, 'variation_id', 'product_variation_delete')
        return self._delete(f'/products/{product_id}/variations/{variation_id}')
