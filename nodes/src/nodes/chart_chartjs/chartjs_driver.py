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
Chart.js tool-provider driver.

Implements ``tool.query``, ``tool.validate``, and ``tool.invoke`` by exposing a
single ``generate_chart`` tool that uses the pipeline LLM to produce valid
Chart.js v4 configuration JSON from raw data.
"""

from __future__ import annotations

import json
from typing import Any, Callable, Dict, List, Optional

from ai.common.schema import Question
from ai.common.tools import ToolsBase

MAX_DATA_ROWS = 200

VALID_CHART_TYPES = [
    'bar',
    'line',
    'pie',
    'doughnut',
    'radar',
    'polarArea',
    'scatter',
    'bubble',
]

INPUT_SCHEMA: Dict[str, Any] = {
    'type': 'object',
    'required': ['data'],
    'properties': {
        'data': {
            # Accept both array and object forms — LLMs may produce either.
            # chart_type is optional; the renderer defaults to Bar when omitted or unknown.
            'oneOf': [{'type': 'array'}, {'type': 'object'}],
            'description': ('The raw data to chart. Can be an array of objects, key-value pairs, or any structured data.'),
        },
        'chart_type': {
            'type': 'string',
            'enum': VALID_CHART_TYPES,
            'description': 'Optional hint for chart type. If omitted, the best type is chosen automatically.',
        },
        'title': {
            'type': 'string',
            'description': 'Optional chart title.',
        },
        'description': {
            'type': 'string',
            'description': 'Natural language description of what chart to create.',
        },
    },
}

ROLE = 'You are a Chart.js v4 configuration generator.'


def _truncate_data(data: Any) -> Any:
    """Truncate large datasets to keep the LLM prompt manageable."""
    if isinstance(data, list) and len(data) > MAX_DATA_ROWS:
        return data[:MAX_DATA_ROWS]
    return data


class ChartjsDriver(ToolsBase):
    def __init__(self, *, server_name: str):
        self._server_name = (server_name or '').strip() or 'chartjs'
        self._tool_name = 'generate_chart'
        self._namespaced = f'{self._server_name}.{self._tool_name}'
        self._llm_invoke: Optional[Callable[[Question], str]] = None

    def set_llm_invoker(self, fn: Callable[[Question], str]) -> None:
        """Set the LLM invocation callable (bound by IInstance)."""
        self._llm_invoke = fn

    # ------------------------------------------------------------------
    # ToolsBase hooks
    # ------------------------------------------------------------------

    def _tool_query(self) -> List[Dict[str, Any]]:
        return [
            {
                'name': self._namespaced,
                'description': (
                    'Generate a Chart.js chart configuration from data. '
                    'Required: "data" (the raw data to chart). '
                    'Optional: "chart_type" (bar, line, pie, doughnut, radar, polarArea, scatter, bubble), '
                    '"title" (chart title), "description" (natural language description of desired chart). '
                    'Returns a ready-to-render string. Place it verbatim in the answer — do NOT wrap it in additional fences.'
                ),
                'inputSchema': INPUT_SCHEMA,
                'outputSchema': {
                    'type': 'string',
                    'description': 'A ready-to-render ```chartjs fenced block. Use this string verbatim in the answer — do not add extra fences around it.',
                },
            }
        ]

    def _tool_validate(self, *, tool_name: str, input_obj: Any) -> None:  # noqa: ANN401
        # _tool_validate is called directly from _tool_invoke (below), not only via
        # handle_invoke, so this guard is reachable and necessary.
        if tool_name != self._tool_name and tool_name != self._namespaced:
            raise ValueError(f'Unknown tool {tool_name!r} (expected {self._namespaced!r})')

        if not isinstance(input_obj, dict):
            raise ValueError('Tool input must be a JSON object')

        data = input_obj.get('data')
        if data is None:
            raise ValueError('"data" is required')
        if isinstance(data, (list, dict)) and len(data) == 0:
            raise ValueError('"data" must not be empty')

        chart_type = input_obj.get('chart_type')
        if chart_type and chart_type not in VALID_CHART_TYPES:
            raise ValueError(f'"chart_type" must be one of {VALID_CHART_TYPES}; got {chart_type!r}')

    def _tool_invoke(self, *, tool_name: str, input_obj: Any) -> Any:  # noqa: ANN401
        if self._llm_invoke is None:
            raise RuntimeError('Chart generator requires an LLM node connected to the pipeline. No LLM invoker was bound.')

        self._tool_validate(tool_name=tool_name, input_obj=input_obj)

        data = _truncate_data(input_obj['data'])
        data_str = json.dumps(data, indent=2, default=str) if not isinstance(data, str) else data

        chart_type = input_obj.get('chart_type')
        title = input_obj.get('title')
        description = input_obj.get('description')

        # Build the Question using its structured API
        q = Question(role=ROLE)

        q.addInstruction(
            'Output format',
            'Produce ONLY a valid Chart.js v4 JSON configuration object. No markdown fences, no explanation — just the raw JSON object.',
        )

        q.addInstruction(
            'Required fields',
            'The JSON must include "type", "data" (with "labels" and "datasets"), and "options". Set responsive to true and maintainAspectRatio to true in options.',
        )

        q.addInstruction(
            'Styling',
            'Use readable colors with good contrast. Include a legend if there are multiple datasets.',
        )

        q.addInstruction(
            'No callbacks',
            'Do NOT include any JavaScript function callbacks (e.g. tooltip.callbacks.label, '
            'legend.labels.generateLabels). The output must be pure static JSON — no functions, '
            'no code strings. If you need to show data values in labels or legends, embed them '
            'directly in the label strings (e.g. "Telegraph Voyage — $215.75").',
        )

        q.addContext(f'Data:\n{data_str}')

        if chart_type:
            q.addContext(f'Chart type: {chart_type}')
        if title:
            q.addContext(f'Title: {title}')
        if description:
            q.addContext(f'Description: {description}')

        q.addGoal(
            'Generate a Chart.js v4 configuration for the provided data' + (f' as a {chart_type} chart' if chart_type else '') + '.',
        )

        q.addQuestion(
            'Generate the Chart.js configuration JSON for the data above.' if not description else description,
        )

        response_text = self._llm_invoke(q)

        # Wrap in a ```chartjs fence so the UI renders this as a chart.
        # The descriptor tells the agent to use this string verbatim — do not re-wrap.
        return f'```chartjs\n{response_text}\n```'
