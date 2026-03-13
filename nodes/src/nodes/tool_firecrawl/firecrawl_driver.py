"""
Firecrawl tool-provider driver.

Implements `tool.query`, `tool.validate`, and `tool.invoke` for the Firecrawl
scrape and map operations.  Unlike the MCP driver which discovers tools
dynamically, this driver statically defines two tools since the Firecrawl API
surface is fixed.
"""

from __future__ import annotations

import json
from typing import Any, Dict, List

from rocketlib import warning

from ai.common.tools import ToolsBase

from .utils import firecrawl_wrapper

# ---------------------------------------------------------------------------
# Static tool definitions
# ---------------------------------------------------------------------------

SCRAPE_URL_TOOL = {
    'name': 'scrape_url',
    'description': 'Scrape a single web page and return its content.',
    'inputSchema': {
        'type': 'object',
        'properties': {
            'url': {
                'type': 'string',
                'description': 'The URL of the web page to scrape.',
            },
            'formats': {
                'type': 'array',
                'items': {'type': 'string'},
                'description': 'Output formats (default: ["markdown"]).',
                'default': ['markdown'],
            },
        },
        'required': ['url'],
    },
    'outputSchema': {
        'type': 'object',
        'properties': {
            'success': {'type': 'boolean'},
            'content': {'type': 'string'},
            'metadata': {'type': 'object'},
        },
    },
}

MAP_URL_TOOL = {
    'name': 'map_url',
    'description': "Map a website's structure and return all discovered URLs.",
    'inputSchema': {
        'type': 'object',
        'properties': {
            'url': {
                'type': 'string',
                'description': 'The root URL of the website to map.',
            },
        },
        'required': ['url'],
    },
    'outputSchema': {
        'type': 'object',
        'properties': {
            'success': {'type': 'boolean'},
            'links': {
                'type': 'array',
                'items': {'type': 'string'},
            },
        },
    },
}

_TOOLS_BY_BARE_NAME: Dict[str, Dict[str, Any]] = {
    'scrape_url': SCRAPE_URL_TOOL,
    'map_url': MAP_URL_TOOL,
}


class FirecrawlDriver(ToolsBase):
    """Tool provider for Firecrawl scrape_url and map_url."""

    def __init__(self, *, server_name: str, app: Any) -> None:
        self._server_name = (server_name or '').strip() or 'firecrawl'
        self._app = app

    def _bare_name(self, tool_name: str) -> str:
        """Strip server prefix, accepting both bare and namespaced tool names."""
        prefix = f'{self._server_name}.'
        return tool_name[len(prefix):] if tool_name.startswith(prefix) else tool_name

    # ------------------------------------------------------------------
    # ToolsBase hooks
    # ------------------------------------------------------------------

    def _tool_query(self) -> List[ToolsBase.ToolDescriptor]:
        # Return namespaced descriptors (<server>.<tool>) so multiple Firecrawl nodes
        # do not produce colliding tool names. _tool_validate and _tool_invoke use
        # _bare_name() to strip the prefix when looking up _TOOLS_BY_BARE_NAME.
        return [
            {**tool, 'name': f'{self._server_name}.{tool["name"]}'}
            for tool in _TOOLS_BY_BARE_NAME.values()
        ]

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

        if bare == 'scrape_url':
            return self._invoke_scrape(args)
        elif bare == 'map_url':
            return self._invoke_map(args)
        else:
            raise ValueError(f'Unknown tool {tool_name}')

    # ------------------------------------------------------------------
    # Tool implementations
    # ------------------------------------------------------------------

    def _invoke_scrape(self, args: Dict[str, Any]) -> Dict[str, Any]:
        url = args.get('url')
        if not url:
            raise ValueError('scrape_url requires a `url` parameter')

        # v2 SDK: app.scrape(url) returns a Document Pydantic model
        result = firecrawl_wrapper(lambda: self._app.scrape(url))

        content = getattr(result, 'markdown', None) \
            or getattr(result, 'html', None) \
            or ''
        if not isinstance(content, str):
            content = json.dumps(content)

        metadata = getattr(result, 'metadata', None)
        if metadata is not None and not isinstance(metadata, dict):
            try:
                metadata = metadata.model_dump(exclude_none=True) if hasattr(metadata, 'model_dump') else {}
            except Exception:
                metadata = {}
        metadata = metadata or {}

        return {
            'success': True,
            'content': content,
            'metadata': metadata,
        }

    def _invoke_map(self, args: Dict[str, Any]) -> Dict[str, Any]:
        url = args.get('url')
        if not url:
            raise ValueError('map_url requires a `url` parameter')

        # v2 SDK: app.map(url) returns a MapData with .links (list of LinkResult)
        result = firecrawl_wrapper(lambda: self._app.map(url))

        links: list = []
        if hasattr(result, 'links') and result.links:
            for link in result.links:
                if hasattr(link, 'url'):
                    links.append(link.url)
                elif isinstance(link, str):
                    links.append(link)

        return {
            'success': True,
            'links': links,
        }


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _normalize_tool_input(input_obj: Any) -> Dict[str, Any]:
    """
    Normalize whatever the engine/framework passes as tool input into a plain dict.

    Handles: None, dict, Pydantic model, JSON string, and nested ``input`` wrappers
    that some framework paths produce.
    """
    if input_obj is None:
        return {}

    # Pydantic model → dict
    if hasattr(input_obj, 'model_dump') and callable(getattr(input_obj, 'model_dump')):
        input_obj = input_obj.model_dump()
    elif hasattr(input_obj, 'dict') and callable(getattr(input_obj, 'dict')):
        input_obj = input_obj.dict()

    # JSON string → dict
    if isinstance(input_obj, str):
        try:
            import json as _json
            parsed = _json.loads(input_obj)
            if isinstance(parsed, dict):
                input_obj = parsed
        except Exception:
            pass

    if not isinstance(input_obj, dict):
        warning(f'firecrawl: unexpected input type {type(input_obj).__name__}: {input_obj!r}')
        return {}

    # Unwrap ``{"input": {...}}`` wrappers that some framework paths leave behind
    if 'input' in input_obj and isinstance(input_obj['input'], dict):
        inner = input_obj['input']
        extras = {k: v for k, v in input_obj.items() if k != 'input'}
        input_obj = {**inner, **extras}

    # Drop framework-injected keys that aren't tool args
    input_obj.pop('security_context', None)

    return input_obj
