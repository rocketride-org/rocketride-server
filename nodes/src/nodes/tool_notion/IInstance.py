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

"""
Notion tool node instance.

Exposes search, read, and write operations against a Notion workspace as
@tool_function methods, using an internal integration secret (a single API
key, no OAuth). See notion_client.py's module docstring for the verified API
surface this targets.
"""

from __future__ import annotations

from typing import Any, Dict

from rocketlib import IInstanceBase, tool_function

from ai.common.utils import normalize_tool_input

from . import notion_client
from .IGlobal import IGlobal

_ERROR_SCHEMA = {'error': {'type': 'string'}}


def _run(op: Dict[str, Any]) -> Dict[str, Any]:
    """Adapt a NotionAPIError into the standard {success, error} envelope.

    ``op`` is a zero-arg-equivalent call already bound with its arguments;
    on success its return value (a dict) is merged into {'success': True}.
    """
    try:
        result = op()
        return {'success': True, **result}
    except notion_client.NotionAPIError as exc:
        return {'success': False, 'error': str(exc)}


class IInstance(IInstanceBase):
    """Node instance exposing Notion search/read/write operations as agent tools."""

    IGlobal: IGlobal

    # -------------------------------------------------------------------
    # Search
    # -------------------------------------------------------------------

    @tool_function(
        input_schema={
            'type': 'object',
            'properties': {
                'query': {'type': 'string', 'description': 'Text to search for in page and database titles.'},
                'filter_type': {
                    'type': 'string',
                    'enum': ['page', 'data_source'],
                    'description': 'Restrict results to only pages or only databases (data sources).',
                },
                'page_size': {'type': 'integer', 'description': 'Max results (default 10, max 100).'},
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'success': {'type': 'boolean'},
                'results': {'type': 'array', 'items': {'type': 'object'}},
                'has_more': {'type': 'boolean'},
                'next_cursor': {'type': ['string', 'null']},
                **_ERROR_SCHEMA,
            },
        },
        description=(
            'Search the Notion workspace by title text across pages and databases the integration has been '
            'shared with. Use this to find a page or database id before reading or writing it.'
        ),
    )
    def notion_search(self, args):
        """Search pages and databases by title text."""
        args = normalize_tool_input(args, tool_name='notion_search')
        query = (args.get('query') or '').strip()
        filter_type = args.get('filter_type')
        page_size = args.get('page_size')

        def op():
            body: Dict[str, Any] = {}
            if query:
                body['query'] = query
            if filter_type in ('page', 'data_source'):
                body['filter'] = {'property': 'object', 'value': filter_type}
            if isinstance(page_size, int) and not isinstance(page_size, bool):
                body['page_size'] = max(1, min(100, page_size))
            resp = notion_client.request('POST', '/search', api_key=self.IGlobal.apikey, json_body=body)
            return {
                'results': resp.get('results', []),
                'has_more': resp.get('has_more', False),
                'next_cursor': resp.get('next_cursor'),
            }

        return _run(op)

    # -------------------------------------------------------------------
    # Databases
    # -------------------------------------------------------------------

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['database_id'],
            'properties': {
                'database_id': {'type': 'string', 'description': 'The database (container) id.'},
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'success': {'type': 'boolean'},
                'title': {'type': 'string'},
                'data_sources': {'type': 'array', 'items': {'type': 'object'}},
                **_ERROR_SCHEMA,
            },
        },
        description=(
            "Get a Notion database's title and its data sources (id + name). A database with more than one "
            'data source needs a data_source_id passed to notion_query_database to disambiguate which one to query.'
        ),
    )
    def notion_get_database(self, args):
        """Retrieve a database's title and data sources."""
        args = normalize_tool_input(args, tool_name='notion_get_database')
        database_id = (args.get('database_id') or '').strip()
        if not database_id:
            return {'success': False, 'error': 'notion_get_database: "database_id" is required'}

        def op():
            resp = notion_client.request('GET', f'/databases/{database_id}', api_key=self.IGlobal.apikey)
            title_parts = resp.get('title') or []
            title = ''.join(t.get('plain_text', '') for t in title_parts if isinstance(t, dict))
            return {'title': title, 'data_sources': resp.get('data_sources', [])}

        return _run(op)

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['database_id'],
            'properties': {
                'database_id': {'type': 'string', 'description': 'The database (container) id.'},
                'data_source_id': {
                    'type': 'string',
                    'description': 'Which data source to query, only needed if the database has more than one.',
                },
                'filter': {
                    'type': 'object',
                    'description': "A Notion filter object, e.g. {'property': 'Status', 'select': {'equals': 'Done'}}.",
                },
                'sorts': {
                    'type': 'array',
                    'items': {'type': 'object'},
                    'description': 'A list of Notion sort objects.',
                },
                'page_size': {'type': 'integer', 'description': 'Max results per page (default 100, max 100).'},
                'start_cursor': {
                    'type': 'string',
                    'description': "Pagination cursor from a previous call's next_cursor.",
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'success': {'type': 'boolean'},
                'results': {'type': 'array', 'items': {'type': 'object'}},
                'has_more': {'type': 'boolean'},
                'next_cursor': {'type': ['string', 'null']},
                **_ERROR_SCHEMA,
            },
        },
        description=(
            'Query the rows (pages) of a Notion database matching an optional filter/sort. Each result is a '
            'page whose "properties" holds the row\'s field values. Use notion_get_database first to see field '
            'names, or notion_search to find the database_id.'
        ),
    )
    def notion_query_database(self, args):
        """Query a database's entries by filter/sort."""
        args = normalize_tool_input(args, tool_name='notion_query_database')
        database_id = (args.get('database_id') or '').strip()
        if not database_id:
            return {'success': False, 'error': 'notion_query_database: "database_id" is required'}

        def op():
            data_source_id = notion_client.resolve_data_source_id(
                database_id, api_key=self.IGlobal.apikey, data_source_id=args.get('data_source_id')
            )
            body: Dict[str, Any] = {}
            if args.get('filter'):
                body['filter'] = args['filter']
            if args.get('sorts'):
                body['sorts'] = args['sorts']
            page_size = args.get('page_size')
            if isinstance(page_size, int) and not isinstance(page_size, bool):
                body['page_size'] = max(1, min(100, page_size))
            if args.get('start_cursor'):
                body['start_cursor'] = args['start_cursor']
            resp = notion_client.request(
                'POST', f'/data_sources/{data_source_id}/query', api_key=self.IGlobal.apikey, json_body=body
            )
            return {
                'results': resp.get('results', []),
                'has_more': resp.get('has_more', False),
                'next_cursor': resp.get('next_cursor'),
            }

        return _run(op)

    # -------------------------------------------------------------------
    # Pages
    # -------------------------------------------------------------------

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['page_id'],
            'properties': {'page_id': {'type': 'string', 'description': 'The page id.'}},
        },
        output_schema={
            'type': 'object',
            'properties': {
                'success': {'type': 'boolean'},
                'properties': {'type': 'object'},
                'url': {'type': 'string'},
                'in_trash': {'type': 'boolean'},
                **_ERROR_SCHEMA,
            },
        },
        description=(
            "Get a page's properties (its database row field values, if it belongs to a database) and metadata. "
            'This does NOT return the page body -- use notion_get_page_content for that.'
        ),
    )
    def notion_get_page(self, args):
        """Retrieve a page's properties and metadata."""
        args = normalize_tool_input(args, tool_name='notion_get_page')
        page_id = (args.get('page_id') or '').strip()
        if not page_id:
            return {'success': False, 'error': 'notion_get_page: "page_id" is required'}

        def op():
            resp = notion_client.request('GET', f'/pages/{page_id}', api_key=self.IGlobal.apikey)
            return {
                'properties': resp.get('properties', {}),
                'url': resp.get('url', ''),
                'in_trash': bool(resp.get('in_trash')),
            }

        return _run(op)

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['page_id'],
            'properties': {
                'page_id': {'type': 'string', 'description': 'The page (or block) id.'},
                'max_depth': {
                    'type': 'integer',
                    'description': 'How many levels of nested blocks to follow (default 4).',
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {'success': {'type': 'boolean'}, 'text': {'type': 'string'}, **_ERROR_SCHEMA},
        },
        description=(
            "Get a page's body content as plain text, flattened from Notion's block tree (one block per line, "
            'nested content indented). Use this to read a page for summarization or RAG ingestion.'
        ),
    )
    def notion_get_page_content(self, args):
        """Retrieve and flatten a page's content to plain text."""
        args = normalize_tool_input(args, tool_name='notion_get_page_content')
        page_id = (args.get('page_id') or '').strip()
        if not page_id:
            return {'success': False, 'error': 'notion_get_page_content: "page_id" is required'}
        max_depth = args.get('max_depth', 4)
        if not isinstance(max_depth, int) or isinstance(max_depth, bool):
            max_depth = 4

        def op():
            text = notion_client.get_page_content(page_id, api_key=self.IGlobal.apikey, max_depth=max_depth)
            return {'text': text}

        return _run(op)

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['parent_id', 'parent_type'],
            'properties': {
                'parent_id': {'type': 'string', 'description': 'The id of the parent page or data source.'},
                'parent_type': {
                    'type': 'string',
                    'enum': ['page', 'data_source'],
                    'description': "'page' to create a sub-page, 'data_source' to create a new database row.",
                },
                'title': {'type': 'string', 'description': "The new page's title (its title property)."},
                'properties': {
                    'type': 'object',
                    'description': (
                        'Additional Notion property values for a data_source-parented page (database row), in '
                        "Notion's own property-value shape, e.g. {'Status': {'select': {'name': 'Todo'}}}. Ignored "
                        'for a page parent, which only accepts a title.'
                    ),
                },
                'content': {
                    'type': 'string',
                    'description': 'Initial body text; each line becomes one paragraph block.',
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'success': {'type': 'boolean'},
                'page_id': {'type': 'string'},
                'url': {'type': 'string'},
                **_ERROR_SCHEMA,
            },
        },
        description=(
            'Create a new Notion page: either a sub-page under another page, or a new row in a database (data '
            'source). Optionally set initial body text.'
        ),
    )
    def notion_create_page(self, args):
        """Create a page, either as a sub-page or a new database row."""
        args = normalize_tool_input(args, tool_name='notion_create_page')
        parent_id = (args.get('parent_id') or '').strip()
        parent_type = args.get('parent_type')
        if not parent_id or parent_type not in ('page', 'data_source'):
            return {
                'success': False,
                'error': 'notion_create_page: "parent_id" and "parent_type" ("page" or "data_source") are required',
            }
        title = (args.get('title') or '').strip()

        def op():
            # Notion's parent.type value is 'page_id'/'data_source_id' (the key
            # name it's paired with), not the bare 'page'/'data_source'.
            parent_key = 'page_id' if parent_type == 'page' else 'data_source_id'
            body: Dict[str, Any] = {'parent': {'type': parent_key, parent_key: parent_id}}

            properties: Dict[str, Any] = dict(args.get('properties') or {})
            if title:
                # A caller-supplied `properties` may already name the title
                # field explicitly; only default it in when absent.
                has_title_prop = any(isinstance(v, dict) and 'title' in v for v in properties.values())
                if not has_title_prop:
                    if parent_type == 'page':
                        title_key = 'title'
                    else:
                        # A database's title property is per-schema (e.g. "Task"
                        # instead of "Name"), so look it up rather than guess.
                        title_key = notion_client.get_title_property_name(parent_id, api_key=self.IGlobal.apikey)
                    properties[title_key] = notion_client.title_property(title)
            body['properties'] = properties

            content = args.get('content')
            if content:
                body['children'] = notion_client.paragraph_blocks(content)

            # Page creation is a non-idempotent mutation: a connection error or
            # 5xx of unknown outcome must not be blindly retried and risk
            # creating a duplicate page.
            resp = notion_client.request('POST', '/pages', api_key=self.IGlobal.apikey, json_body=body, max_retries=0)
            return {'page_id': resp.get('id', ''), 'url': resp.get('url', '')}

        return _run(op)

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['page_id'],
            'properties': {
                'page_id': {'type': 'string', 'description': 'The page id.'},
                'properties': {
                    'type': 'object',
                    'description': "Property values to update, in Notion's own property-value shape.",
                },
                'in_trash': {'type': 'boolean', 'description': 'Move to trash (true) or restore (false) the page.'},
            },
        },
        output_schema={
            'type': 'object',
            'properties': {'success': {'type': 'boolean'}, 'page_id': {'type': 'string'}, **_ERROR_SCHEMA},
        },
        description="Update a page's property values and/or trash/restore it.",
    )
    def notion_update_page(self, args):
        """Update a page's properties and/or trashed status."""
        args = normalize_tool_input(args, tool_name='notion_update_page')
        page_id = (args.get('page_id') or '').strip()
        if not page_id:
            return {'success': False, 'error': 'notion_update_page: "page_id" is required'}
        properties = args.get('properties')
        in_trash = args.get('in_trash')
        if not properties and in_trash is None:
            return {'success': False, 'error': 'notion_update_page: pass "properties" and/or "in_trash"'}

        def op():
            body: Dict[str, Any] = {}
            if properties:
                body['properties'] = properties
            if isinstance(in_trash, bool):
                body['in_trash'] = in_trash
            # A page update is a non-idempotent mutation -- see notion_create_page.
            notion_client.request(
                'PATCH', f'/pages/{page_id}', api_key=self.IGlobal.apikey, json_body=body, max_retries=0
            )
            return {'page_id': page_id}

        return _run(op)

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['block_id', 'text'],
            'properties': {
                'block_id': {'type': 'string', 'description': 'The page or block id to append content to.'},
                'text': {'type': 'string', 'description': 'Text to append; each line becomes one paragraph block.'},
            },
        },
        output_schema={
            'type': 'object',
            'properties': {'success': {'type': 'boolean'}, 'appended': {'type': 'integer'}, **_ERROR_SCHEMA},
        },
        description="Append text to the end of a page's (or block's) body content, one paragraph per line.",
    )
    def notion_append_content(self, args):
        """Append paragraph blocks to a page or block's content."""
        args = normalize_tool_input(args, tool_name='notion_append_content')
        block_id = (args.get('block_id') or '').strip()
        text = args.get('text') or ''
        if not block_id or not text.strip():
            return {'success': False, 'error': 'notion_append_content: "block_id" and non-empty "text" are required'}

        def op():
            blocks = notion_client.paragraph_blocks(text)
            appended = notion_client.append_block_children(block_id, blocks, api_key=self.IGlobal.apikey)
            return {'appended': appended}

        return _run(op)
