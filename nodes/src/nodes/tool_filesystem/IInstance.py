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
"""

from __future__ import annotations

import asyncio
import mimetypes
import os
import sys
import threading
from typing import TYPE_CHECKING, Any

from rocketlib import IInstanceBase, tool_function, warning

if TYPE_CHECKING:
    # Annotation-only (PEP 563 lazy annotations): keeps minimal test stubs of
    # ``rocketlib`` (which predate ``Entry``) importable at runtime.
    from rocketlib import Entry

from ai.common.avi.descriptor import descriptor_from_payload
from ai.common.utils import optional_str, require_dict, require_str

from .IGlobal import IGlobal, OnConflict

# Cap on bytes returned by a single read_file call. The underlying FileStore
# defaults to 100 MB, which can blow the agent's context window or OOM the
# engine subprocess long before the LLM ever sees the result. Agents that need
# more than MAX_READ_LIMIT in one shot must use a streaming approach.
DEFAULT_READ_LIMIT = 256 * 1024  # 256 KB
MAX_READ_LIMIT = 4 * 1024 * 1024  # 4 MB

# Upper bound on the `_1`, `_2`, … collision suffixes the sink will try before
# giving up. Bounds the probe loop so a store that keeps reporting a path as
# existing (e.g. a directory, or heavy concurrent writes) can't spin forever.
MAX_COLLISION_SUFFIX = 100


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
                'maxBytes': {
                    'type': 'integer',
                    'description': f'Maximum bytes to read. Default {DEFAULT_READ_LIMIT}, hard ceiling {MAX_READ_LIMIT}. Files larger than the cap are rejected with an error — use a smaller maxBytes for sampling, or split the file.',
                    'default': DEFAULT_READ_LIMIT,
                    'minimum': 1,
                    'maximum': MAX_READ_LIMIT,
                },
            },
            'additionalProperties': False,
        },
        description=(
            'Read a file from the account file store and return its contents as a decoded string. Required: "path" (relative path). Optional: "encoding" (default "utf-8"), "maxBytes" (default 256 KB, max 4 MB). Returns: {path, content, size} where size is the byte length before decoding. Files larger than maxBytes are rejected.'
        ),
    )
    def read_file(self, args):
        path, encoding, _ = self._prepare(args, 'read_file', needs_encoding=True)

        # `_prepare` accepts None for `args` but doesn't return the normalised
        # dict, so guard here before pulling the per-op `maxBytes` field.
        max_bytes = (args or {}).get('maxBytes', DEFAULT_READ_LIMIT)
        if not isinstance(max_bytes, int) or isinstance(max_bytes, bool):
            raise ValueError('maxBytes must be an integer')
        if max_bytes < 1:
            raise ValueError('maxBytes must be at least 1')
        max_bytes = min(max_bytes, MAX_READ_LIMIT)

        data = _run_async(self.IGlobal.file_store.read(path, max_size=max_bytes))
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
        description=(
            'Write (or overwrite) a file in the account file store. Required: "path", "content". Optional: "encoding" (default "utf-8"). Returns: {path, bytesWritten}.'
        ),
    )
    def write_file(self, args):
        path, encoding, content = self._prepare(args, 'write_file', needs_encoding=True, needs_content=True)

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
        description=(
            'Delete a file from the account file store. Only available when the operator has enabled "allowDelete" on this node. Required: "path". Returns: {path, deleted: true}.'
        ),
    )
    def delete_file(self, args):
        path, _, _ = self._prepare(args, 'delete_file')

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
        description=(
            'List the immediate children of a directory in the account file store. Optional: "path" (defaults to the account root). Returns: {entries: [{name, type, size?, modified?}], count}.'
        ),
    )
    def list_directory(self, args):
        path, _, _ = self._prepare(args, 'list_directory', path_required=False)

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
        description=(
            'Create a directory in the account file store. Intermediate segments are created as needed. Required: "path". Returns: {path, created: true}.'
        ),
    )
    def create_directory(self, args):
        path, _, _ = self._prepare(args, 'create_directory')

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
        description=(
            'Get metadata for a file or directory in the account file store. Required: "path". Returns: {exists, type?, size?, modified?}.'
        ),
    )
    def stat_file(self, args):
        path, _, _ = self._prepare(args, 'stat_file')

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
        # When FileStore couldn't be initialised (e.g. no running task identity
        # missing), hide every tool method so the LLM never sees something it
        # can't successfully invoke. ``beginGlobal()`` already logged a warning
        # with the reason.
        if self.IGlobal.file_store is None:
            return False

        flag = self._ALLOW_FLAG_BY_TOOL.get(name)
        if flag is None:
            return True
        return bool(getattr(self.IGlobal, flag, False))

    def _prepare(
        self,
        args: Any,
        tool_name: str,
        *,
        path_required: bool = True,
        needs_encoding: bool = False,
        needs_content: bool = False,
    ) -> tuple[str, str | None, str | None]:
        """Shared prologue for every ``@tool_function`` method: validates
        ``args`` is a dict (``None`` becomes ``{}``), verifies the FileStore
        initialised, enforces the allow-flag, extracts the per-op fields, and
        checks ``path`` against the whitelist.

        ``path_required=False`` makes ``path`` optional (defaults to ``''``,
        meaning the account root) — use this for directory-listing-style ops.
        ``needs_encoding`` / ``needs_content`` pull those fields for ops that
        take them. Fields not requested are returned as ``None``.

        This duplicates the filtering done by ``_collect_tool_methods``
        intentionally — defence-in-depth against direct method calls that
        bypass the tool dispatcher.
        """
        args = require_dict(args) if args is not None else {}
        self._check_ready()
        flag_attr = self._ALLOW_FLAG_BY_TOOL.get(tool_name)
        if flag_attr is None:
            raise RuntimeError(f'no allow-flag mapping for tool {tool_name!r}')
        if not getattr(self.IGlobal, flag_attr, False):
            label = flag_attr.removeprefix('allow_')
            raise ValueError(f'{label} access is not enabled for this filesystem tool')

        if path_required:
            path = require_str(args, 'path', tool_name=tool_name)
            self._check_path(path)
        else:
            path = args.get('path', '')
            if not isinstance(path, str):
                raise ValueError('path must be a string')
            # Empty path means "account root" for list-style ops; skip the
            # whitelist check so a configured whitelist doesn't block listing
            # the root (an empty string can't match a non-trivial regex).
            if path:
                self._check_path(path)

        encoding: str | None = None
        if needs_encoding:
            encoding = optional_str(args, 'encoding', default='utf-8', tool_name=tool_name) or 'utf-8'

        content: str | None = None
        if needs_content:
            content = args.get('content')
            if not isinstance(content, str):
                raise ValueError('content is required and must be a string')

        return path, encoding, content

    def _check_ready(self) -> None:
        """Verify the FileStore was successfully initialised in beginGlobal()."""
        if self.IGlobal.file_store is None:
            raise ValueError(
                'filesystem tool is not available: no running task identity (rocketlib.getTask) or the account store failed to initialise (check pipeline logs)'
            )

    def _check_path(self, path: str) -> None:
        """Enforce the configured path whitelist (if any)."""
        patterns = self.IGlobal.path_patterns or []
        if patterns and not any(p.search(path) for p in patterns):
            raise ValueError(f'path {path!r} does not match any allowed path pattern')

    # ------------------------------------------------------------------
    # Pipeline sink (lanes)
    #
    # The node doubles as a pipeline sink: data arriving on a lane is written to
    # the account-scoped FileStore and a JSON reference is emitted downstream.
    # Each lane owns its own filename rule — text/table are markdown, documents
    # keep the source extension, media derive from the mime — instead of one
    # tangled precedence chain.
    # ------------------------------------------------------------------

    def _sink_base_name(self) -> str:
        """Filename stem from the source object's name, else its objectId."""
        obj = self.instance.currentObject
        name = getattr(obj, 'name', None)
        if getattr(obj, 'hasName', False) and name:
            return os.path.splitext(os.path.basename(name))[0] or str(obj.objectId)
        return str(obj.objectId)

    def _sink_source_ext(self) -> str:
        """Extension from the source object's name, or '' when nameless."""
        obj = self.instance.currentObject
        name = getattr(obj, 'name', None)
        if getattr(obj, 'hasName', False) and name:
            return os.path.splitext(os.path.basename(name))[1]
        return ''

    def _sink_target_path(self, filename: str, *, index: int | None = None) -> str | None:
        """Resolve the store path to write to under targetDir, per ``onConflict``.

        ``overwrite`` returns the path unprobed, ``skip`` yields ``None`` if a file is
        already there, ``unique`` suffixes ``_1``, ``_2``, … up to
        ``MAX_COLLISION_SUFFIX``. Each candidate is whitelist-checked *before* it is
        probed, so a rejected path never reveals whether files exist in the store.

        Args:
            filename: Name the object carries.
            index:    Ordinal used to disambiguate several files from one object.

        Returns:
            The path to write, or ``None`` when ``skip`` left an existing file alone —
            not an error, and logged here rather than at each caller.
        """
        target_dir = (self.IGlobal.target_dir or '').strip()
        if target_dir and not target_dir.endswith('/'):
            target_dir += '/'
        stem, ext = os.path.splitext(filename)
        if index is not None:
            stem = f'{stem}_{index}'

        candidate = f'{target_dir}{stem}{ext}'
        self._check_path(candidate)

        if self.IGlobal.on_conflict == OnConflict.OVERWRITE:
            # No probe: replacing is the point, so a stat only costs a round-trip.
            return candidate

        if self.IGlobal.on_conflict == OnConflict.SKIP:
            # 'both' is an object store holding a key and a same-named prefix: still a file.
            if _run_async(self.IGlobal.file_store.stat(candidate)).get('type') in ('file', 'both'):
                warning(f'tool_filesystem: {filename!r} already exists and onConflict is skip; not written')
                return None
            return candidate

        n = 0
        while _run_async(self.IGlobal.file_store.stat(candidate)).get('exists'):
            n += 1
            if n > MAX_COLLISION_SUFFIX:
                raise ValueError(
                    f'could not find a free path for {filename!r} under {target_dir!r}: '
                    f'{MAX_COLLISION_SUFFIX} suffixed variants are already taken'
                )
            candidate = f'{target_dir}{stem}_{n}{ext}'
            self._check_path(candidate)
        return candidate

    def _sink_ref(self, path: str, mime: str | None = None) -> dict:
        """Reference dict for a persisted file, resolving a signed URL if configured."""
        url = None
        if self.IGlobal.emit_url:
            url = _run_async(self.IGlobal.file_store.get_url(path, expires_in=self.IGlobal.url_expires_in))
        return {'storePath': path, 'url': url, 'name': os.path.basename(path), 'mime': mime}

    def _sink_write(self, data: bytes, filename: str, *, index: int | None = None) -> dict | None:
        """Persist ``data`` in one shot (documents/text/table) and return a ref.

        Enforces ``allow_write``; ``_sink_target_path`` applies the whitelist to
        every candidate before probing, so a rejected path never touches the store.

        Returns:
            The reference, or ``None`` when the conflict policy skipped the write.
        """
        self._check_ready()
        if not self.IGlobal.allow_write:
            raise ValueError('write access is not enabled for this filesystem tool')
        path = self._sink_target_path(filename, index=index)
        if path is None:
            return None
        _run_async(self.IGlobal.file_store.write(path, data))
        return self._sink_ref(path)

    def _sink_emit(self, refs: list[dict]) -> None:
        """Emit one JSON reference per persisted file on the ``json`` lane.

        The payload is ``{'path': <store-relative path>}`` plus a ``'url'`` key
        when a signed download URL was resolved (``emitUrl`` on). Plain JSON —
        no Doc/chunkId semantics — so downstream JSON consumers get the refs
        without vector-store metadata riding along.
        """
        # A skipped write yields None; dropping those keeps refs to files actually written.
        refs = [ref for ref in refs if ref]
        if not refs:
            return
        if 'json' not in self.instance.getListeners():
            return
        for ref in refs:
            payload = {'path': ref['storePath']}
            if ref.get('url'):
                payload['url'] = ref['url']
            self.instance.writeJson(payload)

    # -- source render (File Store Source variant) ---------------------

    def renderObject(self, object: Entry):
        """Deliver one scanned file for the ``filestore_source://`` variant.

        In the engine's DIRECT pipeline mode, ``IEndpoint.scanObjects`` reports
        entries through the scan callback and the engine calls back here per
        entry with the target pipe already open. Delegates the read + raw tag
        stream to :meth:`IEndpoint.renderStoreObject`, then prevents the C++
        default render (which would try to re-read the object through the
        endpoint stream API this node does not implement).

        The sink/tool variants of this folder never receive ``renderObject``
        (it is only invoked on pipeline-source pipes), but guard anyway so a
        non-source endpoint falls through to the engine default.
        """
        _register_debugger_thread()
        render = getattr(self.IEndpoint, 'renderStoreObject', None)
        if render is None:
            return
        render(object, self.instance)
        return self.preventDefault()

    # -- lane handlers -------------------------------------------------

    def open(self, object: Entry):
        """Per-object reset: stale media streams are dropped.

        A stream aborted before END (upstream error, dropped object) would
        otherwise keep its write handle and half-written file alive, and the
        next object's chunks would land in it.
        """
        for kind in list(getattr(self, '_media_streams', None) or {}):
            self._media_abort(kind)

    def closing(self):
        """Last chance to drop a stream: no further object will open to sweep it.

        Without this a run whose final object is cut off leaves its partial file in the
        store for good — a truncated file under ``unique``/``skip``, an orphaned
        ``.part-*`` under ``overwrite``.
        """
        for kind in list(getattr(self, '_media_streams', None) or {}):
            self._media_abort(kind)

    def writeDocuments(self, documents):
        """Documents lane: ``page_content`` is parsed text, so it always stores .txt.

        The source extension never wins here — a parsed ``report.pdf`` stores as
        ``report.txt``, keeping the stored extension truthful about the bytes
        (same rule that stores text/table as .md).
        """
        docs = list(documents or [])
        base = self._sink_base_name()
        multi = len(docs) > 1
        refs = []
        for idx, doc in enumerate(docs):
            content = getattr(doc, 'page_content', None) or ''
            data = content.encode('utf-8') if isinstance(content, str) else bytes(content)
            refs.append(self._sink_write(data, f'{base}.txt', index=idx if multi else None))
        self._sink_emit(refs)
        return self.preventDefault()

    def writeText(self, text: str):
        """Text lane: content is markdown, so it is always stored as .md."""
        data = (text or '').encode('utf-8')
        self._sink_emit([self._sink_write(data, f'{self._sink_base_name()}.md')])
        return self.preventDefault()

    def writeTable(self, table: str):
        """Table lane: content is a markdown table, so it is always stored as .md."""
        data = (table or '').encode('utf-8')
        self._sink_emit([self._sink_write(data, f'{self._sink_base_name()}.md')])
        return self.preventDefault()

    # -- streamed media ------------------------------------------------

    def _media_ext(self, mime: str | None) -> str:
        """Extension for streamed media: mime first, then source ext, then .bin."""
        return _ext_from_mime(mime) or self._sink_source_ext() or '.bin'

    def _media_abort(self, kind: str) -> None:
        """Discard an in-flight stream (e.g. a fresh BEGIN before the previous END)."""
        streams = getattr(self, '_media_streams', None)
        if not streams:
            return
        st = streams.pop(kind, None)
        if st and st.get('handle') is not None:
            # Best-effort close, then best-effort delete — separately, so a
            # failed close never strands the partial file in the store.
            try:
                _run_on_stream_loop(self.IGlobal.file_store.close_write(st['handle']))
            except Exception:
                pass
            self._discard_partial(st)

    def _staging_path(self, path: str) -> str:
        """A sibling path to stream into before it replaces ``path``.

        Args:
            path: The final destination.

        Returns:
            The staging path.

        Raises:
            ValueError: If the whitelist admits the destination but not the sibling.
        """
        staged = f'{path}.part-{self.instance.currentObject.objectId}'
        self._check_path(staged)
        return staged

    def _write_path_for(self, path: str) -> str:
        """Where the stream's bytes actually go.

        Only ``overwrite`` stages: ``open_write`` truncates the destination, so the bytes
        go to a sibling and rename in on success, keeping the existing file until a
        complete one can replace it. ``unique`` and ``skip`` probed their path free.

        Args:
            path: The final destination.

        Returns:
            The path to open for writing — the destination itself, or a staging sibling.
        """
        if self.IGlobal.on_conflict != OnConflict.OVERWRITE:
            return path
        try:
            return self._staging_path(path)
        except ValueError:
            # Writing in place is worse than staging, better than failing a pipeline
            # that worked before staging existed.
            warning(
                f'tool_filesystem: the path whitelist rejects a staging file beside {path!r}; '
                'writing in place, so an interrupted stream will leave it incomplete'
            )
            return path

    def _media_commit(self, st: dict) -> None:
        """Finish a completed stream: close it, swap it in if staged, emit its reference.

        Args:
            st: The stream state; must carry an open ``handle``.
        """
        try:
            _run_on_stream_loop(self.IGlobal.file_store.close_write(st['handle']))
            if st['write_path'] != st['path']:
                # Staged: the destination is replaced only now, and only by a whole file.
                _run_on_stream_loop(self.IGlobal.file_store.rename(st['write_path'], st['path'], overwrite=True))
        except Exception:
            # A failed commit leaves an incomplete file: remove it before
            # propagating, so downstream never sees a truncated object.
            self._discard_partial(st)
            raise
        self._sink_emit([self._sink_ref(st['path'], st['mime'])])

    def _discard_partial(self, st: dict) -> None:
        """Remove what a half-written stream produced.

        Always safe: ``unique`` and ``skip`` probed the path free before opening it, and
        ``overwrite`` wrote to a staging sibling — so this file is one the stream created.

        Args:
            st: The stream state being discarded.
        """
        write_path = st.get('write_path')
        if not write_path:
            return
        try:
            _run_on_stream_loop(self.IGlobal.file_store.delete(write_path))
        except Exception as e:
            # The leftover is inert, but silence means nobody ever learns it is there.
            warning(f'tool_filesystem: could not remove {write_path!r} after a failed write: {e}')

    def _stream_filename(self, descriptor, mime: str) -> str:
        """Filename for one media stream, preferring the name the stream carries.

        A producer that fans one object out into several streams (frame_grabber's
        frames, a cropper's crops) names each one in the BEGIN descriptor. Using it
        is what keeps those distinguishable: derived from ``currentObject`` alone
        they would all collide on the source object's name.

        The name is untrusted — it comes from whatever node is upstream and is used
        to build a store path — so it is reduced to a bare filename here. Both
        separators are checked explicitly: ``os.path.basename`` on a POSIX host
        leaves ``..\\..\\x`` untouched, and the store's own ``..`` rejection is a
        second wall, not the only one.
        """
        name = getattr(getattr(descriptor, 'metadata', None), 'name', None) if descriptor else None
        if name:
            name = os.path.basename(str(name).replace('\\', '/'))
        if not name or '/' in name or '\\' in name:
            name = None
        ext = self._media_ext(mime)
        if not name:
            return f'{self._sink_base_name()}{ext}'
        # A stream can legitimately arrive named without an extension, and splitext cannot tell:
        # it reads `1.crop0` as extension `.crop0`. The mime is authoritative for media, so
        # append it unless it is already there.
        return name if name.lower().endswith(ext.lower()) else f'{name}{ext}'

    def _sink_media(self, kind: str, aviAction, mimeType: str, data: bytes) -> None:
        """Stream media chunks straight to the store with bounded memory.

        The write handle is opened lazily on the first non-empty chunk, so an
        empty stream never creates a file. On END the file is committed and a
        reference emitted; a fresh BEGIN discards any half-written prior stream.
        """
        from rocketlib import AVI_ACTION

        streams = getattr(self, '_media_streams', None)
        if streams is None:
            streams = self._media_streams = {}

        if aviAction == AVI_ACTION.BEGIN:
            # A stream still open here is one the engine declined to settle: cut off, or
            # carrying no declared size to check against. Releasing it is this node's job —
            # only it knows about the open handle and the .part-* sibling.
            self._media_abort(kind)
            # BEGIN carries the stream descriptor, which is the only place the stream's
            # own name appears; keep it for _stream_filename.
            streams[kind] = {
                'handle': None,
                'path': None,
                'mime': mimeType,
                'descriptor': descriptor_from_payload(data),
            }
        elif aviAction == AVI_ACTION.WRITE:
            st = streams.get(kind)
            if st is None or not data:
                return
            if st['handle'] is None:
                self._check_ready()
                if not self.IGlobal.allow_write:
                    raise ValueError('write access is not enabled for this filesystem tool')
                name = self._stream_filename(st.get('descriptor'), st['mime'])
                path = self._sink_target_path(name)
                if path is None:
                    # Dropped, so the remaining chunks and the END find nothing.
                    streams.pop(kind, None)
                    return
                write_path = self._write_path_for(path)
                st['handle'] = _run_on_stream_loop(self.IGlobal.file_store.open_write(write_path))
                st['path'] = path
                st['write_path'] = write_path
            try:
                _run_on_stream_loop(self.IGlobal.file_store.write_chunk(st['handle'], bytes(data)))
            except Exception:
                # Nothing revisits this stream, so its handle would hold the store's
                # write lock until the next object's open().
                self._media_abort(kind)
                raise
        elif aviAction == AVI_ACTION.END:
            st = streams.pop(kind, None)
            # An empty stream never opened a handle, so there is nothing to commit.
            if st is None or st['handle'] is None:
                return
            self._media_commit(st)

    def writeImage(self, aviAction, mimeType: str, buffer: bytes):
        """Image lane: stream to store, emit a reference on END."""
        self._sink_media('image', aviAction, mimeType, buffer)
        return self.preventDefault()

    def writeAudio(self, aviAction, mimeType: str, data: bytes):
        """Audio lane: stream to store, emit a reference on END."""
        self._sink_media('audio', aviAction, mimeType, data)
        return self.preventDefault()

    def writeVideo(self, aviAction, mimeType: str, data: bytes):
        """Video lane: stream to store, emit a reference on END."""
        self._sink_media('video', aviAction, mimeType, data)
        return self.preventDefault()


# ----------------------------------------------------------------------
# Module-level helpers
# ----------------------------------------------------------------------

# MIME types the stdlib ``mimetypes`` module maps inconsistently (or not at all)
# across platforms. Checked before the generic subtype fallback so results are
# deterministic regardless of the host's /etc/mime.types or Windows registry.
_MIME_EXT_OVERRIDES = {
    'image/svg+xml': '.svg',
    'audio/wav': '.wav',
    'audio/x-wav': '.wav',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
}


def _ext_from_mime(mime: str | None) -> str:
    """Best-effort file extension for a MIME type; '' when unknown.

    Order: explicit overrides, then ``mimetypes.guess_extension``, then the
    subtype with any structured-syntax suffix stripped (``image/svg+xml`` ->
    ``.svg``, not the naive ``.svg+xml``). Vendor-tree subtypes (``vnd.*``)
    with no override are treated as unknown rather than turned into junk
    extensions like ``.document``.
    """
    if not mime:
        return ''
    main = mime.split(';')[0].strip().lower()
    if main in _MIME_EXT_OVERRIDES:
        return _MIME_EXT_OVERRIDES[main]
    ext = mimetypes.guess_extension(main) or ''
    if ext:
        return ext
    subtype = main.split('/')[-1].split('+')[0] if '/' in main else ''
    if not subtype or subtype.startswith('vnd.'):
        return ''
    return f'.{subtype}'


# Thread idents already registered with a loaded debugger (see
# ``_register_debugger_thread``). Failed registrations are recorded too, so a
# broken debugger produces one warning instead of one per rendered object.
_DEBUGGER_THREADS: set[int] = set()


def _register_debugger_thread() -> None:
    """Register an engine-spawned thread with pydevd before traced code runs.

    The designer launches dev-mode tasks under debugpy, and ``renderObject``
    executes on the engine's C++ ThreadedQueue thread — a thread pydevd never
    saw get created. When line instrumentation fires on such an unregistered
    foreign thread, pydevd livelocks on its internal lock and the render
    wedges mid-object (objects stuck PROCESSING in the designer trace).
    Registering through the official ``settrace`` API happens outside the
    instrumentation callback, making the thread known to the debugger first.

    No-op when no debugger is loaded (task mode) — ``pydevd`` is only in
    ``sys.modules`` when debugpy/pydevd attached to this process.
    """
    pydevd = sys.modules.get('pydevd')
    if pydevd is None:
        return
    ident = threading.get_ident()
    if ident in _DEBUGGER_THREADS:
        return
    _DEBUGGER_THREADS.add(ident)
    try:
        pydevd.settrace(suspend=False)
    except Exception as e:
        warning(f'tool_filesystem: pydevd thread registration failed (continuing untraced): {e}')


_STREAM_LOOP: asyncio.AbstractEventLoop | None = None
_STREAM_LOOP_LOCK = threading.Lock()


def _run_on_stream_loop(coro):
    """Run a store-handle coroutine on one persistent event loop.

    aiofiles handles bind to the loop that opened them, so ``open_write``,
    every ``write_chunk``, and ``close_write`` of a media stream must all run
    on the same still-running loop. ``_run_async`` spins up a fresh loop per
    call (fine for one-shot ops), which left the handle bound to a closed
    loop and aborted streams with 'Event loop is closed' after the first
    chunk. All handle-based ops therefore go through this dedicated
    long-lived loop thread instead.
    """
    global _STREAM_LOOP
    with _STREAM_LOOP_LOCK:
        if _STREAM_LOOP is None or _STREAM_LOOP.is_closed():
            loop = asyncio.new_event_loop()
            threading.Thread(target=loop.run_forever, name='tool_filesystem-stream-io', daemon=True).start()
            _STREAM_LOOP = loop
    return asyncio.run_coroutine_threadsafe(coro, _STREAM_LOOP).result()


def _run_async(coro):
    """Run an async coroutine from a synchronous node method.

    Only safe to call from a thread with no running event loop. Two callers are
    supported, both synchronous:

      * the engine's tool dispatcher (``filters.py::_dispatch_tool``), which
        calls ``@tool_function`` methods synchronously; and
      * the pipeline-sink lane handlers (``writeDocuments``/``writeText``/
        ``writeTable``/``writeImage``/``writeAudio``/``writeVideo``), which the
        engine likewise invokes synchronously.

    If invoked from a thread that already has a running loop, ``asyncio.run``
    would raise a generic ``RuntimeError``; we pre-check so the failure surfaces
    with a tool_filesystem-specific message that points at that contract.
    """
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        pass
    else:
        raise RuntimeError(
            '_run_async must not be called from a thread with a running event loop; the tool_filesystem @tool_function methods and sink lane handlers are designed to be dispatched synchronously by the engine.'
        )

    return asyncio.run(coro)
