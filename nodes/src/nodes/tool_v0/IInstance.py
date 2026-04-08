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

Exposes ``generate_ui`` and ``refine_ui`` tools for generating React UI
components via Vercel's v0 generative UI API.
"""

from __future__ import annotations

import json
from typing import Any, Dict, List

import httpx

from rocketlib import IInstanceBase, tool_function, warning

from .IGlobal import IGlobal

# ---------------------------------------------------------------------------
# v0 API configuration
# ---------------------------------------------------------------------------

V0_API_BASE = 'https://api.v0.dev/v1'
V0_GENERATE_ENDPOINT = f'{V0_API_BASE}/chat'
V0_REQUEST_TIMEOUT = 120  # seconds — generation can take a while


class IInstance(IInstanceBase):
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
                'model': {
                    'type': 'string',
                    'description': 'The v0 model to use (default: "v0-1.0-md").',
                    'default': 'v0-1.0-md',
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'success': {'type': 'boolean'},
                'code': {'type': 'string', 'description': 'Generated React component code.'},
                'message_id': {'type': 'string', 'description': 'v0 message ID for follow-up refinements.'},
                'error': {'type': 'string', 'description': 'Error message on failure.'},
            },
        },
        description='Generate a React UI component from a natural-language description. Provide a detailed prompt describing the desired UI and receive production-ready React + Tailwind CSS code.',
    )
    def generate_ui(self, args):
        """Generate a React UI component from a text prompt."""
        args = _normalize_tool_input(args)

        prompt = args.get('prompt')
        if not prompt:
            raise ValueError('generate_ui requires a `prompt` parameter')

        model = args.get('model') or 'v0-1.0-md'

        messages = [
            {'role': 'user', 'content': prompt},
        ]

        response = self._call_v0_api(messages, model)
        code, message_id = _extract_code(response)

        if not code:
            return {
                'success': False,
                'error': 'No code generated',
            }

        return {
            'success': True,
            'code': code,
            'message_id': message_id,
        }

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['prompt', 'message_id'],
            'properties': {
                'prompt': {
                    'type': 'string',
                    'description': 'Follow-up instructions describing how to change the component.',
                },
                'message_id': {
                    'type': 'string',
                    'description': 'The message_id returned from a previous generate_ui or refine_ui call.',
                },
                'prior_messages': {
                    'type': 'array',
                    'description': 'Prior conversation messages (user/assistant pairs) for stateless API fallback. Include the original prompt and response so the server has full context.',
                    'items': {
                        'type': 'object',
                        'properties': {
                            'role': {'type': 'string'},
                            'content': {'type': 'string'},
                        },
                    },
                },
                'model': {
                    'type': 'string',
                    'description': 'The v0 model to use (default: "v0-1.0-md").',
                    'default': 'v0-1.0-md',
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'success': {'type': 'boolean'},
                'code': {'type': 'string', 'description': 'Refined React component code.'},
                'message_id': {'type': 'string', 'description': 'Updated message ID for further refinements.'},
                'error': {'type': 'string', 'description': 'Error message on failure.'},
            },
        },
        description='Refine a previously generated UI component by providing follow-up instructions. Requires the message_id from a prior generate_ui call.',
    )
    def refine_ui(self, args):
        """Refine a previously generated UI component."""
        args = _normalize_tool_input(args)

        prompt = args.get('prompt')
        if not prompt:
            raise ValueError('refine_ui requires a `prompt` parameter')

        message_id = args.get('message_id')
        if not message_id:
            raise ValueError('refine_ui requires a `message_id` from a prior generation')

        model = args.get('model') or 'v0-1.0-md'

        # Build the messages array with prior history as a stateless fallback.
        # The v0 /v1/chat endpoint may be stateful (server-side history keyed by
        # parent_message_id) or stateless (standard OpenAI-compatible, requiring
        # the full conversation in messages).  We include both: the prior context
        # in `messages` and `parent_message_id` as an extra parameter so the
        # request works correctly regardless of the server's behaviour.
        prior_messages: List[Dict[str, str]] = args.get('prior_messages') or []
        messages = [*prior_messages, {'role': 'user', 'content': prompt}]

        response = self._call_v0_api(messages, model, parent_message_id=message_id)
        code, new_message_id = _extract_code(response)

        if not code:
            return {
                'success': False,
                'error': 'No code generated',
            }

        return {
            'success': True,
            'code': code,
            'message_id': new_message_id or message_id,
        }

    def _call_v0_api(self, messages: List[Dict[str, str]], model: str, **extra: Any) -> Dict[str, Any]:
        """Send a chat-style request to the v0 API and return the parsed response."""
        payload = {
            'model': model,
            'messages': messages,
            'stream': False,
            **extra,
        }

        headers = {
            'Authorization': f'Bearer {self.IGlobal.apikey}',
            'Content-Type': 'application/json',
        }

        try:
            with httpx.Client(timeout=V0_REQUEST_TIMEOUT) as client:
                resp = client.post(
                    V0_GENERATE_ENDPOINT,
                    headers=headers,
                    json=payload,
                )
                resp.raise_for_status()
                try:
                    return resp.json()
                except (json.JSONDecodeError, ValueError) as exc:
                    warning(f'v0 API returned non-JSON response: {exc}')
                    raise ValueError('v0 API returned non-JSON response') from exc
        except httpx.HTTPStatusError as e:
            warning(f'v0 API error: status={e.response.status_code}')
            raise
        except Exception as e:
            warning(f'v0 API request failed: {e}')
            raise


def _extract_code(response: Dict[str, Any]) -> tuple[str, str]:
    """Extract generated code and message ID from the v0 API response."""
    message_id = ''
    code = ''

    choices = response.get('choices') or []
    if choices:
        message = choices[0].get('message') or {}
        code = message.get('content') or ''
        message_id = response.get('id') or ''

    return code, message_id


def _normalize_tool_input(input_obj: Any) -> Dict[str, Any]:
    """Normalize whatever the engine/framework passes as tool input into a plain dict."""
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
        except Exception:
            pass

    if not isinstance(input_obj, dict):
        warning(f'v0: unexpected input type {type(input_obj).__name__}: {input_obj!r}')
        return {}

    if 'input' in input_obj and isinstance(input_obj['input'], dict):
        inner = input_obj['input']
        extras = {k: v for k, v in input_obj.items() if k != 'input'}
        input_obj = {**inner, **extras}

    input_obj.pop('security_context', None)

    return input_obj
