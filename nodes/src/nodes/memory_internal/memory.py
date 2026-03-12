# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Run-scoped keyed memory store exposed as a standalone tool node.

Exposed to the planning LLM as five tools:
  memory.put    — store a value under a key
  memory.get    — retrieve full value by key
  memory.peek   — retrieve a small preview (first ~10 lines) without pulling
                  the full value into the planning context
  memory.list   — list all current keys
  memory.clear  — clear one key or all keys
"""

from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

_PEEK_LINES = 10        # max lines returned by memory.peek
_MEMORY_PREFIX = 'memory.'

TOOL_DESCRIPTORS: List[Dict[str, Any]] = [
    {
        'name': 'memory.put',
        'description': 'Store a string value under a key for later retrieval.',
        'input_schema': {
            'type': 'object',
            'properties': {
                'key': {'type': 'string', 'description': 'Storage key (alphanumeric, hyphens, underscores)'},
                'value': {'type': 'string', 'description': 'Value to store'},
            },
            'required': ['key', 'value'],
        },
    },
    {
        'name': 'memory.get',
        'description': 'Retrieve the full stored value for a key. Returns null if not found.',
        'input_schema': {
            'type': 'object',
            'properties': {
                'key': {'type': 'string', 'description': 'Key to retrieve'},
            },
            'required': ['key'],
        },
    },
    {
        'name': 'memory.peek',
        'description': (
            'Return a small preview of a stored value (first ~10 lines of JSON or text) '
            'without loading the full value. Use this to decide whether memory.get is needed.'
        ),
        'input_schema': {
            'type': 'object',
            'properties': {
                'key': {'type': 'string', 'description': 'Key to preview'},
            },
            'required': ['key'],
        },
    },
    {
        'name': 'memory.list',
        'description': 'List all keys currently stored in memory.',
        'input_schema': {
            'type': 'object',
            'properties': {},
            'required': [],
        },
    },
    {
        'name': 'memory.clear',
        'description': 'Clear a specific key or all keys. Omit key to clear everything.',
        'input_schema': {
            'type': 'object',
            'properties': {
                'key': {'type': 'string', 'description': 'Key to clear. Omit to clear all.'},
            },
            'required': [],
        },
    },
]


def _peek_preview(value: str, max_lines: int = _PEEK_LINES) -> str:
    """
    Return a compact preview of a stored string value.

    If the value is valid JSON, pretty-prints it and returns the first
    `max_lines` lines so the structure is visible. Falls back to the
    first `max_lines` lines of the raw string.
    """
    # Try to pretty-print JSON so the structure is visible in the preview
    try:
        parsed = json.loads(value)
        pretty = json.dumps(parsed, indent=2, ensure_ascii=False)
        lines = pretty.splitlines()
    except (json.JSONDecodeError, ValueError):
        # Not JSON — just split the raw text into lines
        lines = value.splitlines()

    # Return the first N lines, appending a count of truncated lines
    if len(lines) <= max_lines:
        return '\n'.join(lines)
    return '\n'.join(lines[:max_lines]) + f'\n... ({len(lines) - max_lines} more lines)'


class MemoryStore:
    """Run-scoped keyed memory for the RocketRide planning agent."""

    def __init__(self) -> None:
        self._store: Dict[str, str] = {}

    # ------------------------------------------------------------------
    # Operations
    # ------------------------------------------------------------------

    def put(self, key: str, value: str) -> Dict[str, Any]:
        """Store a value under a key."""
        if not isinstance(key, str) or not key.strip():
            return {'ok': False, 'error': 'key must be a non-empty string'}

        k = key.strip()
        v = str(value) if not isinstance(value, str) else value

        self._store[k] = v
        return {'ok': True, 'key': k}

    def get(self, key: str) -> Dict[str, Any]:
        """Retrieve the full stored value for a key, or ``None`` if missing."""
        k = (key or '').strip()
        if k not in self._store:
            return {'ok': False, 'key': k, 'value': None}
        return {'ok': True, 'key': k, 'value': self._store[k]}

    def peek(self, key: str) -> Dict[str, Any]:
        """Return a short preview of a stored value without the full payload."""
        k = (key or '').strip()
        if k not in self._store:
            return {'ok': False, 'key': k, 'exists': False, 'preview': None}
        # Delegate to _peek_preview which handles JSON pretty-printing
        preview = _peek_preview(self._store[k])
        return {'ok': True, 'key': k, 'exists': True, 'preview': preview}

    def list(self) -> Dict[str, Any]:
        """Return a sorted list of all keys currently in memory."""
        return {'ok': True, 'keys': sorted(self._store.keys())}

    def clear(self, key: Optional[str] = None) -> Dict[str, Any]:
        """Clear a specific key or, if *key* is omitted, all keys."""
        if key and key.strip():
            # Single-key removal
            k = key.strip()
            removed = k in self._store
            self._store.pop(k, None)
            return {'ok': True, 'cleared': [k] if removed else []}

        # No key provided — wipe the entire store
        cleared = sorted(self._store.keys())
        self._store.clear()
        return {'ok': True, 'cleared': cleared}

    # ------------------------------------------------------------------
    # Tool dispatch
    # ------------------------------------------------------------------

    def dispatch(self, tool_name: str, args: Any) -> Dict[str, Any]:
        """Route a ``memory.*`` tool call to the corresponding method."""
        if not isinstance(args, dict):
            args = {}

        # Strip the "memory." prefix to get the operation name
        op = tool_name[len(_MEMORY_PREFIX):]
        if op == 'put':
            return self.put(args.get('key', ''), args.get('value', ''))
        if op == 'get':
            return self.get(args.get('key', ''))
        if op == 'peek':
            return self.peek(args.get('key', ''))
        if op == 'list':
            return self.list()
        if op == 'clear':
            return self.clear(args.get('key'))
        return {'ok': False, 'error': f'unknown memory operation: {op!r}'}
