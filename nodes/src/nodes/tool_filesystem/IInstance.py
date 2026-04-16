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
File system tool node — instance.

Exposes one ``@tool_function`` per operation already implemented by
``ai.account.file_store.FileStore``:

  * ``read_file(path, encoding?)``
  * ``write_file(path, content, encoding?)``
  * ``delete_file(path)``          — gated by ``allowDelete`` (default off)
  * ``list_directory(path?)``
  * ``create_directory(path)``
  * ``stat_file(path)``

Each method checks the corresponding allow-flag on ``self.IGlobal``, validates
the path against the configured regex whitelist, and then invokes the
``FileStore`` coroutine via a per-call event loop. Exceptions from the store
(``StorageError``, ``ValueError``) propagate to the agent as tool errors.

TODO (follow-up — see IGlobal.py docstring):
  * ``edit_file(path, old_string, new_string, replace_all?)``
  * ``move_file(src, dst)``
"""

from __future__ import annotations

import asyncio
from typing import Any

from rocketlib import IInstanceBase, tool_function

from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    # ------------------------------------------------------------------
    # Tool methods
    # ------------------------------------------------------------------

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['path'],
            'properties': {
                'path': {
                    'type': 'string',
                    'description': 'Relative path within the account file store (e.g. "notes/todo.md").',
                },
                'encoding': {
                    'type': 'string',
                    'description': 'Text encoding for decoding the file contents. Defaults to "utf-8".',
                    'default': 'utf-8',
                },
            },
            'additionalProperties': False,
        },
        description=('Read a file from the account file store and return its contents as a decoded string. Required: "path" (relative path). Optional: "encoding" (default "utf-8"). Returns: {path, content, size} where size is the byte length before decoding.'),
    )
    def read_file(self, args):
        args = _require_dict(args)
        self._check_ready()
        if not self.IGlobal.allow_read:
            raise ValueError('read access is not enabled for this filesystem tool')

        path = _require_str(args, 'path')
        encoding = _optional_str(args, 'encoding', default='utf-8') or 'utf-8'
        self._check_path(path)

        data = _run_async(self.IGlobal.file_store.read(path))
        try:
            content = data.decode(encoding)
        except UnicodeDecodeError as e:
            raise ValueError(f'Failed to decode file {path!r} using encoding {encoding!r}: {e}') from e
        return {'path': path, 'content': content, 'size': len(data)}

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['path', 'content'],
            'properties': {
                'path': {
                    'type': 'string',
                    'description': 'Relative path within the account file store.',
                },
                'content': {
                    'type': 'string',
                    'description': 'File contents (text). Encoded using the "encoding" field before writing.',
                },
                'encoding': {
                    'type': 'string',
                    'description': 'Text encoding used to encode "content" before writing. Defaults to "utf-8".',
                    'default': 'utf-8',
                },
            },
            'additionalProperties': False,
        },
        description=('Write (or overwrite) a file in the account file store. Required: "path", "content". Optional: "encoding" (default "utf-8"). Returns: {path, bytesWritten}.'),
    )
    def write_file(self, args):
        args = _require_dict(args)
        self._check_ready()
        if not self.IGlobal.allow_write:
            raise ValueError('write access is not enabled for this filesystem tool')

        path = _require_str(args, 'path')
        content = args.get('content')
        if not isinstance(content, str):
            raise ValueError('content is required and must be a string')
        encoding = _optional_str(args, 'encoding', default='utf-8') or 'utf-8'
        self._check_path(path)

        try:
            data = content.encode(encoding)
        except UnicodeEncodeError as e:
            raise ValueError(f'Failed to encode content using encoding {encoding!r}: {e}') from e

        _run_async(self.IGlobal.file_store.write(path, data))
        return {'path': path, 'bytesWritten': len(data)}

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['path'],
            'properties': {
                'path': {
                    'type': 'string',
                    'description': 'Relative path of the file to delete.',
                },
            },
            'additionalProperties': False,
        },
        description=('Delete a file from the account file store. Only available when the operator has enabled "allowDelete" on this node. Required: "path". Returns: {path, deleted: true}.'),
    )
    def delete_file(self, args):
        args = _require_dict(args)
        self._check_ready()
        if not self.IGlobal.allow_delete:
            raise ValueError('delete access is not enabled for this filesystem tool')

        path = _require_str(args, 'path')
        self._check_path(path)

        _run_async(self.IGlobal.file_store.delete(path))
        return {'path': path, 'deleted': True}

    @tool_function(
        input_schema={
            'type': 'object',
            'properties': {
                'path': {
                    'type': 'string',
                    'description': 'Relative directory path. Defaults to the account root.',
                    'default': '',
                },
            },
            'additionalProperties': False,
        },
        description=('List the immediate children of a directory in the account file store. Optional: "path" (defaults to the account root). Returns: {entries: [{name, type, size?, modified?}], count}.'),
    )
    def list_directory(self, args):
        args = _require_dict(args) if args is not None else {}
        self._check_ready()
        if not self.IGlobal.allow_list:
            raise ValueError('list access is not enabled for this filesystem tool')

        path = args.get('path', '')
        if not isinstance(path, str):
            raise ValueError('path must be a string')
        if path:
            self._check_path(path)

        result = _run_async(self.IGlobal.file_store.list_dir(path))
        return result

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['path'],
            'properties': {
                'path': {
                    'type': 'string',
                    'description': 'Relative directory path to create.',
                },
            },
            'additionalProperties': False,
        },
        description=('Create a directory in the account file store. Intermediate segments are created as needed. Required: "path". Returns: {path, created: true}.'),
    )
    def create_directory(self, args):
        args = _require_dict(args)
        self._check_ready()
        if not self.IGlobal.allow_mkdir:
            raise ValueError('mkdir access is not enabled for this filesystem tool')

        path = _require_str(args, 'path')
        self._check_path(path)

        _run_async(self.IGlobal.file_store.mkdir(path))
        return {'path': path, 'created': True}

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['path'],
            'properties': {
                'path': {
                    'type': 'string',
                    'description': 'Relative path to stat.',
                },
            },
            'additionalProperties': False,
        },
        description=('Get metadata for a file or directory in the account file store. Required: "path". Returns: {exists, type?, size?, modified?}.'),
    )
    def stat_file(self, args):
        args = _require_dict(args)
        self._check_ready()
        if not self.IGlobal.allow_stat:
            raise ValueError('stat access is not enabled for this filesystem tool')

        path = _require_str(args, 'path')
        self._check_path(path)

        return _run_async(self.IGlobal.file_store.stat(path))

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    # Map each @tool_function name to the IGlobal allow-flag that gates it.
    # Used by ``_collect_tool_methods`` to hide disabled tools from the agent
    # at ``tool.query`` discovery time (not just at invocation).
    _ALLOW_FLAG_BY_TOOL = {
        'read_file': 'allow_read',
        'write_file': 'allow_write',
        'delete_file': 'allow_delete',
        'list_directory': 'allow_list',
        'create_directory': 'allow_mkdir',
        'stat_file': 'allow_stat',
    }

    def _collect_tool_methods(self):
        """Filter out tool methods whose allow-flag is disabled.

        The base implementation returns every ``@tool_function`` method on the
        class. We override here so the engine's ``tool.query`` only advertises
        ops the operator has enabled — the LLM never sees a tool it isn't
        allowed to call.
        """
        methods = super()._collect_tool_methods()
        return {name: m for name, m in methods.items() if self._is_method_allowed(name)}

    def _is_method_allowed(self, name: str) -> bool:
        flag = self._ALLOW_FLAG_BY_TOOL.get(name)
        if flag is None:
            return True
        return bool(getattr(self.IGlobal, flag, False))

    def _check_ready(self) -> None:
        """Verify the FileStore was successfully initialised in beginGlobal()."""
        if self.IGlobal.file_store is None:
            raise ValueError('filesystem tool is not available: ROCKETRIDE_CLIENT_ID is missing or the account store failed to initialise (check pipeline logs)')

    def _check_path(self, path: str) -> None:
        """Enforce the configured path whitelist (if any)."""
        patterns = self.IGlobal.path_patterns or []
        if patterns and not any(p.search(path) for p in patterns):
            raise ValueError(f'path {path!r} does not match any allowed path pattern')


# ----------------------------------------------------------------------
# Module-level helpers
# ----------------------------------------------------------------------


def _require_dict(args: Any) -> dict:
    if not isinstance(args, dict):
        raise ValueError('Tool input must be a JSON object (dict)')
    return args


def _require_str(args: dict, key: str) -> str:
    val = args.get(key)
    if not isinstance(val, str) or not val.strip():
        raise ValueError(f'{key} is required and must be a non-empty string')
    return val


def _optional_str(args: dict, key: str, *, default: str | None = None) -> str | None:
    val = args.get(key, default)
    if val is None:
        return default
    if not isinstance(val, str):
        raise ValueError(f'{key} must be a string')
    return val


def _run_async(coro):
    """Run an async coroutine from a synchronous ``@tool_function`` method.

    The tool dispatcher invokes us synchronously. If no event loop is running
    on this thread, create a dedicated one and tear it down after the call;
    otherwise we'd deadlock reusing the already-running loop.
    """
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        # No running loop — safe to spin up our own.
        loop = asyncio.new_event_loop()
        try:
            return loop.run_until_complete(coro)
        finally:
            loop.close()
    # We are already inside an event loop — still need our own isolated loop
    # to drive the coroutine synchronously.
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()
