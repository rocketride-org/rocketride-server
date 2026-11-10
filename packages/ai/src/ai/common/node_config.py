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
Server-side resolution of a node's stored config.

The server reads a component's effective config in a few places before a node
starts (validation in the editor, the hosted-engine gate, the DB target check).
Each of them must see exactly what ``IGlobalBase.config`` serves the node at
start, so they all go through ``rocketlib.resolveConfig`` on the engine-resolved
schema, from here.
"""

from typing import Any, Dict, Optional

from rocketlib import ConfigError, ConfigView, IJson, getServiceSchema, resolveConfig


def node_schema(provider: str) -> Optional[Dict[str, Any]]:
    """Return the engine-resolved schema of ``provider`` as native dicts, or None when unknown.

    Args:
        provider: Component provider, e.g. 'tool_mcp_client'.

    Returns:
        The schema ``resolveConfig`` consumes (``properties`` with a ``path`` on
        every leaf, ``params``, ``capabilities``), or None when the engine knows
        no service of that name.
    """
    schema = getServiceSchema(provider)
    return None if schema is None else IJson.toDict(schema)


def resolve_node_config(provider: str, config: Dict[str, Any]) -> ConfigView:
    """Resolve a component's stored config exactly as the node does at start.

    Args:
        provider: Component provider, e.g. 'tool_mcp_client'.
        config: The component's config block as the pipeline stores it.

    Returns:
        ConfigView: Defaults + stored values, validated and flattened to the
        active branch - what ``IGlobalBase.config`` serves the node.

    Raises:
        ConfigError: The service is unknown, or the config does not fit its schema.
    """
    schema = node_schema(provider)
    if schema is None:
        raise ConfigError(f'The service {provider} was not found')
    return resolveConfig(schema, IJson.toDict(config))
