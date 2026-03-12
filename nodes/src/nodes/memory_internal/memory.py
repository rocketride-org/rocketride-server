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
    Produce a compact, human-readable preview of a stored string.
    
    If `value` contains JSON, it is pretty-printed for readability; otherwise the raw text is used. The returned string contains up to `max_lines` lines; if truncated, a final line of the form "... (N more lines)" indicates how many additional lines were omitted.
    
    Parameters:
        value (str): The stored string to preview.
        max_lines (int): Maximum number of lines to include in the preview.
    
    Returns:
        str: The preview string, possibly truncated with a trailing "... (N more lines)" line.
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
        """
        Initialize a run-scoped in-memory key-value store.
        
        Creates the internal `_store` dictionary that maps string keys to string values used by the MemoryStore instance.
        """
        self._store: Dict[str, str] = {}

    # ------------------------------------------------------------------
    # Operations
    # ------------------------------------------------------------------

    def put(self, key: str, value: str) -> Dict[str, Any]:
        """
        Store a value under a normalized memory key.
        
        Parameters:
            key (str): The key to store the value under. Leading and trailing whitespace are removed; key must be non-empty after stripping.
            value (Any): The value to store. Non-string values are converted to a string before storage.
        
        Returns:
            result (Dict[str, Any]): On success: `{'ok': True, 'key': <normalized key>}`. On validation failure: `{'ok': False, 'error': <error message>}`.
        """
        if not isinstance(key, str) or not key.strip():
            return {'ok': False, 'error': 'key must be a non-empty string'}

        k = key.strip()
        v = str(value) if not isinstance(value, str) else value

        self._store[k] = v
        return {'ok': True, 'key': k}

    def get(self, key: str) -> Dict[str, Any]:
        """
        Retrieve the full stored value for a key.
        
        Parameters:
            key (str): The key to look up; leading and trailing whitespace will be stripped.
        
        Returns:
            dict: Result object with:
                - `ok` (bool): `True` if the key exists, `False` otherwise.
                - `key` (str): The normalized key after stripping.
                - `value` (str | None): The stored string value when `ok` is `True`, otherwise `None`.
        """
        k = (key or '').strip()
        if k not in self._store:
            return {'ok': False, 'key': k, 'value': None}
        return {'ok': True, 'key': k, 'value': self._store[k]}

    def peek(self, key: str) -> Dict[str, Any]:
        """
        Produce a short preview of the value stored under the given key.
        
        The provided `key` is stripped of surrounding whitespace before lookup. If the key is not present, `exists` is `False` and `preview` is `None`; if present, `preview` is a compact, human-readable string (JSON pretty-printed when possible, otherwise trimmed text).
        
        Parameters:
            key (str): The key to look up (will be normalized by stripping surrounding whitespace).
        
        Returns:
            result (Dict[str, Any]): A dictionary containing:
                - 'ok' (bool): `True` if the key was found, `False` otherwise.
                - 'key' (str): The normalized key used for lookup.
                - 'exists' (bool): `True` if the key exists in the store, `False` otherwise.
                - 'preview' (str | None): The preview string when present, or `None` when absent.
        """
        k = (key or '').strip()
        if k not in self._store:
            return {'ok': False, 'key': k, 'exists': False, 'preview': None}
        # Delegate to _peek_preview which handles JSON pretty-printing
        preview = _peek_preview(self._store[k])
        return {'ok': True, 'key': k, 'exists': True, 'preview': preview}

    def list(self) -> Dict[str, Any]:
        """
        Retrieve a sorted list of all keys currently stored in memory.
        
        Returns:
            dict: A dictionary with `'ok'` set to `True` and `'keys'` containing a sorted list of the stored keys.
        """
        return {'ok': True, 'keys': sorted(self._store.keys())}

    def clear(self, key: Optional[str] = None) -> Dict[str, Any]:
        """
        Remove a specific stored key or clear all keys if no key is provided.
        
        Parameters:
            key (Optional[str]): The key to remove. If omitted or empty, all keys are cleared.
        
        Returns:
            result (Dict[str, Any]): A dictionary with:
                - 'ok' (bool): Always True on completion.
                - 'cleared' (List[str]): A list of keys that were removed. If a single key was requested but not present, this list is empty. When clearing all keys, this is the sorted list of keys that existed before the clear.
        """
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
        """
        Dispatches a memory.* tool call to the appropriate MemoryStore operation.
        
        tool_name must be a string beginning with "memory." followed by one of: "put", "get", "peek", "list", or "clear". args is expected to be a dict (non-dict values are treated as an empty dict). For operations that accept parameters, the dict may contain:
        - "key": the memory key to operate on
        - "value": the value to store (used by "put")
        
        Returns:
        A dictionary with an "ok" boolean and operation-specific fields:
        - put: {"ok": True, "key": k} on success or {"ok": False, "error": ...} on invalid input
        - get: {"ok": True, "key": k, "value": value} if present, otherwise {"ok": False, "key": k, "value": None}
        - peek: {"ok": True, "key": k, "exists": True, "preview": preview} if present, otherwise {"ok": False, "key": k, "exists": False, "preview": None}
        - list: {"ok": True, "keys": [...]}
        - clear: {"ok": True, "cleared": [...]} (cleared keys may be empty)
        - unknown operation: {"ok": False, "error": "unknown memory operation: '<op>'"}
        """
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
