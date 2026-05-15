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
Chart (Chart.js) tool node instance.

Exposes a ``generate_chart`` tool that uses the pipeline LLM to produce
valid Chart.js v4 configuration JSON from raw data.
"""

from __future__ import annotations

import json

from rocketlib import IInstanceBase, tool_function, IInvokeLLM
from ai.common.schema import Question

from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['data'],
            'properties': {
                'data': {
                    'oneOf': [{'type': 'array'}, {'type': 'object'}],
                    'description': 'The raw data to chart. Can be an array of objects, key-value pairs, or any structured data.',
                },
                'chart_type': {
                    'type': 'string',
                    'enum': ['bar', 'line', 'pie', 'doughnut', 'radar', 'polarArea', 'scatter', 'bubble'],
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
        },
        output_schema={
            'type': 'string',
            'description': 'A ready-to-render ```chartjs fenced block. Use this string verbatim in the answer — do not add extra fences around it.',
        },
        description=(
            'Generate a Chart.js chart configuration from data. '
            'Required: "data" (the raw data to chart). '
            'Optional: "chart_type" (bar, line, pie, doughnut, radar, polarArea, scatter, bubble), '
            '"title" (chart title), "description" (natural language description of desired chart). '
            'Returns a ready-to-render string. Place it verbatim in the answer — do NOT wrap it in additional fences.'
        ),
    )
    def generate_chart(self, args):
        """
        Generate a Chart.js v4 chart configuration from data via the pipeline LLM.
        """
        if not isinstance(args, dict):
            raise ValueError('Tool input must be a JSON object')

        data = args.get('data')
        if not isinstance(data, (list, dict)):
            raise ValueError('"data" is required and must be a list or dict')
        if len(data) == 0:
            raise ValueError('"data" must not be empty')

        valid_types = ['bar', 'line', 'pie', 'doughnut', 'radar', 'polarArea', 'scatter', 'bubble']
        chart_type = args.get('chart_type')
        if chart_type and chart_type not in valid_types:
            raise ValueError(f'"chart_type" must be one of {valid_types}; got {chart_type!r}')

        title = args.get('title')
        if title is not None and not isinstance(title, str):
            raise ValueError('"title" must be a string')
        description = args.get('description')
        if description is not None and not isinstance(description, str):
            raise ValueError('"description" must be a string')

        # Truncate large list datasets to keep the LLM prompt manageable
        if isinstance(data, list) and len(data) > 200:
            data = data[:200]

        MAX_SERIALIZED_BYTES = 20_000
        data_str = json.dumps(data, indent=2, default=str)
        if len(data_str) > MAX_SERIALIZED_BYTES:
            data_str = data_str[: MAX_SERIALIZED_BYTES - 40] + '\n...[truncated]...\n' + data_str[-20:]

        # Build the LLM question
        q = Question(role='You are a Chart.js v4 configuration generator.')

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
            'Generate a Chart.js v4 configuration for the provided data'
            + (f' as a {chart_type} chart' if chart_type else '')
            + '.',
        )
        q.addQuestion(
            description or 'Generate the Chart.js configuration JSON for the data above.',
        )

        # Call the pipeline LLM directly
        llm_nodes = self.instance.getControllerNodeIds('llm')
        if not llm_nodes:
            raise RuntimeError('Chart generator requires an LLM node connected to the pipeline.')

        result = self.instance.invoke(IInvokeLLM.Ask(question=q), component_id=llm_nodes[0])

        if hasattr(result, 'getText') and callable(result.getText):
            response_text = (result.getText() or '').strip()
        else:
            response_text = str(result).strip()

        # Strip any fenced code markers the LLM may have added
        if response_text.startswith('```'):
            first_nl = response_text.find('\n')
            if first_nl != -1:
                response_text = response_text[first_nl + 1 :]
        if response_text.endswith('```'):
            response_text = response_text[:-3]
        response_text = response_text.strip()

        if not response_text:
            raise RuntimeError('LLM returned empty Chart.js configuration')

        try:
            parsed = json.loads(response_text)
        except json.JSONDecodeError as e:
            raise RuntimeError(f'LLM returned invalid JSON for Chart.js configuration: {e}') from e

        normalized = json.dumps(parsed, ensure_ascii=False)

        # Wrap in a ```chartjs fence so the UI renders this as a chart.
        return f'```chartjs\n{normalized}\n```'
