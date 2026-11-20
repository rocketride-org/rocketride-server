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
The server side of a node's ``self.state`` and ``self.files`` (plan 5.7).

The engine subprocess asks over its data channel (``state.*`` and ``fs_*``
channel commands) carrying ONLY the binding (the bare ``traceId``) and the
node's own key or path. Identity is decided HERE: the engine the request came
from is the connection's, never the request's, and ``TaskEngine.binding_control``
names the control that owns the binding from the server's own records. That
control's org, owner and address prefix every state key; its owner tree roots
every file path. A node that lies about its caller can mislabel its own logs
and nothing else.

- ``state.get`` / ``state.put`` / ``state.delete`` / ``state.incr``: JSON values
  in the server's ``StateStore``; a ``ttl`` the node does not name follows the
  control's idle policy.
- ``state.lock`` / ``state.unlock``: a lease per key that never blocks here
  (the node's client retries), so a waiting node never holds a channel slot
  the holder needs.
- ``fs_open`` / ``fs_read`` / ``fs_write`` / ``fs_close`` and the whole-path
  operations, with the same arguments ``rrext_store`` takes from a client.
  Handles belong to (engine, owner) and close with the engine.
"""

import json
import secrets
from typing import TYPE_CHECKING, Any, Dict, Optional, Set

from ai.account.file_store import SYSTEM_TREES, normalize_path
from ai.account.state_store import StateError, encode_value, state_key, state_store
from ai.account.store import StorageError, Store
from ai.constants import CONST_CHANNEL_CHUNK, CONST_STATE_MAX_LEASE_SECONDS, CONST_STATE_MAX_TTL_SECONDS

from .task_channel import ChannelRefused, ChannelReply, register_channel_command

if TYPE_CHECKING:
    from ai.account.file_store import FileStore

    from .task_control import TaskControl
    from .task_engine import TaskEngine

# ==== Constants ==================================================================

#: Seconds a lock lease lasts when the node names none.
CONST_DEFAULT_LEASE_SECONDS = 30.0

#: The errors a store raises that a node may read: its own path or value was refused.
_NODE_ERRORS = (StorageError, StateError, PermissionError, FileNotFoundError, ValueError)

# The handle owners (conn ids) each engine launch opened through self.files,
# so its handles close with it (release_engine)
_engine_conns: Dict[int, Set[str]] = {}


# ==== The binding ================================================================


def _control(task: 'TaskEngine', arguments: Dict[str, Any], command: str) -> 'TaskControl':
    """
    The control that owns the request's binding.

    Args:
        task: The engine the request came from (the connection's).
        arguments: The request; only ``traceId`` is read for identity.
        command: The command, named in a refusal.

    Returns:
        The owning control.

    Raises:
        ChannelRefused: The binding has no owner the server can name.
    """
    control = task.binding_control(arguments.get('traceId'))
    if control is None:
        raise ChannelRefused(
            f'{command}: this binding belongs to no control the server can name; '
            'self.state and self.files work inside a call through a control'
        )
    return control


def _ttl(control: 'TaskControl', arguments: Dict[str, Any], command: str) -> Optional[float]:
    """The expiry of a write: the node's ``ttl``, else the control's idle policy (None = never)."""
    ttl = arguments.get('ttl')
    if ttl is None:
        return float(control.ttl) if control.ttl else None
    if isinstance(ttl, bool) or not isinstance(ttl, (int, float)) or not 0 < ttl <= CONST_STATE_MAX_TTL_SECONDS:
        raise ChannelRefused(f'{command}: ttl is a number of seconds in (0, {CONST_STATE_MAX_TTL_SECONDS}]')
    return float(ttl)


def _key(control: 'TaskControl', arguments: Dict[str, Any], command: str) -> str:
    """The physical key of the node's key, owned by the control's (org, owner, address)."""
    try:
        return state_key(control.orgId, control.owner_id, control.address, arguments.get('key'))
    except StateError as e:
        raise ChannelRefused(f'{command}: {e}') from None


# ==== state.* ====================================================================


async def _state_get(task: 'TaskEngine', arguments: Dict[str, Any], data: Optional[bytes]) -> ChannelReply:
    """Return the value under the node's key: ``{found, value}``."""
    control = _control(task, arguments, 'state.get')
    text = await state_store().get(_key(control, arguments, 'state.get'))
    if text is None:
        return ChannelReply(body={'found': False})
    return ChannelReply(body={'found': True, 'value': json.loads(text)})


async def _state_put(task: 'TaskEngine', arguments: Dict[str, Any], data: Optional[bytes]) -> ChannelReply:
    """Store a JSON value under the node's key."""
    control = _control(task, arguments, 'state.put')
    key = _key(control, arguments, 'state.put')
    ttl = _ttl(control, arguments, 'state.put')
    try:
        await state_store().put(key, encode_value(arguments.get('value')), ttl)
    except StateError as e:
        raise ChannelRefused(f'state.put: {e}') from None
    return ChannelReply(body={})


async def _state_delete(task: 'TaskEngine', arguments: Dict[str, Any], data: Optional[bytes]) -> ChannelReply:
    """Remove the node's key: ``{deleted}``."""
    control = _control(task, arguments, 'state.delete')
    deleted = await state_store().delete(_key(control, arguments, 'state.delete'))
    return ChannelReply(body={'deleted': deleted})


async def _state_incr(task: 'TaskEngine', arguments: Dict[str, Any], data: Optional[bytes]) -> ChannelReply:
    """Add to the integer under the node's key: ``{value}``."""
    control = _control(task, arguments, 'state.incr')
    key = _key(control, arguments, 'state.incr')
    ttl = _ttl(control, arguments, 'state.incr')
    amount = arguments.get('amount', 1)
    if isinstance(amount, bool) or not isinstance(amount, int):
        raise ChannelRefused('state.incr: amount is an integer')
    try:
        value = await state_store().incr(key, amount, ttl)
    except StateError as e:
        raise ChannelRefused(str(e)) from None
    return ChannelReply(body={'value': value})


async def _state_lock(task: 'TaskEngine', arguments: Dict[str, Any], data: Optional[bytes]) -> ChannelReply:
    """Try to take the lease on the node's key, never waiting: ``{acquired, token}``."""
    control = _control(task, arguments, 'state.lock')
    key = _key(control, arguments, 'state.lock')
    lease = arguments.get('lease', CONST_DEFAULT_LEASE_SECONDS)
    if isinstance(lease, bool) or not isinstance(lease, (int, float)) or lease <= 0:
        raise ChannelRefused('state.lock: lease is a positive number of seconds')
    token = secrets.token_hex(16)
    acquired = await state_store().try_lock(key, token, min(float(lease), CONST_STATE_MAX_LEASE_SECONDS))
    return ChannelReply(body={'acquired': acquired, 'token': token if acquired else None})


async def _state_unlock(task: 'TaskEngine', arguments: Dict[str, Any], data: Optional[bytes]) -> ChannelReply:
    """Release the lease the token holds: ``{released}``."""
    control = _control(task, arguments, 'state.unlock')
    released = await state_store().unlock(_key(control, arguments, 'state.unlock'), str(arguments.get('token') or ''))
    return ChannelReply(body={'released': released})


# ==== fs_* =======================================================================


def _files(task: 'TaskEngine', arguments: Dict[str, Any], command: str) -> 'FileStore':
    """
    The file store of the binding's owner, its handles owned by (engine, owner).

    Args:
        task: The engine the request came from.
        arguments: The request.
        command: The command, named in a refusal.

    Returns:
        A FileStore rooted at the owning control's owner tree.

    Raises:
        ChannelRefused: No owner, or an owner with no tree to anchor in.
    """
    control = _control(task, arguments, command)
    conn_id = f'engine:{task.engine_id}:{control.owner_id}'
    try:
        store = Store.file_store_for_caller(
            owner_kind=control.owner_type,
            user_id=control.userId,
            team_id=control.teamId,
            project_id=control.project_id or '',
            conn_id=conn_id,
        )
    except ValueError as e:
        raise ChannelRefused(f'{command}: {e}') from None
    _engine_conns.setdefault(task.engine_id, set()).add(conn_id)
    return store


def _text(arguments: Dict[str, Any], name: str, command: str) -> str:
    """A required non-empty string argument."""
    value = arguments.get(name)
    if not isinstance(value, str) or not value:
        raise ChannelRefused(f'{command}: "{name}" is a non-empty string')
    return value


async def _fs_open(task: 'TaskEngine', arguments: Dict[str, Any], data: Optional[bytes]) -> ChannelReply:
    """Open a file for reading (``{handle, size}``) or writing (``{handle}``)."""
    store = _files(task, arguments, 'fs_open')
    path = _text(arguments, 'path', 'fs_open')
    try:
        if arguments.get('mode', 'r') == 'w':
            return ChannelReply(body={'handle': await store.open_write(path)})
        return ChannelReply(body=await store.open_read(path))
    except _NODE_ERRORS as e:
        raise ChannelRefused(f'fs_open: {e}') from None


async def _fs_read(task: 'TaskEngine', arguments: Dict[str, Any], data: Optional[bytes]) -> ChannelReply:
    """Read at most one channel chunk from a read handle; the bytes ride the reply's data."""
    store = _files(task, arguments, 'fs_read')
    offset, length = arguments.get('offset', 0), arguments.get('length', CONST_CHANNEL_CHUNK)
    if isinstance(offset, bool) or not isinstance(offset, int) or offset < 0:
        offset = 0
    if isinstance(length, bool) or not isinstance(length, int) or length <= 0:
        length = CONST_CHANNEL_CHUNK
    try:
        chunk = await store.read_chunk(str(arguments.get('handle') or ''), offset, min(length, CONST_CHANNEL_CHUNK))
    except _NODE_ERRORS as e:
        raise ChannelRefused(f'fs_read: {e}') from None
    return ChannelReply(body={'size': len(chunk)}, data=chunk)


async def _fs_write(task: 'TaskEngine', arguments: Dict[str, Any], data: Optional[bytes]) -> ChannelReply:
    """Append the request's data to a write handle: ``{bytesWritten}``."""
    store = _files(task, arguments, 'fs_write')
    try:
        written = await store.write_chunk(str(arguments.get('handle') or ''), bytes(data or b''))
    except _NODE_ERRORS as e:
        raise ChannelRefused(f'fs_write: {e}') from None
    return ChannelReply(body={'bytesWritten': written})


async def _fs_close(task: 'TaskEngine', arguments: Dict[str, Any], data: Optional[bytes]) -> ChannelReply:
    """Close a handle; a write handle commits."""
    store = _files(task, arguments, 'fs_close')
    handle = str(arguments.get('handle') or '')
    try:
        if arguments.get('mode', 'r') == 'w':
            await store.close_write(handle)
        else:
            await store.close_read(handle)
    except _NODE_ERRORS as e:
        raise ChannelRefused(f'fs_close: {e}') from None
    return ChannelReply(body={})


async def _fs_delete(task: 'TaskEngine', arguments: Dict[str, Any], data: Optional[bytes]) -> ChannelReply:
    """Delete a file."""
    store = _files(task, arguments, 'fs_delete')
    try:
        await store.delete(_text(arguments, 'path', 'fs_delete'))
    except _NODE_ERRORS as e:
        raise ChannelRefused(f'fs_delete: {e}') from None
    return ChannelReply(body={})


async def _fs_list_dir(task: 'TaskEngine', arguments: Dict[str, Any], data: Optional[bytes]) -> ChannelReply:
    """
    List a folder: ``{entries, count}``.

    As ``rrext_store`` does for a client, the system trees and the reserved
    (``@``/``=``) names are hidden at the root of the tree.
    """
    store = _files(task, arguments, 'fs_list_dir')
    try:
        path = normalize_path(arguments.get('path') or '')
        result = await store.list_dir(path)
    except _NODE_ERRORS as e:
        raise ChannelRefused(f'fs_list_dir: {e}') from None
    if not path:
        entries = [
            e
            for e in result.get('entries', [])
            if e['name'] not in SYSTEM_TREES and not e['name'].startswith(('@', '='))
        ]
        result = {'entries': entries, 'count': len(entries)}
    return ChannelReply(body=result)


async def _fs_mkdir(task: 'TaskEngine', arguments: Dict[str, Any], data: Optional[bytes]) -> ChannelReply:
    """Create a folder."""
    store = _files(task, arguments, 'fs_mkdir')
    try:
        await store.mkdir(_text(arguments, 'path', 'fs_mkdir'))
    except _NODE_ERRORS as e:
        raise ChannelRefused(f'fs_mkdir: {e}') from None
    return ChannelReply(body={})


async def _fs_stat(task: 'TaskEngine', arguments: Dict[str, Any], data: Optional[bytes]) -> ChannelReply:
    """Describe a path: ``{exists, type, size, ...}``."""
    store = _files(task, arguments, 'fs_stat')
    try:
        return ChannelReply(body=await store.stat(str(arguments.get('path') or '')))
    except _NODE_ERRORS as e:
        raise ChannelRefused(f'fs_stat: {e}') from None


async def _fs_rename(task: 'TaskEngine', arguments: Dict[str, Any], data: Optional[bytes]) -> ChannelReply:
    """Move a file or folder; ``overwrite`` replaces an existing target."""
    store = _files(task, arguments, 'fs_rename')
    old_path, new_path = _text(arguments, 'old_path', 'fs_rename'), _text(arguments, 'new_path', 'fs_rename')
    try:
        await store.rename(old_path, new_path, overwrite=arguments.get('overwrite') is True)
    except _NODE_ERRORS as e:
        raise ChannelRefused(f'fs_rename: {e}') from None
    return ChannelReply(body={})


async def _fs_geturl(task: 'TaskEngine', arguments: Dict[str, Any], data: Optional[bytes]) -> ChannelReply:
    """A link that fetches the file without a session: ``{url}``."""
    store = _files(task, arguments, 'fs_geturl')
    expires_in = arguments.get('expires_in')
    if isinstance(expires_in, bool) or not isinstance(expires_in, int):
        raise ChannelRefused('fs_geturl: expires_in is a whole number of seconds')
    name = arguments.get('download_name')
    try:
        url = await store.get_url(
            _text(arguments, 'path', 'fs_geturl'), expires_in, name if isinstance(name, str) and name else None
        )
    except _NODE_ERRORS as e:
        raise ChannelRefused(f'fs_geturl: {e}') from None
    return ChannelReply(body={'url': url})


async def _fs_put_json(task: 'TaskEngine', arguments: Dict[str, Any], data: Optional[bytes]) -> ChannelReply:
    """Write a JSON document in one operation: ``{bytesWritten}``."""
    store = _files(task, arguments, 'fs_put_json')
    if 'value' not in arguments:
        raise ChannelRefused('fs_put_json: requires a "value"')
    try:
        written = await store.put_json(_text(arguments, 'path', 'fs_put_json'), arguments['value'])
    except _NODE_ERRORS as e:
        raise ChannelRefused(f'fs_put_json: {e}') from None
    return ChannelReply(body={'bytesWritten': written})


async def _fs_get_json(task: 'TaskEngine', arguments: Dict[str, Any], data: Optional[bytes]) -> ChannelReply:
    """Read a JSON document in one operation: ``{value}``."""
    store = _files(task, arguments, 'fs_get_json')
    try:
        value = await store.get_json(_text(arguments, 'path', 'fs_get_json'))
    except _NODE_ERRORS as e:
        raise ChannelRefused(f'fs_get_json: {e}') from None
    return ChannelReply(body={'value': value})


# ==== The engine's end ===========================================================


async def release_engine(task: 'TaskEngine') -> None:
    """
    Close every file handle a launch's nodes left open through ``self.files``.

    Called once from the engine's teardown: a write handle commits what was
    written and its path lock goes, so a node that died mid-write blocks
    nobody.

    Args:
        task: The engine that ended.
    """
    for conn_id in _engine_conns.pop(task.engine_id, set()):
        await Store.instance().close_all_handles(conn_id)


# ==== Registration ===============================================================

for _name, _handler in (
    ('state.get', _state_get),
    ('state.put', _state_put),
    ('state.delete', _state_delete),
    ('state.incr', _state_incr),
    ('state.lock', _state_lock),
    ('state.unlock', _state_unlock),
    ('fs_open', _fs_open),
    ('fs_read', _fs_read),
    ('fs_write', _fs_write),
    ('fs_close', _fs_close),
    ('fs_delete', _fs_delete),
    ('fs_list_dir', _fs_list_dir),
    ('fs_mkdir', _fs_mkdir),
    ('fs_stat', _fs_stat),
    ('fs_rename', _fs_rename),
    ('fs_geturl', _fs_geturl),
    ('fs_put_json', _fs_put_json),
    ('fs_get_json', _fs_get_json),
):
    register_channel_command(_name, _handler)
