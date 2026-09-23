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

"""Business tools: the business records a sub-account groups its contacts under."""

from __future__ import annotations

from typing import Any

from ..gohighlevel_client import paginated
from ..tool_groups import gohighlevel_tool
from ._base import (
    LIST_OUTPUT,
    PAGING_SKIP_TEXT,
    RECORD_OUTPUT,
    STR,
    GoHighLevelToolsBase,
    body_from,
    next_offset,
    require_id,
    schema,
    skip_text_params,
)

#: Fields kept from a business record. ``BusinessDto`` declares seventeen and this keeps all
#: of them, so the projection is an ordering and a guard against future additions rather than
#: a trim: the record is small, and the two audit fields are objects rather than ids
#: (``{name, role}``), so there is nothing here worth dropping for size.
_BUSINESS_READ_KEYS = (
    'id',
    'name',
    'locationId',
    'phone',
    'email',
    'website',
    'address',
    'city',
    'state',
    'postalCode',
    'country',
    'description',
    'createdBy',
    'updatedBy',
    'createdAt',
    'updatedAt',
)

#: Body fields accepted by business_create and business_update.
#:
#: One tuple serves both because CreateBusinessDto and UpdateBusinessDto declare exactly the
#: same ten fields. They differ only in what is required: create requires ``name``, update
#: requires nothing. That is the whole of the create-versus-update drift here, and it is
#: expressed by the ``required`` list on each schema rather than by a second key tuple.
#:
#: ``locationId`` is absent deliberately. Create takes it and the node supplies it from
#: config; UpdateBusinessDto does not declare it at all, and GoHighLevel answers an
#: undeclared property with a 422 rather than ignoring it.
_BUSINESS_WRITE_KEYS = (
    'name',
    'phone',
    'email',
    'website',
    'address',
    'city',
    'state',
    'postalCode',
    'country',
    'description',
)

#: There is no ``extra`` escape hatch on either write tool, which is a departure from the
#: contact tools and is deliberate. ``extra`` exists to reach a field the typed schema does
#: not cover, and here the typed schema covers both DTOs completely. Businesses carry no
#: custom fields and no tags. Anything else an agent could put in ``extra`` is a property
#: GoHighLevel has never declared, and it answers those with a 422, so the escape hatch could
#: only ever produce a hard vendor error.
_BUSINESS_WRITE_PROPS = {
    'name': STR('Name of the business.'),
    'phone': STR('Phone number in E.164 form, for example "+18888888888".'),
    'email': STR('Email address.'),
    'website': STR('Website URL.'),
    'address': STR('Street address.'),
    'city': STR('City.'),
    'state': STR('State or region.'),
    'postalCode': STR('Postal code.'),
    'country': STR('Country, which GoHighLevel takes as free text here rather than as a 2-letter code.'),
    'description': STR('Free-text description of the business.'),
}

_BUSINESS_RECORD_OUTPUT = RECORD_OUTPUT('The business, trimmed to the fields this node returns.')

_BUSINESS_ITEMS = 'The businesses on this page, each trimmed to the fields this node returns.'


def _clean_business(business: Any) -> dict:
    """Trim a business record to the fields this node returns."""
    if not isinstance(business, dict):
        return {}
    return {key: business[key] for key in _BUSINESS_READ_KEYS if key in business}


def _business_write_result(payload: Any) -> dict:
    """Business record out of a create or update response, under whichever key it arrived on.

    Both writes are documented as answering ``{"success": ..., "buiseness": {...}}``, with the
    record key misspelled. The misspelling is read first because it is what the spec declares,
    the correct spelling is read second so a vendor fix does not turn every write into an empty
    record, and a bare record is accepted last because several neighbouring endpoints on this
    surface answer unwrapped.
    """
    if isinstance(payload, dict):
        for key in ('buiseness', 'business'):
            record = payload.get(key)
            if isinstance(record, dict):
                return _clean_business(record)
    return _clean_business(payload)


class BusinessesMixin(GoHighLevelToolsBase):
    """Tools for the ``businesses`` group."""

    @gohighlevel_tool(
        group='businesses',
        input_schema=schema(**PAGING_SKIP_TEXT('business_list')),
        description=(
            'List the businesses on the configured sub-account. A business is a company record inside one '
            'sub-account that contacts can be grouped under, not a sub-account of its own, and it is the id '
            'contact_list_by_business takes. This endpoint offers no filtering at all, so narrow the result '
            'yourself after reading it. Returns businesses under items. This one pages by offset rather than '
            'by cursor: next is the skip value for the following page, and it is null once a page comes back '
            'shorter than the limit that was asked for.'
        ),
        output_schema=LIST_OUTPUT(
            'Offset for the next page: pass it back as the skip parameter. Null once a page comes back shorter '
            'than the limit asked for, which means there is no next page.',
            items=_BUSINESS_ITEMS,
        ),
    )
    def business_list(self, args):
        args = self._args(args, 'business_list')
        params, limit = skip_text_params(args, 'business_list')
        params['locationId'] = self._location()
        # Live-confirmed as the one endpoint on this surface that wraps its payload with
        # "success": true alongside the records, which is why the records are read by their
        # envelope key rather than treated as the whole body.
        _, records = self._fetch('GET', '/businesses/', key='businesses', params=params)
        return paginated(
            [_clean_business(record) for record in records],
            next_cursor=next_offset(args.get('skip'), limit, len(records)),
            requested_limit=limit,
        )

    @gohighlevel_tool(
        group='businesses',
        input_schema=schema(required=['businessId'], businessId=STR('Id of the business.')),
        description=(
            'Get one business by id. Returns the same fields business_list returns, so call this only when you '
            'already have an id and not as a way to search: there is no business search endpoint.'
        ),
        output_schema=_BUSINESS_RECORD_OUTPUT,
    )
    def business_get(self, args):
        args = self._args(args, 'business_get')
        business_id = require_id(args, 'businessId', 'business_get')
        return self._get(f'/businesses/{business_id}', _clean_business, key='business')

    @gohighlevel_tool(
        group='businesses',
        writes=True,
        input_schema=schema(required=['name'], **_BUSINESS_WRITE_PROPS),
        description=(
            'Create a business on the configured sub-account. Only name is required. Creating a business does '
            'not move any contact into it: GoHighLevel assigns contacts to a business in its own UI, and this '
            'node has no tool that sets a contact businessId.'
        ),
        output_schema=_BUSINESS_RECORD_OUTPUT,
    )
    def business_create(self, args):
        args = self._args(args, 'business_create')
        body = body_from(args, _BUSINESS_WRITE_KEYS)
        body['locationId'] = self._location()
        return self._write('POST', '/businesses/', _business_write_result, body=body)

    @gohighlevel_tool(
        group='businesses',
        writes=True,
        input_schema=schema(
            required=['businessId'],
            businessId=STR('Id of the business to update.'),
            **_BUSINESS_WRITE_PROPS,
        ),
        description=(
            'Update a business. Only the fields you pass are changed, and every field is optional here, '
            'including name. The sub-account a business belongs to cannot be changed.'
        ),
        output_schema=_BUSINESS_RECORD_OUTPUT,
    )
    def business_update(self, args):
        args = self._args(args, 'business_update')
        business_id = require_id(args, 'businessId', 'business_update')
        body = body_from(args, _BUSINESS_WRITE_KEYS)
        return self._write('PUT', f'/businesses/{business_id}', _business_write_result, body=body)

    @gohighlevel_tool(
        group='businesses',
        writes=True,
        input_schema=schema(required=['businessId'], businessId=STR('Id of the business to delete.')),
        description=(
            'Delete a business by id. GoHighLevel does not document what happens to the contacts grouped under '
            'it, so read them with contact_list_by_business first if that matters.'
        ),
        output_schema=RECORD_OUTPUT(
            'Whether the delete succeeded, under deleted, with the raw GoHighLevel response under data.'
        ),
    )
    def business_delete(self, args):
        args = self._args(args, 'business_delete')
        business_id = require_id(args, 'businessId', 'business_delete')
        return self._delete(f'/businesses/{business_id}')
