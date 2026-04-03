# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Memory (Internal) tool node instance.

Exposes ``put``, ``get``, ``list``, and ``clear`` tools backed by a
run-scoped ``MemoryStore``.  On ``open`` the store is cleared so every
client session starts fresh.
"""

from __future__ import annotations

from typing import Any

from rocketlib import IInstanceBase, tool_function

from .IGlobal import IGlobal
from .memory import MemoryStore


class IInstance(IInstanceBase):
    """Pipeline instance for the memory_internal tool node."""

    IGlobal: IGlobal
    _store: MemoryStore | None = None

    def beginInstance(self) -> None:
        self._store = MemoryStore()

    def open(self, _obj: Any) -> None:
        """Clear the memory store so each client session starts fresh."""
        self._store.clear()

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['key', 'value'],
            'properties': {
                'key': {'type': 'string', 'description': 'Storage key (alphanumeric, hyphens, underscores)'},
                'value': {'description': 'Value to store (string, number, object, or array)'},
            },
        },
        output_schema={'type': 'object', 'properties': {'ok': {'type': 'boolean'}, 'key': {'type': 'string'}}},
        description='Store a value (string, number, object, or array) under a key for later retrieval.',
    )
    def put(self, args):
        """Store a value under a key."""
        if not isinstance(args, dict):
            raise ValueError('args must be a dict')
        key = args.get('key')
        if not isinstance(key, str) or not key.strip():
            raise ValueError('"key" is required and must be a non-empty string')
        if 'value' not in args:
            raise ValueError('"value" is required')
        return self._store.put(key, args['value'])

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['key'],
            'properties': {
                'key': {'type': 'string', 'description': 'Key to retrieve'},
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'ok': {'type': 'boolean'},
                'key': {'type': 'string'},
                'value': {'description': 'The stored value, or null if not found'},
            },
        },
        description='Retrieve the full stored value for a key. Returns null if not found.',
    )
    def get(self, args):
        """Retrieve a value by key."""
        if not isinstance(args, dict):
            raise ValueError('args must be a dict')
        key = args.get('key')
        if not isinstance(key, str) or not key.strip():
            raise ValueError('"key" is required and must be a non-empty string')
        return self._store.get(key)

    @tool_function(
        input_schema={'type': 'object', 'properties': {}, 'required': []},
        output_schema={
            'type': 'object',
            'properties': {
                'ok': {'type': 'boolean'},
                'keys': {'type': 'array', 'items': {'type': 'string'}, 'description': 'Sorted list of all stored keys'},
            },
        },
        description='List all keys currently stored in memory.',
    )
    def list(self, args):
        """List all keys."""
        if not isinstance(args, dict):
            raise ValueError('args must be a dict')
        return self._store.list()

    @tool_function(
        input_schema={
            'type': 'object',
            'properties': {
                'key': {'type': 'string', 'description': 'Key to clear. Omit to clear all.'},
            },
            'required': [],
        },
        output_schema={
            'type': 'object',
            'properties': {
                'ok': {'type': 'boolean'},
                'cleared': {'type': 'array', 'items': {'type': 'string'}, 'description': 'Keys that were removed'},
            },
        },
        description='Clear a specific key or all keys. Omit key to clear everything.',
    )
    def clear(self, args):
        """Clear one or all keys."""
        if not isinstance(args, dict):
            raise ValueError('args must be a dict')
        key = args.get('key')
        if key is not None and not isinstance(key, str):
            raise ValueError('"key" must be a string if provided')
        return self._store.clear(key)
