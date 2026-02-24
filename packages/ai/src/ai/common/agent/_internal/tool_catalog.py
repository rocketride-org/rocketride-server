from __future__ import annotations

from typing import Any, Dict, List

from .host import AgentHostServices
from .utils import safe_str


def query_tool_catalog(*, host: AgentHostServices) -> Any:
    """Best-effort host tool discovery via `host.tools.query()`."""
    try:
        return host.tools.query()
    except Exception as e:
        return {'error': str(e), 'type': type(e).__name__}


def _tool_name_from_obj(obj: Any) -> str:
    if isinstance(obj, str):
        return obj.strip()
    if isinstance(obj, dict):
        return safe_str(obj.get('name') or obj.get('tool_name') or obj.get('toolName')).strip()
    if hasattr(obj, 'name'):
        return safe_str(getattr(obj, 'name')).strip()
    return ''


def normalize_tool_catalog(tool_catalog: Any) -> List[Dict[str, Any]]:
    """
    Normalize a host tool catalog response into a list of tool descriptors.

    The returned descriptors are best-effort and intentionally loose. The goal is
    to preserve richer fields when present (e.g. description and schemas) while
    still supporting name-only catalogs.
    """
    tools_obj: Any = None
    if isinstance(tool_catalog, list):
        tools_obj = tool_catalog
    elif hasattr(tool_catalog, 'tools'):
        tools_obj = getattr(tool_catalog, 'tools')
    elif isinstance(tool_catalog, dict):
        tools_obj = tool_catalog.get('tools')

    if not isinstance(tools_obj, list):
        return []

    out: List[Dict[str, Any]] = []
    seen = set()

    for t in tools_obj:
        name = _tool_name_from_obj(t)
        if not name or name in seen:
            continue
        seen.add(name)

        if isinstance(t, dict):
            desc: Dict[str, Any] = {'name': name}
            if isinstance(t.get('description'), str):
                desc['description'] = t.get('description')
            for k in ('input_schema', 'output_schema', 'schema'):
                if k in t and isinstance(t.get(k), dict):
                    desc[k] = t.get(k)
            out.append(desc)
            continue

        desc: Dict[str, Any] = {'name': name}
        if hasattr(t, 'description'):
            d = getattr(t, 'description')
            if isinstance(d, str):
                desc['description'] = d
        if hasattr(t, 'input_schema'):
            s = getattr(t, 'input_schema')
            if isinstance(s, dict):
                desc['input_schema'] = s
        if hasattr(t, 'output_schema'):
            s = getattr(t, 'output_schema')
            if isinstance(s, dict):
                desc['output_schema'] = s
        out.append(desc)

    return out

