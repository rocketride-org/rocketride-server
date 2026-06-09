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
v0 by Vercel tool node instance.

Exposes ``generate_ui`` and ``refine_ui`` tools that drive Vercel's v0
Platform API (server-side stateful chats) to generate React + Tailwind UI
components from natural-language prompts.
"""

from __future__ import annotations

from typing import Any, Dict, List

from rocketlib import IInstanceBase, tool_function, warning

from ai.common.utils import normalize_tool_input, post_with_retry

from .IGlobal import IGlobal

# ---------------------------------------------------------------------------
# v0 Platform API configuration
# ---------------------------------------------------------------------------

V0_API_BASE = 'https://api.v0.dev/v1'
V0_CHATS_ENDPOINT = f'{V0_API_BASE}/chats'
V0_REQUEST_TIMEOUT = 120  # seconds — generation can take a while


class IInstance(IInstanceBase):
    """Node instance exposing v0 generative UI as agent tools."""

    IGlobal: IGlobal

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['prompt'],
            'properties': {
                'prompt': {
                    'type': 'string',
                    'description': 'A natural-language description of the UI component to generate.',
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'success': {'type': 'boolean'},
                'chat_id': {'type': 'string', 'description': 'v0 chat ID — pass to refine_ui to iterate.'},
                'code': {'type': 'string', 'description': 'Primary generated React component code.'},
                'files': {'type': 'array', 'items': {'type': 'object'}, 'description': 'All generated files.'},
                'demo_url': {'type': 'string', 'description': 'Live preview URL for the generated UI.'},
            },
        },
        description='Generate a React UI component from a natural-language description. Provide a detailed prompt describing the desired UI and receive production-ready React + Tailwind CSS code, a live demo URL, and a chat_id for follow-up refinements via refine_ui.',
    )
    def generate_ui(self, args):
        """Generate a React UI component from a text prompt via the v0 Platform API."""
        args = normalize_tool_input(args, tool_name='v0')

        prompt = (args.get('prompt') or '').strip()
        if not prompt:
            raise ValueError('prompt is required and must be a non-empty string')

        body = self._call_v0(V0_CHATS_ENDPOINT, prompt)
        return _shape_chat(body)

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['prompt', 'chat_id'],
            'properties': {
                'prompt': {
                    'type': 'string',
                    'description': 'Follow-up instructions describing how to change the component.',
                },
                'chat_id': {
                    'type': 'string',
                    'description': 'The chat_id returned from a previous generate_ui or refine_ui call.',
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'success': {'type': 'boolean'},
                'chat_id': {'type': 'string', 'description': 'v0 chat ID — reuse for further refinements.'},
                'code': {'type': 'string', 'description': 'Primary refined React component code.'},
                'files': {'type': 'array', 'items': {'type': 'object'}, 'description': 'All generated files.'},
                'demo_url': {'type': 'string', 'description': 'Live preview URL for the refined UI.'},
            },
        },
        description='Refine a previously generated UI component by sending follow-up instructions to an existing v0 chat. Requires the chat_id from a prior generate_ui call. The v0 chat is stateful server-side, so prior context need not be replayed.',
    )
    def refine_ui(self, args):
        """Refine a previously generated UI component via the v0 Platform API."""
        args = normalize_tool_input(args, tool_name='v0')

        prompt = (args.get('prompt') or '').strip()
        if not prompt:
            raise ValueError('prompt is required and must be a non-empty string')

        chat_id = (args.get('chat_id') or '').strip()
        if not chat_id:
            raise ValueError('chat_id is required — pass the value returned by a prior generate_ui call')

        url = f'{V0_CHATS_ENDPOINT}/{chat_id}/messages'
        body = self._call_v0(url, prompt)
        shaped = _shape_chat(body)
        # The follow-up response may omit the chat id; fall back to the known one.
        if not shaped.get('chat_id'):
            shaped['chat_id'] = chat_id
        return shaped

    def _call_v0(self, url: str, prompt: str) -> Dict[str, Any]:
        """POST a prompt to a v0 Platform API endpoint and return the parsed body.

        Error handling is left to the framework: ``_dispatch_tool`` calls tool
        methods with no try/except (exceptions propagate) and ``run_agent``
        converts any raised exception into a structured error payload. So a
        transport/HTTP failure, a non-JSON body, or an API-level error each
        raise rather than returning an error dict. Never logs response bodies.
        """
        headers = {
            'Authorization': f'Bearer {self.IGlobal.apikey}',
            'Content-Type': 'application/json',
        }

        resp = post_with_retry(url, headers=headers, json={'message': prompt}, timeout=V0_REQUEST_TIMEOUT)
        try:
            body = resp.json()
        except ValueError as exc:
            # resp.json() raises on a malformed/non-JSON body. Log status only
            # (never the body, which may carry sensitive content) and re-raise.
            status = getattr(resp, 'status_code', None)
            warning(f'v0 API returned a non-JSON response body: status={status}')
            raise RuntimeError('v0 returned a non-JSON response body') from exc

        if not isinstance(body, dict):
            raise RuntimeError(f'v0 returned an unexpected payload type: {type(body).__name__}')

        # Platform API errors come back as {"error": {...}} — raise with a message.
        api_error = body.get('error')
        if isinstance(api_error, dict):
            msg = api_error.get('message') or api_error.get('userMessage') or api_error.get('code') or 'unknown error'
            raise RuntimeError(f'v0 API error: {msg}')
        if api_error:
            raise RuntimeError(f'v0 API error: {api_error}')

        return body


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _shape_chat(body: Dict[str, Any]) -> Dict[str, Any]:
    """Map a v0 Platform API chat object into the tool's output schema.

    The chat shape is ``{id, latestVersion: {demoUrl, files: [{name, content}]}}``.
    ``latestVersion`` and ``files`` are nullable, so every level is guarded.
    """
    chat_id = body.get('id') or ''
    latest = body.get('latestVersion')
    if not isinstance(latest, dict):
        latest = {}

    demo_url = latest.get('demoUrl') or ''

    raw_files = latest.get('files')
    files: List[Dict[str, str]] = []
    if isinstance(raw_files, list):
        for item in raw_files:
            if not isinstance(item, dict):
                continue
            files.append({'name': item.get('name', ''), 'content': item.get('content', '')})

    if not files:
        raise RuntimeError('v0 returned no files')

    return {
        'success': True,
        'chat_id': chat_id,
        'code': files[0]['content'],
        'files': files,
        'demo_url': demo_url,
    }
