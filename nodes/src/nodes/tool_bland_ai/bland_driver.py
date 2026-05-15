# =============================================================================
# MIT License
# Copyright (c) 2024 RocketRide Inc.
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
Bland AI tool-provider driver.

Exposes three tools for agent invocation:
  - ``make_call``    — initiate an outbound AI phone call
  - ``get_call``     — retrieve call details, transcript, and recording
  - ``analyze_call`` — run post-call AI analysis

API docs: https://docs.bland.ai
"""

from __future__ import annotations

from typing import Any, Dict, List

from ai.common.tools import ToolsBase

from . import bland_client

# ---------------------------------------------------------------------------
# Tool schemas
# ---------------------------------------------------------------------------

MAKE_CALL_SCHEMA: Dict[str, Any] = {
    'type': 'object',
    'required': ['phone_number', 'task'],
    'properties': {
        'phone_number': {
            'type': 'string',
            'description': 'Phone number in E.164 format (e.g. +14155551234)',
        },
        'task': {
            'type': 'string',
            'description': 'Instructions for the AI voice agent — what to say, ask, and accomplish on the call',
        },
        'first_sentence': {
            'type': 'string',
            'description': 'Optional opening sentence for the agent',
        },
        'voice': {
            'type': 'string',
            'description': 'Voice ID (June, Josh, Nat, Paige, Derek, Florian)',
        },
        'webhook': {
            'type': 'string',
            'description': 'HTTPS URL to receive call results when the call ends',
        },
        'max_duration': {
            'type': 'integer',
            'minimum': 1,
            'description': 'Max call length in minutes (positive integer, default 5)',
        },
    },
}

GET_CALL_SCHEMA: Dict[str, Any] = {
    'type': 'object',
    'required': ['call_id'],
    'properties': {
        'call_id': {
            'type': 'string',
            'description': 'The call ID returned by make_call',
        },
        'wait_for_completion': {
            'type': 'boolean',
            'description': (
                'If true, poll until the call finishes before returning (recommended for pipelines). Waits up to 5 minutes. Default: false.'
            ),
        },
    },
}

ANALYZE_CALL_SCHEMA: Dict[str, Any] = {
    'type': 'object',
    'required': ['call_id'],
    'properties': {
        'call_id': {
            'type': 'string',
            'description': 'The call ID to analyze',
        },
        'goal': {
            'type': 'string',
            'description': 'Overall purpose of the call (provides context for analysis)',
        },
        'questions': {
            'type': 'array',
            'description': 'Array of [question, expected_type] pairs to analyze',
            'items': {
                'type': 'array',
                'items': {'type': 'string'},
            },
        },
    },
}


class BlandDriver(ToolsBase):
    """Tool driver that exposes Bland AI voice call capabilities to agents."""

    def __init__(  # noqa: D107
        self,
        *,
        server_name: str,
        api_key: str,
        default_voice: str = 'June',
        max_duration: int = 5,
        record: bool = True,
        language: str = 'en',
    ) -> None:
        self._server_name = (server_name or '').strip() or 'bland'
        self._api_key = api_key
        self._default_voice = default_voice
        self._max_duration = max_duration
        self._record = record
        self._language = language

        self._tools = {
            'make_call': {
                'description': (
                    'Initiate an AI-powered outbound phone call via Bland AI. Required: phone_number (E.164 format) and task (instructions for the AI agent). Optional: first_sentence, voice, webhook (HTTPS), max_duration. Returns call_id to track the call.'
                ),
                'schema': MAKE_CALL_SCHEMA,
            },
            'get_call': {
                'description': (
                    'Get details for a Bland AI call including status, transcript, recording URL, duration, and summary. Required: call_id. Set wait_for_completion=true to block until the call finishes (use this in pipelines to avoid polling).'
                ),
                'schema': GET_CALL_SCHEMA,
            },
            'analyze_call': {
                'description': (
                    'Run AI analysis on a completed Bland AI call. Provide a goal and questions to extract structured insights from the transcript. Required: call_id. Optional: goal, questions.'
                ),
                'schema': ANALYZE_CALL_SCHEMA,
            },
        }

    # ------------------------------------------------------------------
    # ToolsBase hooks
    # ------------------------------------------------------------------

    def _tool_query(self) -> List[Dict[str, Any]]:
        return [
            {
                'name': f'{self._server_name}.{tool_name}',
                'description': info['description'],
                'inputSchema': info['schema'],
            }
            for tool_name, info in self._tools.items()
        ]

    def _tool_validate(self, *, tool_name: str, input_obj: Any) -> None:  # noqa: ANN401
        # Strip namespace prefix
        bare_name = tool_name.split('.', 1)[-1] if '.' in tool_name else tool_name
        if bare_name not in self._tools:
            raise ValueError(
                f'Unknown tool {tool_name!r}. Available: {", ".join(f"{self._server_name}.{t}" for t in self._tools)}'
            )

        if not isinstance(input_obj, dict):
            raise TypeError('Tool input must be a JSON object')

        if bare_name == 'make_call':
            phone_number = str(input_obj.get('phone_number') or '').strip()
            task = str(input_obj.get('task') or '').strip()
            if not phone_number:
                raise ValueError('phone_number is required')
            if not task:
                raise ValueError('task is required (instructions for the AI voice agent)')

            if 'max_duration' in input_obj:
                raw_duration = input_obj.get('max_duration')
                if isinstance(raw_duration, bool):
                    raise ValueError('max_duration must be a positive integer')
                try:
                    duration = int(raw_duration)
                except (TypeError, ValueError):
                    raise ValueError('max_duration must be a positive integer') from None
                if duration <= 0:
                    raise ValueError('max_duration must be a positive integer')

        elif bare_name in ('get_call', 'analyze_call'):
            call_id = str(input_obj.get('call_id') or '').strip()
            if not call_id:
                raise ValueError('call_id is required')

    def _tool_invoke(self, *, tool_name: str, input_obj: Any) -> Any:  # noqa: ANN401
        if not isinstance(input_obj, dict):
            raise TypeError('Tool input must be a JSON object')

        self._tool_validate(tool_name=tool_name, input_obj=input_obj)

        bare_name = tool_name.split('.', 1)[-1] if '.' in tool_name else tool_name

        if bare_name == 'make_call':
            phone_number = str(input_obj.get('phone_number') or '').strip()
            task = str(input_obj.get('task') or '').strip()
            max_duration = self._max_duration
            if 'max_duration' in input_obj:
                max_duration = int(str(input_obj.get('max_duration')).strip())
            return bland_client.make_call(
                self._api_key,
                phone_number=phone_number,
                task=task,
                voice=input_obj.get('voice', self._default_voice),
                first_sentence=input_obj.get('first_sentence', ''),
                max_duration=max_duration,
                record=self._record,
                language=self._language,
                webhook=input_obj.get('webhook', ''),
            )

        if bare_name == 'get_call':
            call_id = str(input_obj.get('call_id') or '').strip()
            raw_wait = input_obj.get('wait_for_completion')
            if isinstance(raw_wait, str):
                wait = raw_wait.strip().lower() in {'true', '1', 'yes'}
            else:
                wait = bool(raw_wait)
            if wait:
                return bland_client.get_call_when_complete(self._api_key, call_id)
            return bland_client.get_call(self._api_key, call_id)

        if bare_name == 'analyze_call':
            call_id = str(input_obj.get('call_id') or '').strip()
            return bland_client.analyze_call(
                self._api_key,
                call_id,
                goal=input_obj.get('goal', 'Analyze the phone call'),
                questions=input_obj.get('questions'),
            )

        raise ValueError(f'Unknown tool: {tool_name}')
