# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""A large tool catalog shown as one line per tool, with full schemas loaded on demand.

An agent that puts every connected tool's full descriptor in every planning prompt
pays for the whole catalog on every step. Above a size budget the agent can show
each tool as ``- name: first sentence of its description`` instead, and load the
full descriptor of the tools it is going to call with one local step,
``tools.load``, that takes exact names or a search query.

This module holds the parts that do not depend on any agent: measuring a catalog,
the one-line summaries, the search, the selection rules of ``tools.load`` and the
``ToolView`` one planning prompt shows. It uses the standard library only.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import AbstractSet, Any, Callable, Dict, FrozenSet, Iterable, List, Optional, Sequence, Tuple

# Characters of serialized descriptors above which a catalog loads on demand.
# 0 sends every schema in every prompt.
DEFAULT_CATALOG_BUDGET = 0
SUMMARY_CHARS = 160
LOAD_LIMIT_DEFAULT = 5
# The most names one tools.load considers, and the most tools a query may add.
LOAD_LIMIT_MAX = 20
LOAD_TOOL = 'tools.load'
PEEK_TOOL = 'memory.peek'


def named_descriptors(descriptors: Iterable[Any]) -> List[Dict[str, Any]]:
    """The dict descriptors that have a non-empty name, in catalog order."""
    return [td for td in descriptors or [] if isinstance(td, dict) and td.get('name')]


def catalog_text(descriptors: Iterable[Any]) -> str:
    """The descriptors as the planner serializes them: one JSON line each; '' for none.

    A size measure. The planner writes ``(none)`` for an empty catalog itself.
    """
    return '\n'.join(json.dumps(td, ensure_ascii=False) for td in named_descriptors(descriptors))


def catalog_chars(descriptors: Iterable[Any]) -> int:
    """The length of :func:`catalog_text`, in characters."""
    return len(catalog_text(descriptors))


def summarize(description: Any, limit: int = SUMMARY_CHARS) -> str:
    """The first sentence of *description* on one line, cut to *limit* characters."""
    if not isinstance(description, str):
        return ''
    text = ' '.join(description.split())
    text = re.split(r'(?<=[.!?])\s', text, maxsplit=1)[0]
    if len(text) > limit:
        text = text[: limit - 3].rstrip() + '...'
    return text


def catalog_lines(descriptors: Iterable[Any], limit: int = SUMMARY_CHARS) -> List[str]:
    """One ``- name: summary`` line per tool (``- name`` when it has no description)."""
    lines = []
    for td in named_descriptors(descriptors):
        summary = summarize(td.get('description'), limit)
        lines.append(f'- {td["name"]}: {summary}' if summary else f'- {td["name"]}')
    return lines


def words(text: Any) -> List[str]:
    """Lowercase words of *text*, split at camelCase, ``_``, ``.`` and other non-alphanumerics."""
    if not isinstance(text, str):
        return []
    text = re.sub(r'([a-z0-9])([A-Z])', r'\1 \2', text)
    return re.findall(r'[a-z0-9]+', text.lower())


def _argument_names(td: Dict[str, Any]) -> List[str]:
    schema = td.get('inputSchema')
    props = schema.get('properties') if isinstance(schema, dict) else None
    return list(props) if isinstance(props, dict) else []


def search(descriptors: Iterable[Any], query: str, limit: int) -> List[Dict[str, Any]]:
    """The best matches for *query*, at most *limit*.

    Each query word scores 3 when it is a word of the tool's name, 1 when it is in
    the description and 1 when it is in an argument name. Ties keep catalog order.
    """
    wanted = set(words(query))
    if not wanted or limit <= 0:
        return []
    scored = []
    for order, td in enumerate(named_descriptors(descriptors)):
        args = {w for name in _argument_names(td) for w in words(name)}
        score = (
            3 * len(wanted & set(words(td['name'])))
            + len(wanted & set(words(td.get('description'))))
            + len(wanted & args)
        )
        if score > 0:
            scored.append((-score, order, td))
    scored.sort(key=lambda item: (item[0], item[1]))
    return [td for _, _, td in scored[:limit]]


def select(
    descriptors: Iterable[Any],
    *,
    names: Sequence[str] = (),
    query: str = '',
    limit: int = LOAD_LIMIT_DEFAULT,
    lookup: Optional[Callable[[str], Any]] = None,
) -> Tuple[List[Dict[str, Any]], List[str], List[str]]:
    """Choose the tools one ``tools.load`` loads.

    1. *names*, without repeats, in order. Only the first ``LOAD_LIMIT_MAX`` are
       considered; the rest come back as ignored.
    2. A name that is not in *descriptors* is resolved with *lookup* once, when
       one is given. A falsy result or an exception makes it unknown.
    3. *query* then adds its best matches that are not already chosen, at most
       *limit* of them (clamped to 1..``LOAD_LIMIT_MAX``).

    Returns:
        ``(found, unknown, ignored)``: the descriptors to load, the names that
        matched nothing, and the names beyond the limit.
    """
    catalog = named_descriptors(descriptors)
    by_name = {td['name']: td for td in catalog}
    distinct: List[str] = []
    for name in names:
        if name not in distinct:
            distinct.append(name)
    considered, ignored = distinct[:LOAD_LIMIT_MAX], distinct[LOAD_LIMIT_MAX:]

    found: List[Dict[str, Any]] = []
    unknown: List[str] = []
    for name in considered:
        td = by_name.get(name)
        if td is None and lookup is not None:
            try:
                hit = lookup(name)
            except Exception:
                hit = None
            if hit:
                td = hit if isinstance(hit, dict) and hit.get('name') else {'name': name}
        if td is None:
            unknown.append(name)
        else:
            found.append(td)

    if query:
        limit = max(1, min(LOAD_LIMIT_MAX, int(limit)))
        chosen = {td['name'] for td in found}
        added = 0
        for td in search(catalog, query, len(catalog)):
            if added >= limit:
                break
            if td['name'] not in chosen:
                found.append(td)
                chosen.add(td['name'])
                added += 1
    return found, unknown, ignored


@dataclass(frozen=True)
class ToolView:
    """What one planning prompt shows: the compact catalog, the descriptors shown in full, and their names."""

    catalog: Tuple[Dict[str, Any], ...]
    loaded: Tuple[Dict[str, Any], ...]
    shown: FrozenSet[str]


def tool_view(descriptors: Iterable[Any], loaded_names: AbstractSet[str]) -> ToolView:
    """The view of one catalog read: every named tool, and those of *loaded_names* still in it."""
    catalog = tuple(named_descriptors(descriptors))
    loaded = tuple(td for td in catalog if td['name'] in loaded_names)
    return ToolView(catalog=catalog, loaded=loaded, shown=frozenset(td['name'] for td in loaded))
