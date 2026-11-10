# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Synthetic tool catalogs for the Wave prompt tests and the catalog size bench."""

from typing import Any, Dict, List


def synthetic_catalog(
    n: int, *, desc_chars: int = 0, extra_props: int = 0, prefix: str = 'node.catalog'
) -> List[Dict[str, Any]]:
    """Return *n* tool descriptors shaped like a small MCP server's.

    Each tool reads one record by id and takes two arguments. *desc_chars* pads the
    description to that length; *extra_props* adds that many optional enum arguments.
    """
    tools = []
    for i in range(n):
        desc = f'Read item {i:03d} by id.'
        if desc_chars:
            filler = ' It returns the stored record with every field the caller may read, and reports when the id is unknown.'
            desc = (desc + filler * 6)[:desc_chars]
        props: Dict[str, Any] = {
            'id': {'type': 'string', 'description': 'Record id.'},
            'fields': {'type': 'array', 'items': {'type': 'string'}},
        }
        for p in range(extra_props):
            props[f'option_{p}'] = {
                'type': 'string',
                'description': f'Optional setting {p} that changes how the record is read.',
                'enum': ['a', 'b', 'c'],
            }
        tools.append(
            {
                'name': f'{prefix}.lookup_{i:03d}',
                'description': desc,
                'inputSchema': {
                    'type': 'object',
                    'properties': props,
                    'required': ['id'],
                    'additionalProperties': False,
                },
            }
        )
    return tools
