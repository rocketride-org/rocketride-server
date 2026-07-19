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
Shared JSON-Schema normalization for MCP tool descriptors.

Reasoning-model agents (e.g. ``qwen`` on Groq) silently drop a tool from their
usable catalog when its input schema has no ``properties`` — a zero-argument
tool reaches the model as a degenerate ``{'type': 'object'}``. More forgiving
models (e.g. ``llama-3.3-70b``) tolerate it. The MCP client cannot know which
model consumes the tool, so it always presents a well-formed, non-empty schema.

``normalize_tool_input_schema`` synthesizes a single *optional* no-op field for
empty-schema tools. The cached tool definition records when that field was
synthesized, so it is stripped from the arguments before the real ``tools/call``
(see ``IInstance._tool_invoke_dynamic``) without removing a real MCP argument
that happens to share its name. Schemas that already declare real ``properties``
pass through unchanged.
"""

from __future__ import annotations

from typing import Any, Dict, Optional

# Reserved argument name synthesized for zero-argument tools. The ``rr_`` prefix
# makes a collision with a real MCP argument vanishingly unlikely, and it is only
# ever added when the tool declares no properties of its own. It deliberately has
# no leading underscore: pydantic ``create_model`` (used by the LangChain/CrewAI/
# DeepAgent tool builders) rejects field names that start with ``_``.
NOOP_ARG_NAME = 'rr_no_args'


def input_schema_needs_noop_placeholder(schema: Any) -> bool:
    """Return whether normalization will synthesize the no-op placeholder."""
    return not isinstance(schema, dict) or not isinstance(schema.get('properties'), dict) or not schema['properties']


def normalize_tool_input_schema(schema: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Return a model-safe JSON Schema for a tool's input.

    If ``schema`` already declares a non-empty ``properties`` map it is returned
    unchanged. Otherwise (missing schema, bare ``{'type': 'object'}``, or explicit
    ``{'type': 'object', 'properties': {}}``) a single optional ``rr_no_args``
    string field is synthesized so strict reasoning models keep the tool in their
    catalog. Any other keys already present on the schema are preserved.
    """
    if not isinstance(schema, dict):
        schema = {'type': 'object'}

    if not input_schema_needs_noop_placeholder(schema):
        # Real arguments — leave the tool's declared schema untouched.
        return schema

    return {
        **schema,
        'type': 'object',
        'properties': {
            NOOP_ARG_NAME: {
                'type': 'string',
                'description': 'This tool takes no arguments. Leave empty or omit.',
            }
        },
        'required': [],
    }


def strip_synthesized_args(arguments: Any) -> Any:
    """
    Remove the synthesized ``rr_no_args`` placeholder from tool arguments.

    Called on the invoke path before a ``tools/call`` so a model that fills in
    the presentation-only no-op field never leaks it to the MCP server. Non-dict
    inputs and dicts without the placeholder are returned unchanged.
    """
    if not isinstance(arguments, dict) or NOOP_ARG_NAME not in arguments:
        return arguments
    return {k: v for k, v in arguments.items() if k != NOOP_ARG_NAME}
