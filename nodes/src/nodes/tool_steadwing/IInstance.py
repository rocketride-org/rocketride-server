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
Steadwing tool node instance.

Exposes ``run_rca`` as a @tool_function: given an error / stack trace (and optional
source files), it calls Steadwing's root-cause-analysis API and returns the URL of
the Steadwing investigation where the cross-tool RCA runs.
"""

from __future__ import annotations

from typing import Any, Dict, List

from rocketlib import IInstanceBase, tool_function, warning

from ai.common.utils import normalize_tool_input, post_with_retry

from .IGlobal import IGlobal

# ---------------------------------------------------------------------------
# Steadwing API configuration
# ---------------------------------------------------------------------------

STEADWING_API_BASE = 'https://api.steadwing.com'
STEADWING_ANALYZE_ENDPOINT = f'{STEADWING_API_BASE}/api/mcp/analyze'
STEADWING_REQUEST_TIMEOUT = 60  # seconds
MAX_FILES = 20


class IInstance(IInstanceBase):
    """Node instance exposing Steadwing root-cause analysis as an agent tool."""

    IGlobal: IGlobal

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['error'],
            'properties': {
                'error': {
                    'type': 'string',
                    'description': (
                        'The complete error message, stack trace, or incident description to '
                        'analyze. Include as much context as possible — error type, message, '
                        'stack trace, line numbers, and what was happening when it occurred.'
                    ),
                },
                'files': {
                    'type': 'array',
                    'description': (
                        'Optional source files that give the analysis context (max 20). Start with '
                        'the file named in the stack trace, then its direct imports and any relevant '
                        'configuration.'
                    ),
                    'items': {
                        'type': 'object',
                        'required': ['name', 'content'],
                        'properties': {
                            'name': {
                                'type': 'string',
                                'description': 'Relative path from the project root, e.g. "src/app.js".',
                            },
                            'content': {
                                'type': 'string',
                                'description': 'Complete, unmodified file contents.',
                            },
                        },
                    },
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'success': {'type': 'boolean'},
                'incident_url': {
                    'type': 'string',
                    'description': 'URL of the Steadwing investigation where the RCA runs.',
                },
                'message': {'type': 'string'},
            },
        },
        description=(
            'Run AI-powered root-cause analysis on a production error or incident using Steadwing. '
            'Provide the full error message / stack trace as `error`, and the relevant source `files` '
            'when you have them. Steadwing correlates logs, metrics, traces, and code across the stack '
            'and returns the URL of an investigation that then runs in the background. Call this ONCE '
            'per incident — the returned URL is the deliverable; do not call it again or wait for more.'
        ),
    )
    def run_rca(self, args):
        """Open a Steadwing root-cause analysis for an error / incident."""
        args = normalize_tool_input(args, tool_name='steadwing')

        error_text = (args.get('error') or '').strip()
        if not error_text:
            raise ValueError('error is required and must be a non-empty string')

        payload: Dict[str, Any] = {'error_log': error_text}
        files = _normalize_files(args.get('files'))
        if files:
            payload['files'] = files

        headers = {
            'accept': 'application/json',
            'content-type': 'application/json',
            'X-API-Key': self.IGlobal.apikey,
        }

        resp = post_with_retry(
            STEADWING_ANALYZE_ENDPOINT, headers=headers, json=payload, timeout=STEADWING_REQUEST_TIMEOUT
        )
        try:
            body = resp.json()
        except ValueError as exc:
            # Malformed / non-JSON body. Log the status only — never the body,
            # which can echo the submitted error context — and re-raise.
            status = getattr(resp, 'status_code', None)
            warning(f'Steadwing API returned a non-JSON response body: status={status}')
            raise RuntimeError('Steadwing returned a non-JSON response body') from exc

        if not isinstance(body, dict):
            raise RuntimeError(f'Steadwing returned an unexpected payload type: {type(body).__name__}')

        api_error = body.get('error')
        if isinstance(api_error, dict):
            msg = api_error.get('message') or api_error.get('detail') or api_error.get('code') or 'unknown error'
            raise RuntimeError(f'Steadwing API error: {msg}')
        if api_error:
            raise RuntimeError(f'Steadwing API error: {api_error}')

        return _shape_result(body)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _normalize_files(files: Any) -> List[Dict[str, str]]:
    """Coerce the optional ``files`` argument into a clean ``[{name, content}]`` list (max 20)."""
    if not files:
        return []
    if not isinstance(files, list):
        raise ValueError('files must be an array of {name, content} objects')

    out: List[Dict[str, str]] = []
    for item in files[:MAX_FILES]:
        if not isinstance(item, dict):
            continue
        name = str(item.get('name') or '').strip()
        content = item.get('content')
        if not name or not isinstance(content, str):
            continue
        out.append({'name': name, 'content': content})
    return out


def _shape_result(body: Dict[str, Any]) -> Dict[str, Any]:
    """Extract the Steadwing investigation URL from an ``analyze`` response.

    The endpoint returns the URL either at the root or nested under ``data``
    (``{"data": {"incident_url": ...}}``); accept either, plus a few key spellings.
    """
    data = body.get('data') if isinstance(body.get('data'), dict) else {}
    incident_url = (
        data.get('incident_url')
        or data.get('incidentUrl')
        or data.get('url')
        or body.get('incident_url')
        or body.get('incidentUrl')
        or body.get('url')
        or ''
    )
    incident_url = str(incident_url or '').strip()
    if not incident_url:
        raise RuntimeError('Steadwing response did not include an investigation URL')

    return {
        'success': True,
        'incident_url': incident_url,
        'message': f'Root-cause analysis started. Track the investigation at {incident_url}',
    }
