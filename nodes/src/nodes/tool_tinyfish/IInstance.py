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
TinyFish tool node instance.

Exposes ``agent_run``, ``search``, and ``fetch`` tools for browser automation,
structured web search, and URL content extraction via TinyFish.
"""

from __future__ import annotations

import json
import time

from rocketlib import IInstanceBase, tool_function, warning

from tinyfish import CompleteEvent

from .utils import tinyfish_wrapper
from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['url', 'goal'],
            'properties': {
                'url': {'type': 'string', 'description': 'The URL for the agent to open.'},
                'goal': {'type': 'string', 'description': 'Plain-English description of what the agent should accomplish on the page.'},
                'timeout_s': {'type': 'number', 'description': 'Wall-clock timeout in seconds (defaults to the node-level default_timeout_s).'},
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'success': {'type': 'boolean'},
                'run_status': {'type': 'string', 'description': 'TinyFish RunStatus: COMPLETED, FAILED, CANCELLED, etc.'},
                'run_id': {'type': 'string'},
                'result': {'type': 'object', 'description': 'Structured result_json from the agent run.'},
                'goal_status': {'type': 'string', 'description': 'Goal-level status from result_json ("failure" when the goal was not achieved).'},
                'reason': {'type': 'string', 'description': 'Failure reason when goal_status == "failure".'},
                'error': {'type': 'object', 'description': 'RunError details when the run itself failed.'},
            },
        },
        description='Run a multi-step browser automation via TinyFish Agent and block until it completes.',
    )
    def agent_run(self, args):
        """Run a TinyFish agent automation to completion."""
        args = _normalize_tool_input(args)
        url = args.get('url')
        goal = args.get('goal')
        if not url:
            raise ValueError('agent_run requires a `url` parameter')
        if not goal:
            raise ValueError('agent_run requires a `goal` parameter')

        try:
            timeout_s = float(args.get('timeout_s') or self.IGlobal.default_timeout_s)
        except (TypeError, ValueError):
            timeout_s = self.IGlobal.default_timeout_s

        def _run():
            started = time.monotonic()
            complete_event = None
            with self.IGlobal.app.agent.stream(goal=goal, url=url) as stream:
                for event in stream:
                    if isinstance(event, CompleteEvent):
                        complete_event = event
                        break
                    if time.monotonic() - started > timeout_s:
                        raise TimeoutError(f'agent_run exceeded {timeout_s}s wall-clock timeout')
            if complete_event is None:
                raise RuntimeError('agent_run stream ended without a CompleteEvent')
            return complete_event

        event = tinyfish_wrapper(_run)

        run_status = event.status.value if hasattr(event.status, 'value') else str(event.status)
        result_json = event.result_json if isinstance(event.result_json, dict) else {}
        goal_status = result_json.get('status') if isinstance(result_json, dict) else None
        reason = result_json.get('reason') if goal_status == 'failure' else None

        error = None
        if event.error is not None:
            try:
                error = event.error.model_dump(exclude_none=True)
            except Exception as e:
                warning(f'tinyfish: failed to dump RunError: {e}')
                error = {'message': str(event.error)}

        success = run_status == 'COMPLETED' and goal_status != 'failure' and error is None

        out = {
            'success': success,
            'run_status': run_status,
            'run_id': event.run_id,
            'result': result_json,
        }
        if goal_status is not None:
            out['goal_status'] = goal_status
        if reason is not None:
            out['reason'] = reason
        if error is not None:
            out['error'] = error
        return out

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['query'],
            'properties': {
                'query': {'type': 'string', 'description': 'Search query string.'},
                'location': {'type': 'string', 'description': 'Two-letter country code (e.g., "US", "FR") for geo-targeted results.'},
                'language': {'type': 'string', 'description': 'Two-letter language code (e.g., "en", "fr").'},
                'limit': {'type': 'integer', 'description': 'Optional cap on the number of results returned (applied client-side).'},
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'success': {'type': 'boolean'},
                'query': {'type': 'string'},
                'total_results': {'type': 'integer'},
                'results': {
                    'type': 'array',
                    'items': {
                        'type': 'object',
                        'properties': {
                            'position': {'type': 'integer'},
                            'site_name': {'type': 'string'},
                            'title': {'type': 'string'},
                            'snippet': {'type': 'string'},
                            'url': {'type': 'string'},
                        },
                    },
                },
            },
        },
        description='Run a structured web search via TinyFish and return ranked results.',
    )
    def search(self, args):
        """Run a TinyFish structured web search."""
        args = _normalize_tool_input(args)
        query = args.get('query')
        if not query:
            raise ValueError('search requires a `query` parameter')

        kwargs = {}
        if args.get('location'):
            kwargs['location'] = args['location']
        if args.get('language'):
            kwargs['language'] = args['language']

        response = tinyfish_wrapper(lambda: self.IGlobal.app.search.query(query, **kwargs))

        results = []
        for r in getattr(response, 'results', None) or []:
            if hasattr(r, 'model_dump'):
                results.append(r.model_dump(exclude_none=True))
            elif isinstance(r, dict):
                results.append(r)

        limit = args.get('limit')
        if isinstance(limit, int) and limit > 0:
            results = results[:limit]

        return {
            'success': True,
            'query': getattr(response, 'query', query),
            'total_results': getattr(response, 'total_results', len(results)),
            'results': results,
        }

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['url'],
            'properties': {
                'url': {'type': 'string', 'description': 'URL to fetch and extract clean content from.'},
                'format': {'type': 'string', 'enum': ['markdown', 'html', 'json'], 'description': 'Output format (default: provider default).'},
                'links': {'type': 'boolean', 'description': 'Include extracted links in the result.'},
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'success': {'type': 'boolean'},
                'url': {'type': 'string'},
                'final_url': {'type': 'string'},
                'title': {'type': 'string'},
                'description': {'type': 'string'},
                'language': {'type': 'string'},
                'text': {'type': 'string'},
                'links': {'type': 'array', 'items': {'type': 'string'}},
                'error': {'type': 'string'},
            },
        },
        description='Fetch a URL via TinyFish Fetch (renders JavaScript) and return cleaned content.',
    )
    def fetch(self, args):
        """Fetch a single URL and return extracted content."""
        args = _normalize_tool_input(args)
        url = args.get('url')
        if not url:
            raise ValueError('fetch requires a `url` parameter')

        kwargs = {}
        if args.get('format'):
            kwargs['format'] = args['format']
        if args.get('links') is not None:
            kwargs['links'] = bool(args['links'])

        response = tinyfish_wrapper(lambda: self.IGlobal.app.fetch.get_contents(urls=[url], **kwargs))

        results = getattr(response, 'results', None) or []
        errors = getattr(response, 'errors', None) or []

        if not results:
            err_msg = 'fetch returned no results'
            if errors:
                first = errors[0]
                try:
                    err_msg = first.model_dump(exclude_none=True) if hasattr(first, 'model_dump') else str(first)
                except Exception:
                    err_msg = str(first)
            return {'success': False, 'url': url, 'error': err_msg if isinstance(err_msg, str) else json.dumps(err_msg)}

        result = results[0]
        if hasattr(result, 'model_dump'):
            payload = result.model_dump(exclude_none=True)
        elif isinstance(result, dict):
            payload = result
        else:
            payload = {'url': url}
        payload['success'] = True
        return payload


def _normalize_tool_input(input_obj):
    """Normalize tool input into a plain dict.

    Handles: None, dict, Pydantic model, JSON string, and nested
    ``input`` wrappers that some framework paths produce.
    """
    if input_obj is None:
        return {}
    if hasattr(input_obj, 'model_dump') and callable(getattr(input_obj, 'model_dump')):
        input_obj = input_obj.model_dump()
    elif hasattr(input_obj, 'dict') and callable(getattr(input_obj, 'dict')):
        input_obj = input_obj.dict()
    if isinstance(input_obj, str):
        try:
            parsed = json.loads(input_obj)
            if isinstance(parsed, dict):
                input_obj = parsed
        except (json.JSONDecodeError, TypeError) as e:
            warning(f'tinyfish: failed to parse input as JSON: {e}')
            pass
    if not isinstance(input_obj, dict):
        warning(f'tinyfish: unexpected input type {type(input_obj).__name__}')
        return {}
    if 'input' in input_obj and isinstance(input_obj['input'], dict):
        inner = input_obj['input']
        extras = {k: v for k, v in input_obj.items() if k != 'input'}
        input_obj = {**inner, **extras}
    input_obj.pop('security_context', None)
    return input_obj
