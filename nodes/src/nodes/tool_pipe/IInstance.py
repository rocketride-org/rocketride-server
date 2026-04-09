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
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE OF ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""
tool_pipe node instance.

Exposes a configurable tool to agents. When invoked, routes the input to all
connected output lanes. The write call is synchronous — by the time it returns,
all the downstream response nodes have already populated currentObject.response.
The new response entries are snapshotted and then removed so they don't leak
into the parent pipeline.
"""

from __future__ import annotations

import json

from rocketlib import IInstanceBase, getObject, tool_function, debug
from rocketlib import IJson

from .IGlobal import IGlobal

# Result type descriptions keyed by return_type config value.
_RETURN_TYPE_DESCRIPTIONS = {
    'text': 'Plain text result from the pipeline.',
    'answers': 'LLM-generated answer string from the pipeline.',
    'documents': 'JSON-serialised array of document objects from the pipeline.',
    'table': 'JSON-serialised table data from the pipeline.',
    'image': 'Base64-encoded image data from the pipeline.',
}


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['data'],
            'properties': {
                'data': {
                    'type': 'string',
                    'description': 'The input to send to the pipeline.',
                },
            },
        },
        description='Accepts a text input and returns the pipeline result.',
        output_schema=lambda self: {
            'type': 'object',
            'properties': {
                'result': {
                    'type': 'string',
                    'description': _RETURN_TYPE_DESCRIPTIONS.get(
                        self.IGlobal.return_type,
                        'Result from the pipeline.',
                    ),
                },
            },
        },
    )
    def run_pipe(self, input_obj) -> dict:
        """Run the connected pipeline with the given input and return its result."""
        args = _normalize_tool_input(input_obj)
        data = args.get('data')
        if not data:
            raise ValueError('tool_pipe: tool requires a non-empty `data` parameter')

        debug(f'tool_pipe: run_pipe invoked data_len={len(data)}')

        entry = getObject()
        opened = False
        try:
            self.instance.open(entry)
            opened = True
            self._send_to_connected_lane(data)
        except Exception:
            return {'result': ''}
        finally:
            if opened:
                self.instance.close()

        response = _to_python_dict(entry.response)

        if not response:
            debug('tool_pipe: sub-pipeline returned no data — ensure a response node is connected at the end of the sub-pipeline')

        result = _extract_return_value(response, self.IGlobal.return_type)

        debug(f'tool_pipe: returning result return_type={self.IGlobal.return_type!r} result_len={len(result)}')
        return {'result': result}

    # ------------------------------------------------------------------
    # Lane routing
    # ------------------------------------------------------------------

    def _send_to_connected_lane(self, data: str) -> None:
        """Write data to all connected output lanes."""
        if self.instance.hasListener('questions'):
            from ai.common.schema import Question

            q = Question()
            q.addQuestion(data)
            self.instance.writeQuestions(q)

        if self.instance.hasListener('documents'):
            from ai.common.schema import Doc

            self.instance.writeDocuments([Doc(page_content=data)])

        if self.instance.hasListener('table'):
            self.instance.writeTable(data)

        if self.instance.hasListener('text'):
            self.instance.writeText(data)

        if self.instance.hasListener('answers'):
            from ai.common.schema import Answer

            answer = Answer()
            answer.setAnswer(data)
            self.instance.writeAnswers(answer)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _to_python_dict(response) -> dict:
    """Convert a C++ IJson/IDict response object to a plain Python dict."""
    if response is None:
        return {}
    try:
        return IJson.toDict(response)
    except Exception:
        return {}


def _extract_return_value(result: dict, return_type: str) -> str:
    """Extract the configured return lane value from the sub-pipeline result."""
    if not isinstance(result, dict):
        return str(result) if result is not None else ''

    value = result.get(return_type)

    # answers is a list — return the first item
    if return_type == 'answers' and isinstance(value, list):
        return str(value[0]) if value else ''

    # documents / table — serialise to JSON string for the agent
    if isinstance(value, (list, dict)):
        return json.dumps(value, ensure_ascii=False)

    return str(value) if value is not None else ''


def _normalize_tool_input(input_obj):
    """Normalise tool input into a plain dict."""
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
        return {}
    if 'input' in input_obj and isinstance(input_obj['input'], dict):
        inner = input_obj['input']
        extras = {k: v for k, v in input_obj.items() if k != 'input'}
        input_obj = {**inner, **extras}
    input_obj.pop('security_context', None)
    return input_obj
