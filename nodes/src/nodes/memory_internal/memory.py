# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Run-scoped keyed memory store exposed as a standalone memory node.

Exposed via host.memory as four operations:
  memory.put    — store a value (string, object, or array) under a key
  memory.get    — retrieve full value by key
  memory.list   — list all current keys
  memory.clear  — clear one key or all keys

All smart logic (structural summaries, JMESPath extraction, chunked reading)
lives in the executor, not here. This store is intentionally simple.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

_MEMORY_PREFIX = 'memory.'

_OK_SCHEMA: Dict[str, Any] = {
    'type': 'object',
    'properties': {
        'ok': {'type': 'boolean'},
        'key': {'type': 'string'},
    },
}

TOOL_DESCRIPTORS: List[Dict[str, Any]] = [
    {
        'name': 'memory.put',
        'description': 'Store a value (string, number, object, or array) under a key for later retrieval.',
        'inputSchema': {
            'type': 'object',
            'properties': {
                'key': {'type': 'string', 'description': 'Storage key (alphanumeric, hyphens, underscores)'},
                'value': {'description': 'Value to store (string, number, object, or array)'},
            },
            'required': ['key', 'value'],
        },
        'outputSchema': _OK_SCHEMA,
    },
    {
        'name': 'memory.get',
        'description': 'Retrieve the full stored value for a key. Returns null if not found.',
        'inputSchema': {
            'type': 'object',
            'properties': {
                'key': {'type': 'string', 'description': 'Key to retrieve'},
            },
            'required': ['key'],
        },
        'outputSchema': {
            'type': 'object',
            'properties': {
                'ok': {'type': 'boolean'},
                'key': {'type': 'string'},
                'value': {'description': 'The stored value, or null if not found'},
            },
        },
    },
    {
        'name': 'memory.list',
        'description': 'List all keys currently stored in memory.',
        'inputSchema': {
            'type': 'object',
            'properties': {},
            'required': [],
        },
        'outputSchema': {
            'type': 'object',
            'properties': {
                'ok': {'type': 'boolean'},
                'keys': {'type': 'array', 'items': {'type': 'string'}, 'description': 'Sorted list of all stored keys'},
            },
        },
    },
    {
        'name': 'memory.clear',
        'description': 'Clear a specific key or all keys. Omit key to clear everything.',
        'inputSchema': {
            'type': 'object',
            'properties': {
                'key': {'type': 'string', 'description': 'Key to clear. Omit to clear all.'},
            },
            'required': [],
        },
        'outputSchema': {
            'type': 'object',
            'properties': {
                'ok': {'type': 'boolean'},
                'cleared': {'type': 'array', 'items': {'type': 'string'}, 'description': 'Keys that were removed'},
            },
        },
    },
]


class MemoryStore:
    """Run-scoped keyed memory for the RocketRide planning agent."""

    def __init__(self) -> None:
        self._store: Dict[str, Any] = {}

    # ------------------------------------------------------------------
    # Operations
    # ------------------------------------------------------------------

    def put(self, key: str, value: Any) -> Dict[str, Any]:
        """Store a value (string, number, object, or array) under a key."""
        if not isinstance(key, str) or not key.strip():
            return {'ok': False, 'error': 'key must be a non-empty string'}

        k = key.strip()
        self._store[k] = value
        return {'ok': True, 'key': k}

    def get(self, key: str) -> Dict[str, Any]:
        """Retrieve the full stored value for a key, or ``None`` if missing."""
        k = (key or '').strip()
        if k not in self._store:
            return {'ok': False, 'key': k, 'value': None}
        return {'ok': True, 'key': k, 'value': self._store[k]}

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
        op = tool_name[len(_MEMORY_PREFIX) :]
        if op == 'put':
            return self.put(args.get('key', ''), args.get('value'))
        if op == 'get':
            return self.get(args.get('key', ''))
        if op == 'list':
            return self.list()
        if op == 'clear':
            return self.clear(args.get('key'))
        return {'ok': False, 'error': f'unknown memory operation: {op!r}'}
