"""
v0 by Vercel tool-provider driver.

Implements ``tool.query``, ``tool.validate``, and ``tool.invoke`` for
generating React UI components via Vercel's v0 generative UI API.

v0 accepts natural-language prompts describing a desired UI and returns
production-ready React/Tailwind code.
"""

from __future__ import annotations

import json
from typing import Any, Dict, List

import httpx

from rocketlib import warning

from ai.common.tools import ToolsBase

# ---------------------------------------------------------------------------
# v0 API configuration
# ---------------------------------------------------------------------------

V0_API_BASE = 'https://api.v0.dev/v1'
V0_GENERATE_ENDPOINT = f'{V0_API_BASE}/chat'
V0_REQUEST_TIMEOUT = 120  # seconds — generation can take a while

# ---------------------------------------------------------------------------
# Static tool definitions
# ---------------------------------------------------------------------------

GENERATE_UI_TOOL: Dict[str, Any] = {
    'name': 'generate_ui',
    'description': ('Generate a React UI component from a natural-language description. Provide a detailed prompt describing the desired UI and receive production-ready React + Tailwind CSS code.'),
    'inputSchema': {
        'type': 'object',
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
        'required': ['prompt'],
    },
    'outputSchema': {
        'type': 'object',
        'properties': {
            'success': {'type': 'boolean'},
            'code': {'type': 'string', 'description': 'Generated React component code.'},
            'message_id': {'type': 'string', 'description': 'v0 message ID for follow-up refinements.'},
        },
    },
}

REFINE_UI_TOOL: Dict[str, Any] = {
    'name': 'refine_ui',
    'description': ('Refine a previously generated UI component by providing follow-up instructions. Requires the message_id from a prior generate_ui call.'),
    'inputSchema': {
        'type': 'object',
        'properties': {
            'prompt': {
                'type': 'string',
                'description': 'Follow-up instructions describing how to change the component.',
            },
            'message_id': {
                'type': 'string',
                'description': 'The message_id returned from a previous generate_ui or refine_ui call.',
            },
            'model': {
                'type': 'string',
                'description': 'The v0 model to use (default: "v0-1.0-md").',
                'default': 'v0-1.0-md',
            },
        },
        'required': ['prompt', 'message_id'],
    },
    'outputSchema': {
        'type': 'object',
        'properties': {
            'success': {'type': 'boolean'},
            'code': {'type': 'string', 'description': 'Refined React component code.'},
            'message_id': {'type': 'string', 'description': 'Updated message ID for further refinements.'},
        },
    },
}

_TOOLS_BY_BARE_NAME: Dict[str, Dict[str, Any]] = {
    'generate_ui': GENERATE_UI_TOOL,
    'refine_ui': REFINE_UI_TOOL,
}


class V0Driver(ToolsBase):
    """Tool provider for Vercel v0 UI generation."""

    def __init__(self, *, server_name: str, apikey: str) -> None:  # noqa: D107
        self._server_name = (server_name or '').strip() or 'v0'
        self._apikey = apikey

    def _bare_name(self, tool_name: str) -> str:
        """Strip server prefix, accepting both bare and namespaced tool names."""
        prefix = f'{self._server_name}.'
        return tool_name[len(prefix) :] if tool_name.startswith(prefix) else tool_name

    # ------------------------------------------------------------------
    # ToolsBase hooks
    # ------------------------------------------------------------------

    def _tool_query(self) -> List[ToolsBase.ToolDescriptor]:
        return [{**tool, 'name': f'{self._server_name}.{tool["name"]}'} for tool in _TOOLS_BY_BARE_NAME.values()]

    def _tool_validate(self, *, tool_name: str, input_obj: Any) -> None:  # noqa: ANN401
        tool = _TOOLS_BY_BARE_NAME.get(self._bare_name(tool_name))
        if tool is None:
            raise ValueError(f'Unknown tool {tool_name}')

        schema = tool.get('inputSchema') or {}
        required = schema.get('required', [])
        if not required:
            return
        if not isinstance(input_obj, dict):
            raise ValueError(f'Tool input must be an object; required fields={required}')
        missing = [k for k in required if k not in input_obj]
        if missing:
            raise ValueError(f'Tool input missing required fields: {missing}')

    def _tool_invoke(self, *, tool_name: str, input_obj: Any) -> Any:  # noqa: ANN401
        args = _normalize_tool_input(input_obj)
        bare = self._bare_name(tool_name)

        if bare == 'generate_ui':
            return self._invoke_generate(args)
        elif bare == 'refine_ui':
            return self._invoke_refine(args)
        else:
            raise ValueError(f'Unknown tool {tool_name}')

    # ------------------------------------------------------------------
    # Tool implementations
    # ------------------------------------------------------------------

    def _build_headers(self) -> Dict[str, str]:
        return {
            'Authorization': f'Bearer {self._apikey}',
            'Content-Type': 'application/json',
        }

    def _call_v0_api(self, messages: List[Dict[str, str]], model: str, **extra: Any) -> Dict[str, Any]:
        """Send a chat-style request to the v0 API and return the parsed response."""
        payload = {
            'model': model,
            'messages': messages,
            'stream': False,
            **extra,
        }

        try:
            with httpx.Client(timeout=V0_REQUEST_TIMEOUT) as client:
                resp = client.post(
                    V0_GENERATE_ENDPOINT,
                    headers=self._build_headers(),
                    json=payload,
                )
                resp.raise_for_status()
                return resp.json()
        except httpx.HTTPStatusError as e:
            warning(f'v0 API error: {e.response.status_code} - {e.response.text}')
            raise
        except Exception as e:
            warning(f'v0 API request failed: {e}')
            raise

    @staticmethod
    def _extract_code(response: Dict[str, Any]) -> tuple[str, str]:
        """Extract generated code and message ID from the v0 API response."""
        message_id = ''
        code = ''

        # v0 API returns a chat-completions-style response
        choices = response.get('choices') or []
        if choices:
            message = choices[0].get('message') or {}
            code = message.get('content') or ''
            message_id = response.get('id') or ''

        return code, message_id

    def _invoke_generate(self, args: Dict[str, Any]) -> Dict[str, Any]:
        prompt = args.get('prompt')
        if not prompt:
            raise ValueError('generate_ui requires a `prompt` parameter')

        model = args.get('model') or 'v0-1.0-md'

        messages = [
            {'role': 'user', 'content': prompt},
        ]

        response = self._call_v0_api(messages, model)
        code, message_id = self._extract_code(response)

        return {
            'success': True,
            'code': code,
            'message_id': message_id,
        }

    def _invoke_refine(self, args: Dict[str, Any]) -> Dict[str, Any]:
        prompt = args.get('prompt')
        if not prompt:
            raise ValueError('refine_ui requires a `prompt` parameter')

        message_id = args.get('message_id')
        if not message_id:
            raise ValueError('refine_ui requires a `message_id` from a prior generation')

        model = args.get('model') or 'v0-1.0-md'

        messages = [
            {'role': 'user', 'content': prompt},
        ]

        response = self._call_v0_api(messages, model, parent_message_id=message_id)
        code, new_message_id = self._extract_code(response)

        return {
            'success': True,
            'code': code,
            'message_id': new_message_id or message_id,
        }


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _normalize_tool_input(input_obj: Any) -> Dict[str, Any]:
    """Normalize whatever the engine/framework passes as tool input into a plain dict.

    Handles: None, dict, Pydantic model, JSON string, and nested ``input`` wrappers
    that some framework paths produce.
    """
    if input_obj is None:
        return {}

    # Pydantic model -> dict
    if hasattr(input_obj, 'model_dump') and callable(getattr(input_obj, 'model_dump')):
        input_obj = input_obj.model_dump()
    elif hasattr(input_obj, 'dict') and callable(getattr(input_obj, 'dict')):
        input_obj = input_obj.dict()

    # JSON string -> dict
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

    # Unwrap ``{"input": {...}}`` wrappers that some framework paths leave behind
    if 'input' in input_obj and isinstance(input_obj['input'], dict):
        inner = input_obj['input']
        extras = {k: v for k, v in input_obj.items() if k != 'input'}
        input_obj = {**inner, **extras}

    # Drop framework-injected keys that aren't tool args
    input_obj.pop('security_context', None)

    return input_obj
