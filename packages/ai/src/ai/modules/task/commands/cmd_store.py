# MIT License
#
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

"""
StoreCommands: DAP command handler for user-scoped file storage.

Handles the ``rrext_store`` command and its ``fs_*`` subcommands
(open, read, write, close, delete, list_dir, mkdir, rmdir, stat, rename,
geturl).

Extracted from TaskCommands so that any pod needing file storage
(EAAS, Account) can include it via MRO without pulling in the full
task lifecycle.
"""

from typing import TYPE_CHECKING, Dict, Any
from ai.account.file_store import SYSTEM_TREES, normalize_path
from ai.common.dap import DAPConn, TransportBase

if TYPE_CHECKING:
    from ..task_server import TaskServer


# =============================================================================
# STORE COMMANDS MIXIN
# =============================================================================


class StoreCommands(DAPConn):
    """
    DAP command handler for user-scoped file storage operations.

    Provides ``on_rrext_store`` which dispatches to ``fs_*`` subcommands.
    Requires ``self._server.store`` for the Store instance and
    ``self._account_info.userId`` for user-scoped file access.
    """

    def __init__(
        self,
        connection_id: int,
        server: 'TaskServer',
        transport: TransportBase,
        **kwargs,
    ) -> None:
        """Initialise the subcommand handler lookup table."""
        # Map of store subcommand names to handler methods.
        self._store_subcommand_handlers = {
            'fs_open': self._store_fs_open,
            'fs_read': self._store_fs_read,
            'fs_write': self._store_fs_write,
            'fs_close': self._store_fs_close,
            'fs_delete': self._store_fs_delete,
            'fs_list_dir': self._store_fs_list_dir,
            'fs_mkdir': self._store_fs_mkdir,
            'fs_rmdir': self._store_fs_rmdir,
            'fs_stat': self._store_fs_stat,
            'fs_rename': self._store_fs_rename,
            'fs_geturl': self._store_fs_geturl,
        }

    # =========================================================================
    # DISPATCHER
    # =========================================================================

    async def on_rrext_store(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """
        Handle DAP 'rrext_store' command — unified file storage operations.

        Verifies permissions once and routes to the appropriate fs_* handler.

        Args:
            request: DAP request with arguments.subcommand and subcommand-specific args.

        Returns:
            DAP response (format depends on subcommand).
        """
        try:
            # NO permission check here: the STORE is the security boundary.
            # Every path resolution inside the identity-bound FileStore
            # enforces the policy-required permission for the addressed scope
            # (plain paths behave like the old defaultTeam task.store hoist;
            # @/Team/@/Org paths check the addressed team/org; reserved
            # subtrees like .logs apply their own rules).

            # Extract subcommand
            args = request.get('arguments', {})
            subcommand = args.get('subcommand')

            if not subcommand:
                raise ValueError('Subcommand is required')

            # Dispatch to appropriate handler
            if handler := self._store_subcommand_handlers.get(subcommand):
                return await handler(request, args)
            else:
                raise ValueError(f'Unknown subcommand: {subcommand}')

        except Exception as e:
            self.debug_message(f'Store operation failed: {str(e)}')
            raise

    # =========================================================================
    # FILE STORE ACCESS
    # =========================================================================

    def _get_file_store(self):
        """
        Get a FileStore bound to the authenticated session's identity.

        Returns:
            FileStore whose every path resolution authorizes against THIS
            session (plain paths under the user's namespace as before; the
            @/Team|@/Org grammar against the addressed scope's permissions).
        """
        from ai.account import Store

        return Store.file_store(self.request_context())

    # =========================================================================
    # FS SUBCOMMAND HANDLERS
    # =========================================================================

    async def _store_fs_open(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """
        Open a file handle for reading or writing.

        Args:
            request: Original DAP request.
            args:    Must contain ``path``.  Optional ``mode`` ('r' or 'w', default 'r').

        Returns:
            DAP response with handle ID (and metadata for read mode).
        """
        fs = self._get_file_store()
        path = args.get('path')
        mode = args.get('mode', 'r')

        if mode == 'w':
            # Create a write handle tied to this connection for cleanup on disconnect
            handle_id = await fs.open_write(path)
            return self.build_response(request, body={'handle': handle_id})
        else:
            # Open for reading; returns handle ID plus file metadata
            result = await fs.open_read(path)
            return self.build_response(request, body=result)

    async def _store_fs_read(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """
        Read data from an open read handle.

        Args:
            request: Original DAP request.
            args:    Must contain ``handle``.  Optional ``offset`` (default 0)
                     and ``length`` (default and max 4 MiB).

        Returns:
            DAP response with body.size and arguments.data.
        """
        fs = self._get_file_store()
        handle = args.get('handle')
        offset = args.get('offset', 0)
        length = args.get('length', 4_194_304)

        # Clamp to safe defaults
        if not isinstance(offset, int) or offset < 0:
            offset = 0
        if not isinstance(length, int) or length <= 0:
            length = 4_194_304
        length = min(length, 4_194_304)

        # Read the chunk
        data = await fs.read_chunk(handle, offset, length)

        # body carries byte count; arguments carries raw data separately
        response = self.build_response(request, body={'size': len(data)})
        response['arguments'] = {'data': data}
        return response

    async def _store_fs_write(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """
        Write data to an open write handle.

        Args:
            request: Original DAP request.
            args:    Must contain ``handle``.  Optional ``data`` (bytes or str).

        Returns:
            DAP response with body.bytesWritten.
        """
        fs = self._get_file_store()
        handle = args.get('handle')
        data = args.get('data', b'')

        # Normalise string data to bytes
        if isinstance(data, str):
            data = data.encode('utf-8')

        written = await fs.write_chunk(handle, data)
        return self.build_response(request, body={'bytesWritten': written})

    async def _store_fs_close(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """
        Close a file handle.

        Args:
            request: Original DAP request.
            args:    Must contain ``handle``.  Optional ``mode`` ('r' or 'w', default 'r').

        Returns:
            Empty success DAP response.
        """
        fs = self._get_file_store()
        handle = args.get('handle')
        mode = args.get('mode', 'r')

        if mode == 'w':
            await fs.close_write(handle)
        else:
            await fs.close_read(handle)
        return self.build_response(request)

    async def _store_fs_delete(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """
        Delete a file.

        Args:
            request: Original DAP request.
            args:    Must contain ``path``.

        Returns:
            Empty success DAP response.
        """
        await self._get_file_store().delete(args.get('path'))
        return self.build_response(request)

    def _virtual_scope_mounts(self) -> list:
        """The '@' listing: the joined filesystem's scope mounts.

        `User/` and `Team/` always appear; `Org/` only for org.admin (or
        sys.admin) holders — org storage is admin-only, a dead entry would
        just confuse. Entry names compose by ordinary path joining
        ('@' + '/' + 'Team' -> '@/Team'). Entries are VIRTUAL — synthesized
        from the session, never from a physical listing (which would leak
        other orgs' scopes).
        """
        org = getattr(self._account_info, 'organization', None) or {}
        sys_perms = getattr(self._account_info, 'sysPermissions', None) or []
        entries = [
            {'name': 'User', 'type': 'dir', 'virtual': True},
            {'name': 'Team', 'type': 'dir', 'virtual': True},
        ]
        if 'org.admin' in (org.get('permissions') or []) or 'sys.admin' in sys_perms:
            entries.append({'name': 'Org', 'type': 'dir', 'virtual': True})
        return entries

    def _list_scope_mount(self, mount: str) -> Dict[str, Any]:
        """Directory listing for the virtual mounts ('@' and '@/Team').

        '@' lists the scope mounts themselves; '@/Team' lists the caller's
        teams by DISPLAY NAME with the id in the entry body, so the file
        browser can show names while scripts address ids. ('@/User' and
        '@/Org' are REAL trees — the store lists them.)
        """
        if mount == '@':
            entries = self._virtual_scope_mounts()
            return {'entries': entries, 'count': len(entries)}
        org = getattr(self._account_info, 'organization', None) or {}
        entries = [
            {'name': row.get('name') or row['id'], 'type': 'dir', 'id': row['id'], 'virtual': True}
            for row in (org.get('teams') or [])
            if row.get('id')
        ]
        return {'entries': entries, 'count': len(entries)}

    @staticmethod
    def _is_scope_root(path: str) -> bool:
        """True when ``path`` lists the TOP of a user/team/org tree.

        Scope roots are where the system trees live and where reserved
        names get filtered: '' and '@/User' (own root), '@/Org' (own org
        root), '@/Team/<ref>' (a team root), and the cross-boundary
        '@/User/=<uid>' / '@/Org/=<oid>' spellings.
        """
        if not path:
            return True
        segments = path.split('/')
        if segments[0] != '@' or len(segments) < 2:
            return False
        if segments[1] in ('User', 'Org'):
            return len(segments) == 2 or (len(segments) == 3 and segments[2].startswith('='))
        return segments[1] == 'Team' and len(segments) == 3

    async def _store_fs_list_dir(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """
        List directory contents of the joined filesystem.

        Plain paths list the caller's own tree (simple mode). '@' lists the
        scope mounts and '@/Team' the caller's memberships — both virtual.
        Everything else ('@/User/...', '@/Team/<ref>/...', '@/Org/...') is
        a real store listing. Scope-root listings hide the system trees
        from non-sys.admin callers and drop reserved '@'/'='-prefixed
        physical names (unaddressable legacy artifacts).

        Args:
            request: Original DAP request.
            args:    Optional ``path`` (defaults to root).

        Returns:
            DAP response with directory listing.
        """
        # ONE normalization (the store's own) drives BOTH the scope-root
        # filter decision and the store resolution below — deciding on a raw
        # spelling while resolving the normalized one would let '@//User'-
        # style paths reach the user root with the system trees unfiltered.
        path = normalize_path(args.get('path', '') or '')

        # The virtual mounts list from the session, not storage.
        if path in ('@', '@/Team'):
            return self.build_response(request, body=self._list_scope_mount(path))

        result = await self._get_file_store().list_dir(path)

        if self._is_scope_root(path):
            entries = result['entries']
            # SYSTEM TREES (.logs, .deployments) are invisible at scope
            # roots for everyone except sys.admin: they are engine-written,
            # served by their own domain APIs, and may hold data the user
            # must not see raw.
            sys_perms = getattr(self._account_info, 'sysPermissions', None) or []
            if 'sys.admin' not in sys_perms:
                entries = [e for e in entries if e['name'] not in SYSTEM_TREES]
            # Reserved sigils: physical '@*' / '=*' names at a scope root
            # predate the grammar, cannot be created or addressed anymore —
            # drop them rather than show dead entries.
            entries = [e for e in entries if not e['name'].startswith(('@', '='))]
            result = {'entries': entries, 'count': len(entries)}

        return self.build_response(request, body=result)

    async def _store_fs_mkdir(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """
        Create a directory.

        Args:
            request: Original DAP request.
            args:    Must contain ``path``.

        Returns:
            Empty success DAP response.
        """
        await self._get_file_store().mkdir(args.get('path'))
        return self.build_response(request)

    async def _store_fs_rmdir(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """
        Remove a directory.

        Args:
            request: Original DAP request.
            args:    Must contain ``path`` (non-empty string).  Optional ``recursive``
                     (strict bool).

        Returns:
            Empty success DAP response, or error if validation fails.
        """
        path = args.get('path')
        if not isinstance(path, str) or not path:
            return self.build_error(request, 'rmdir requires a non-empty "path" string')

        recursive = args.get('recursive', False)
        if not isinstance(recursive, bool):
            return self.build_error(request, 'rmdir "recursive" must be a boolean')

        await self._get_file_store().rmdir(path, recursive=recursive)
        return self.build_response(request)

    async def _store_fs_stat(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """
        Get file/directory metadata.

        Args:
            request: Original DAP request.
            args:    Must contain ``path``.

        Returns:
            DAP response with metadata (size, modified time, type, etc.).
        """
        # The scope mounts stat as directories: '@' and '@/Team' have no
        # physical existence at all, and '@/User'/'@/Org' roots always
        # exist conceptually (access control applies on ENTRY, not on the
        # mount). Same rule as _store_fs_list_dir: ONE normalization (the
        # store's own) drives BOTH the mount decision and the store
        # resolution below — and it rejects traversal outright instead of
        # letting a raw spelling slide through to the resolver.
        path = normalize_path(args.get('path') or '')
        if path in ('@', '@/User', '@/Team', '@/Org'):
            return self.build_response(request, body={'exists': True, 'type': 'dir', 'virtual': True})

        result = await self._get_file_store().stat(path)
        return self.build_response(request, body=result)

    async def _store_fs_rename(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """
        Rename a file or directory.

        Args:
            request: Original DAP request.
            args:    Must contain ``old_path`` and ``new_path`` (non-empty strings).

        Returns:
            Empty success DAP response, or error if validation fails.
        """
        old_path = args.get('old_path')
        new_path = args.get('new_path')
        if not isinstance(old_path, str) or not old_path:
            return self.build_error(request, 'rename requires a non-empty "old_path" string')
        if not isinstance(new_path, str) or not new_path:
            return self.build_error(request, 'rename requires a non-empty "new_path" string')

        await self._get_file_store().rename(old_path, new_path)
        return self.build_response(request)

    async def _store_fs_geturl(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """
        Get a direct HTTP URL for accessing a file in the store.

        For cloud backends (S3, Azure), returns a presigned/SAS URL.
        For filesystem backends, returns a JWT-signed ``/task/fetch`` URL
        that the server's HTTP endpoint validates and serves.

        Args:
            request: Original DAP request.
            args:    Must contain ``path`` (relative store path). Optional
                     ``expires_in`` (seconds, default 3600) and ``download_name``
                     (forces a browser download with this filename via
                     ``Content-Disposition: attachment``).

        Returns:
            DAP response with ``url`` in the body, or error if validation fails.
        """
        path = args.get('path')
        if not isinstance(path, str) or not path:
            return self.build_error(request, 'geturl requires a non-empty "path" string')

        expires_in = int(args.get('expires_in', 3600))
        # Optional download filename — when present the fetch URL forces a
        # browser download via Content-Disposition: attachment.
        download_name = args.get('download_name') or None
        url = await self._get_file_store().get_url(path, expires_in, download_name=download_name)
        return self.build_response(request, body={'url': url})
