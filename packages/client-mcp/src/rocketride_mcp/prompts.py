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

"""MCP Prompt templates for common RocketRide operations."""

from __future__ import annotations

from typing import Any, Dict, List, Optional

import mcp.types as types

# ---------------------------------------------------------------------------
# Prompt template definitions
# ---------------------------------------------------------------------------

PROMPT_TEMPLATES: List[Dict[str, Any]] = [
    {
        'name': 'analyze-document',
        'description': 'Analyze a document through a RocketRide pipeline',
        'arguments': [
            {'name': 'pipeline', 'description': 'Pipeline name to use for analysis', 'required': True},
            {'name': 'query', 'description': 'Analysis question or instruction', 'required': True},
        ],
    },
    {
        'name': 'chat-with-data',
        'description': 'Start a conversation about data processed by RocketRide',
        'arguments': [
            {'name': 'pipeline', 'description': 'Pipeline name', 'required': True},
            {'name': 'question', 'description': 'Your question about the data', 'required': True},
        ],
    },
    {
        'name': 'evaluate-pipeline',
        'description': 'Evaluate a pipeline output quality using test data',
        'arguments': [
            {'name': 'pipeline', 'description': 'Pipeline to evaluate', 'required': True},
            {'name': 'test_input', 'description': 'Test input data', 'required': True},
            {'name': 'expected_output', 'description': 'Expected output for comparison', 'required': False},
        ],
    },
]

# Pre-built message templates keyed by prompt name.
_MESSAGE_TEMPLATES: Dict[str, str] = {
    'analyze-document': ('Please analyze the document using the RocketRide pipeline "{pipeline}". Focus on the following: {query}'),
    'chat-with-data': ('I would like to discuss data processed by the RocketRide pipeline "{pipeline}". My question is: {question}'),
    'evaluate-pipeline': ('Evaluate the output quality of the RocketRide pipeline "{pipeline}" using the following test input:\n\n{test_input}{expected_output_section}'),
}


def list_prompts() -> list[types.Prompt]:
    """Return the list of available prompt templates as ``mcp.types.Prompt`` objects."""
    prompts: list[types.Prompt] = []
    for template in PROMPT_TEMPLATES:
        arguments: list[types.PromptArgument] = []
        for arg in template.get('arguments', []):
            arguments.append(
                types.PromptArgument(
                    name=arg['name'],
                    description=arg.get('description'),
                    required=arg.get('required', False),
                )
            )
        prompts.append(
            types.Prompt(
                name=template['name'],
                description=template.get('description'),
                arguments=arguments,
            )
        )
    return prompts


def get_prompt(name: str, arguments: Optional[Dict[str, str]] = None) -> types.GetPromptResult:
    """Generate a ``GetPromptResult`` from a template with the supplied arguments.

    Raises ``ValueError`` when *name* does not match any known template or
    when a required argument is missing.
    """
    template = _find_template(name)
    if template is None:
        raise ValueError(f'Unknown prompt: {name}')

    arguments = arguments or {}

    # Validate required arguments
    for arg_def in template.get('arguments', []):
        if arg_def.get('required') and arg_def['name'] not in arguments:
            raise ValueError(f'Missing required argument: {arg_def["name"]}')

    message_text = _render_message(name, arguments)

    return types.GetPromptResult(
        description=template.get('description'),
        messages=[
            types.PromptMessage(
                role='user',
                content=types.TextContent(type='text', text=message_text),
            )
        ],
    )


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _find_template(name: str) -> Optional[Dict[str, Any]]:
    """Look up a prompt template by name (case-sensitive)."""
    for template in PROMPT_TEMPLATES:
        if template['name'] == name:
            return template
    return None


def _render_message(name: str, arguments: Dict[str, str]) -> str:
    """Render the human-readable message for a prompt, filling in argument placeholders."""
    template_str = _MESSAGE_TEMPLATES.get(name)
    if template_str is None:
        # Fallback: list arguments as key-value pairs
        parts = [f'{k}: {v}' for k, v in arguments.items()]
        return f'Prompt "{name}" with arguments:\n' + '\n'.join(parts)

    # Special handling for optional sections
    if name == 'evaluate-pipeline':
        expected = arguments.get('expected_output')
        if expected:
            arguments = {**arguments, 'expected_output_section': f'\n\nExpected output:\n{expected}'}
        else:
            arguments = {**arguments, 'expected_output_section': ''}

    return template_str.format(**{k: v for k, v in arguments.items() if '{' + k + '}' in template_str or k + '_section}' in template_str})
