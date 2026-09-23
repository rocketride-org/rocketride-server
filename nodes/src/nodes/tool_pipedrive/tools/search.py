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

"""Global search tools that span every Pipedrive item type."""

from __future__ import annotations

from ..pipedrive_client import clean_search_item, paginated, paginated_v2
from ..tool_groups import pipedrive_tool
from ._base import (
    BOOL,
    ENUM,
    INT,
    PAGING,
    PAGING_V2,
    STR,
    PipedriveToolsBase,
    args_of,
    paging_params,
    paging_params_v2,
    params_from,
    require_text,
    schema,
)


class SearchMixin(PipedriveToolsBase):
    """Tools for the ``search`` group."""

    @pipedrive_tool(
        group='search',
        input_schema=schema(
            required=['term'],
            term=STR('Search term, at least 2 characters (1 when exact_match is true).'),
            item_types=STR(
                'Comma-separated item types to search: deal, person, organization, product, lead, file, '
                'mail_attachment, project. Omit to search everything.'
            ),
            fields=STR(
                'Comma-separated fields to search in, e.g. "name,title,notes,custom_fields". '
                'Must be valid for the chosen item_types.'
            ),
            search_for_related_items=BOOL('Also return the deals and persons related to each match.'),
            exact_match=BOOL('Require an exact, case-sensitive match.'),
            include_fields=STR('Extra fields to include in the results, e.g. "deal.cc_email".'),
            **PAGING_V2(),
        ),
        description='Search across every Pipedrive item type at once — deals, persons, organizations, products, leads, files and projects. Use this when you do not know which record type holds the answer.',
    )
    def item_search(self, args):
        args = args_of(args)
        params = paging_params_v2(args)
        params['term'] = require_text(args, 'term', 'item_search')
        params.update(
            params_from(args, ('item_types', 'fields', 'search_for_related_items', 'exact_match', 'include_fields'))
        )
        envelope = self._call_envelope_v2('GET', '/itemSearch', params=params)
        data = envelope.get('data') or {}
        items = data.get('items') or []
        result = paginated_v2(envelope, [clean_search_item(i) for i in items])
        if data.get('related_items'):
            result['related_items'] = [clean_search_item(i) for i in data['related_items']]
        return result

    @pipedrive_tool(
        group='search',
        input_schema=schema(
            required=['term', 'entity_type', 'field_key'],
            term=STR('Value to look for in the field.'),
            # v2 renamed this from `field_type` and dropped the "Field" suffix on
            # every value: v1 took `personField`, v2 takes `person`.
            entity_type=ENUM(
                'Which entity the field belongs to.',
                [
                    'deal',
                    'leads',
                    'person',
                    'organization',
                    'product',
                    'project',
                ],
            ),
            field_key=STR('Key of the field to search, e.g. "title" or a 40-character custom field key.'),
            # v2 replaced the v1 `exact_match` boolean with a three-way match mode.
            match=ENUM(
                'How the term must line up with the field value (default "exact").',
                ['exact', 'beginning', 'middle'],
            ),
            **PAGING_V2(),
        ),
        description='Search a single field for a value — for example find every deal whose custom "Contract number" field starts with a string. Returns distinct field values.',
    )
    def item_search_by_field(self, args):
        args = args_of(args)
        params = paging_params_v2(args)
        params['term'] = require_text(args, 'term', 'item_search_by_field')
        params['entity_type'] = require_text(args, 'entity_type', 'item_search_by_field')
        params['field_key'] = require_text(args, 'field_key', 'item_search_by_field')
        params.update(params_from(args, ('match',)))
        envelope = self._call_envelope_v2('GET', '/itemSearch/field', params=params)
        data = envelope.get('data') if isinstance(envelope, dict) else None
        return paginated_v2(envelope, list(data or []))

    @pipedrive_tool(
        group='search',
        input_schema=schema(
            required=['since_timestamp'],
            since_timestamp=STR('Return everything changed after this UTC timestamp, "YYYY-MM-DD HH:MM:SS".'),
            items=STR(
                'Comma-separated item types to include: activity, activityType, deal, file, filter, note, '
                'person, organization, pipeline, product, stage, user.'
            ),
            **PAGING(),
        ),
        description='List every record created or changed since a timestamp. Use this to sync a CRM snapshot incrementally instead of re-listing everything.',
    )
    def recents_list(self, args):
        args = args_of(args)
        params = paging_params(args)
        params['since_timestamp'] = require_text(args, 'since_timestamp', 'recents_list')
        params.update(params_from(args, ('items',)))
        envelope = self._call_envelope('GET', '/recents', params=params)
        data = envelope.get('data') if isinstance(envelope, dict) else None
        return paginated(envelope, list(data or []))

    @pipedrive_tool(
        group='search',
        input_schema=schema(
            required=['term'],
            term=STR('Search term, at least 2 characters.'),
            item_types=STR('Comma-separated item types to search. Omit to search everything.'),
            limit=INT('Maximum number of matches to return (default 10).'),
        ),
        description='Quick global lookup that returns just the id, type and name of each match. Cheaper than item_search when you only need to resolve a name to an id.',
    )
    def lookup(self, args):
        args = args_of(args)
        params = {
            'term': require_text(args, 'term', 'lookup'),
            'limit': max(1, min(int(args.get('limit') or 10), 100)),
        }
        params.update(params_from(args, ('item_types',)))
        envelope = self._call_envelope_v2('GET', '/itemSearch', params=params)
        items = ((envelope.get('data') or {}).get('items')) or []
        out = []
        for entry in items:
            inner = entry.get('item') if isinstance(entry, dict) else None
            if isinstance(inner, dict):
                out.append(
                    {
                        'id': inner.get('id'),
                        'type': inner.get('type'),
                        'name': inner.get('name') or inner.get('title'),
                    }
                )
        return {'items': out, 'count': len(out)}
