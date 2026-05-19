# Copyright (c) 2026 Aparavi Software AG
# SPDX-License-Identifier: MIT
"""Pick attachments for tool calls based on inputSchema declarations.

Each tool's input schema declares attachment-typed properties via
``format: "rocketride-attachment"`` (TDD §6.5). The agent uses this
picker to select an Attachment from ``AgentContext.attachments`` for
each such property, respecting ``x-rocketride-mimes`` patterns.
Returns the filestore path (path-by-reference); the dispatcher
(Slice H) resolves it to bytes before calling the tool method.
"""

from __future__ import annotations

import fnmatch
from typing import Any, Dict, Optional, Sequence

from ai.common.schema import Attachment


def _mime_matches_patterns(mime: str, patterns: Sequence[str]) -> bool:
    if not patterns:
        return True
    for pat in patterns:
        if fnmatch.fnmatchcase(mime, pat):
            return True
    return False


def pick_for_property(prop_schema: Dict[str, Any], candidates: Sequence[Attachment]) -> Optional[Attachment]:
    """Return the first candidate whose MIME matches the schema's patterns, or None.

    Returns ``None`` when the property is not attachment-typed
    (``format != "rocketride-attachment"``) or no candidate matches the
    declared ``x-rocketride-mimes`` patterns. Absent patterns accept any
    MIME.
    """
    if prop_schema.get('format') != 'rocketride-attachment':
        return None
    patterns = prop_schema.get('x-rocketride-mimes') or []
    for att in candidates:
        if _mime_matches_patterns(att.mime, patterns):
            return att
    return None


def pick_for_tool_call(input_schema: Dict[str, Any], candidates: Sequence[Attachment]) -> Dict[str, str]:
    """Return ``{prop_name: filestore_path}`` for every matched attachment slot.

    Top-level walk only — mirrors the dispatcher's resolution scope
    (TDD §10.3, Q-H2). Properties whose schema is not a dict, or that
    are not attachment-typed, or for which no candidate matches, are
    omitted from the returned mapping.
    """
    out: Dict[str, str] = {}
    props = (input_schema or {}).get('properties') or {}
    for prop_name, prop_schema in props.items():
        if not isinstance(prop_schema, dict):
            continue
        picked = pick_for_property(prop_schema, candidates)
        if picked is not None:
            out[prop_name] = picked.path
    return out
