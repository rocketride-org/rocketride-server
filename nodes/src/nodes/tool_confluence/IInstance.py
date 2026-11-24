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

"""
Confluence tool node instance.

Exposes CQL search, page read, create and update against Confluence Cloud as
@tool_function methods, authenticated with an Atlassian account email + API
token. See confluence_client.py for the API surface targeted.
"""

from __future__ import annotations

from typing import Any, Dict

from rocketlib import IInstanceBase, tool_function

from ai.common.utils import normalize_tool_input

from . import confluence_client as cc
from .IGlobal import IGlobal

_ERROR_SCHEMA = {'error': {'type': 'string'}}
_CONTENT_DESC = 'Page body. Plain text by default (blank line = new paragraph); see content_format.'
_FORMAT_PROP = {
    'type': 'string',
    'enum': ['text', 'storage'],
    'description': "'text' (default) converts plain text to paragraphs; 'storage' sends Confluence storage-format XHTML as-is.",
}


def _run(op) -> Dict[str, Any]:
    """Adapt ConfluenceAPIError / ValueError into the standard {success, error} envelope."""
    try:
        return {'success': True, **op()}
    except cc.ConfluenceAPIError as exc:
        return {'success': False, 'error': str(exc)}


def _body(args: Dict[str, Any]) -> str:
    content = args.get('content') or ''
    return content if args.get('content_format') == 'storage' else cc.text_to_storage(content)


class IInstance(IInstanceBase):
    """Node instance exposing Confluence search/read/write operations as agent tools."""

    IGlobal: IGlobal

    def _auth(self) -> Dict[str, str]:
        g = self.IGlobal
        return {'base_url': g.base_url, 'email': g.email, 'api_key': g.apikey}

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['cql'],
            'properties': {
                'cql': {'type': 'string', 'description': 'CQL query, e.g. \'type = page AND text ~ "onboarding"\'.'},
                'limit': {'type': 'integer', 'description': 'Max results (default 10, max 100).'},
                'start': {'type': 'integer', 'description': 'Offset for pagination (default 0).'},
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'success': {'type': 'boolean'},
                'results': {'type': 'array', 'items': {'type': 'object'}},
                'total_size': {'type': 'integer'},
                **_ERROR_SCHEMA,
            },
        },
        description='Search Confluence content with a CQL query. Returns id, title, type, space and url per hit.',
    )
    def confluence_search(self, args):
        """Search with CQL."""
        args = normalize_tool_input(args, tool_name='confluence_search')
        cql = (args.get('cql') or '').strip()

        def op():
            if not cql:
                raise cc.ConfluenceAPIError(0, 'cql is required')
            limit = args.get('limit')
            start = args.get('start')
            params = {
                'cql': cql,
                'limit': max(1, min(100, limit)) if isinstance(limit, int) and not isinstance(limit, bool) else 10,
                'start': max(0, start) if isinstance(start, int) and not isinstance(start, bool) else 0,
            }
            resp = cc.request('GET', '/rest/api/search', params=params, **self._auth())
            results = []
            for hit in resp.get('results', []):
                content = hit.get('content') or {}
                results.append(
                    {
                        'id': content.get('id'),
                        'type': content.get('type'),
                        'title': hit.get('title') or content.get('title'),
                        'space': (hit.get('resultGlobalContainer') or {}).get('title'),
                        'url': hit.get('url'),
                        'excerpt': hit.get('excerpt'),
                    }
                )
            return {'results': results, 'total_size': resp.get('totalSize', len(results))}

        return _run(op)

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['page_id'],
            'properties': {'page_id': {'type': 'string', 'description': 'Numeric page id.'}},
        },
        output_schema={
            'type': 'object',
            'properties': {
                'success': {'type': 'boolean'},
                'page_id': {'type': 'string'},
                'title': {'type': 'string'},
                'space_id': {'type': 'string'},
                'version': {'type': 'integer'},
                'text': {'type': 'string'},
                **_ERROR_SCHEMA,
            },
        },
        description='Read a Confluence page: title, current version number and body flattened to plain text.',
    )
    def confluence_get_page(self, args):
        """Read one page."""
        args = normalize_tool_input(args, tool_name='confluence_get_page')
        page_id = str(args.get('page_id') or '').strip()

        def op():
            if not page_id:
                raise cc.ConfluenceAPIError(0, 'page_id is required')
            page = cc.request('GET', f'/api/v2/pages/{page_id}', params={'body-format': 'storage'}, **self._auth())
            storage = ((page.get('body') or {}).get('storage') or {}).get('value', '')
            return {
                'page_id': page.get('id'),
                'title': page.get('title'),
                'space_id': page.get('spaceId'),
                'version': (page.get('version') or {}).get('number'),
                'text': cc.storage_to_text(storage),
            }

        return _run(op)

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['title'],
            'properties': {
                'title': {'type': 'string', 'description': 'Page title (unique within the space).'},
                'space_key': {
                    'type': 'string',
                    'description': 'Space key, e.g. ENG. One of space_key/space_id is required.',
                },
                'space_id': {'type': 'string', 'description': 'Numeric space id (alternative to space_key).'},
                'parent_id': {'type': 'string', 'description': 'Optional parent page id.'},
                'content': {'type': 'string', 'description': _CONTENT_DESC},
                'content_format': _FORMAT_PROP,
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
        description='Create a Confluence page in a space, optionally under a parent page.',
    )
    def confluence_create_page(self, args):
        """Create a page."""
        args = normalize_tool_input(args, tool_name='confluence_create_page')

        def op():
            title = (args.get('title') or '').strip()
            if not title:
                raise cc.ConfluenceAPIError(0, 'title is required')
            auth = self._auth()
            space_id = str(args.get('space_id') or '').strip()
            if not space_id:
                space_key = (args.get('space_key') or '').strip()
                if not space_key:
                    raise cc.ConfluenceAPIError(0, 'space_key or space_id is required')
                space_id = cc.resolve_space_id(space_key, **auth)
            body: Dict[str, Any] = {
                'spaceId': space_id,
                'status': 'current',
                'title': title,
                'body': {'representation': 'storage', 'value': _body(args)},
            }
            if args.get('parent_id'):
                body['parentId'] = str(args['parent_id'])
            page = cc.request('POST', '/api/v2/pages', json_body=body, **auth)
            webui = (page.get('_links') or {}).get('webui', '')
            return {'page_id': page.get('id'), 'url': f'{auth["base_url"]}{webui}' if webui else ''}

        return _run(op)

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['page_id'],
            'properties': {
                'page_id': {'type': 'string', 'description': 'Numeric page id.'},
                'title': {'type': 'string', 'description': 'New title (default: keep current).'},
                'content': {
                    'type': 'string',
                    'description': _CONTENT_DESC + ' Replaces the whole body; omit to keep it.',
                },
                'content_format': _FORMAT_PROP,
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'success': {'type': 'boolean'},
                'page_id': {'type': 'string'},
                'version': {'type': 'integer'},
                **_ERROR_SCHEMA,
            },
        },
        description='Update a Confluence page title and/or replace its body. Fetches the current version and increments it.',
    )
    def confluence_update_page(self, args):
        """Update a page (title and/or whole body)."""
        args = normalize_tool_input(args, tool_name='confluence_update_page')
        page_id = str(args.get('page_id') or '').strip()

        def op():
            if not page_id:
                raise cc.ConfluenceAPIError(0, 'page_id is required')
            if not args.get('title') and args.get('content') is None:
                raise cc.ConfluenceAPIError(0, 'provide title and/or content to update')
            auth = self._auth()
            current = cc.request('GET', f'/api/v2/pages/{page_id}', params={'body-format': 'storage'}, **auth)
            version = int((current.get('version') or {}).get('number') or 0) + 1
            if args.get('content') is not None:
                value = _body(args)
            else:
                value = ((current.get('body') or {}).get('storage') or {}).get('value', '')
            body = {
                'id': page_id,
                'status': current.get('status', 'current'),
                'title': (args.get('title') or '').strip() or current.get('title'),
                'body': {'representation': 'storage', 'value': value},
                'version': {'number': version},
            }
            cc.request('PUT', f'/api/v2/pages/{page_id}', json_body=body, **auth)
            return {'page_id': page_id, 'version': version}

        return _run(op)
