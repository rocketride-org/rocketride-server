# =============================================================================
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
Instance handler for the doors probe: one call, one script, one report.

The call's text is a JSON script, ``{"ops": [{"op": "<name>", ...}, ...]}``.
Each operation drives one door the way a node would (``self.settings``,
``self.caller``, ``self.state``, ``self.files``, ``self.logger()``) or tries
to step outside it (a forged binding, a door kept past its call, a write to
a read-only view). The node runs them in order and forwards one JSON report:
``{"results": [{"op", "ok", "value" | "error"}, ...]}``, where ``error`` is
the exception's type and message. The node decides nothing about what
SHOULD be refused: the test owns the expectations, the probe only reports
what happened.
"""

import base64
import json
import os
import re
from collections.abc import Mapping
from typing import Any, Callable, Dict, List, Optional

from rocketlib import ConfigError, IInstanceBase, NodeFiles, NodeState, getObject

from .IGlobal import IGlobal

# ==== Constants ==================================================================

#: An operation name: dotted words (``state.get``, ``otherNode.state.put``).
#: Each names the method ``_op_<name with '.' as '_'>``; nothing else is reachable.
_OP_NAME = re.compile(r'[A-Za-z]+(\.[A-Za-z]+)*')

# ==== Helpers ====================================================================


def _plain(value: Any) -> Any:
    """
    A JSON-ready copy of a value read through a door.

    The caller's mappings are read-only views and its arrays tuples; the
    report carries plain dicts and lists.

    Args:
        value: Anything a door returned.

    Returns:
        The same value with every mapping a dict and every tuple a list.
    """
    # Step 1: a read-only mapping (MappingProxyType, a ConfigView) becomes a dict
    if isinstance(value, Mapping):
        return {str(name): _plain(member) for name, member in value.items()}
    # Step 2: a tuple (a frozen array, a NamedTuple) becomes a list
    if isinstance(value, (list, tuple)):
        return [_plain(member) for member in value]
    # Step 3: bytes are reported as base64 so the report stays JSON
    if isinstance(value, (bytes, bytearray)):
        return {'base64': base64.b64encode(bytes(value)).decode('ascii')}
    return value


def _refusal(error: BaseException) -> str:
    """The report's spelling of an exception: its type, then its message."""
    return f'{type(error).__name__}: {error}'


def _attempt(action: Callable[[], Any]) -> Dict[str, Any]:
    """
    Run one write that a read-only door must refuse, and record what happened.

    Args:
        action: The write.

    Returns:
        ``{"refused": True, "error": ...}`` when it raised, else ``{"refused": False}``.
    """
    try:
        action()
    except Exception as e:  # noqa: BLE001 - every refusal is reported, whatever its type
        return {'refused': True, 'error': _refusal(e)}
    return {'refused': False}


# ==== The instance ===============================================================


class IInstance(IInstanceBase):
    """
    Runs a call's script against the node's doors and forwards the report on the text lane.
    """

    IGlobal: IGlobal

    def writeText(self, text: str):
        """
        Run the script in ``text`` and forward the report.

        Args:
            text: ``{"ops": [...]}`` as JSON.
        """
        # Step 1: the script; one that does not parse is reported, not raised,
        # so the test reads the reason instead of a failed pipe
        try:
            script = json.loads(text)
            ops = script.get('ops') if isinstance(script, dict) else None
            if not isinstance(ops, list):
                raise ValueError('the script is {"ops": [...]}')
        except ValueError as e:
            self.instance.writeText(json.dumps({'results': [{'op': '', 'ok': False, 'error': _refusal(e)}]}))
            return self.preventDefault()

        # Step 2: every operation in order, each one's outcome recorded
        results: List[Dict[str, Any]] = [self._run(op) for op in ops]

        # Step 3: the report replaces the script on the lane; preventDefault()
        # raises, so it goes after the forward it guards
        self.instance.writeText(json.dumps({'results': results}, default=repr))
        return self.preventDefault()

    def _run(self, op: Any) -> Dict[str, Any]:
        """
        Run one operation.

        Args:
            op: ``{"op": "<name>", ...arguments}``.

        Returns:
            ``{"op", "ok": True, "value"}`` or ``{"op", "ok": False, "error"}``.
        """
        # Step 1: the operation's handler, by name: "state.lockedAppend" is
        # _op_state_lockedAppend; a name outside that pattern names nothing
        name = op.get('op') if isinstance(op, dict) else None
        handler = None
        if isinstance(name, str) and _OP_NAME.fullmatch(name):
            handler = getattr(self, '_op_' + name.replace('.', '_'), None)
        if handler is None:
            return {'op': name, 'ok': False, 'error': f'KeyError: no operation named {name!r}'}

        # Step 2: its outcome; a door's refusal is a result, never a failed call
        try:
            return {'op': name, 'ok': True, 'value': _plain(handler(op))}
        except Exception as e:  # noqa: BLE001 - the refusal IS the result being probed
            return {'op': name, 'ok': False, 'error': _refusal(e)}

    # ---- What the node reads ---------------------------------------------------

    def _op_report(self, op: Dict[str, Any]) -> Dict[str, Any]:
        """
        Everything the node can read about its call: caller, identity, config, settings.

        Returns:
            The caller (every field), ``config.node``, what the IGlobal saw in
            beginGlobal, the settings and their schema paths, the param keys,
            what ``IGlobal.config`` answers for a parameter read from the
            instance, the keys the view says the environment set, and the
            binding's trace id.
        """
        settings = self.settings

        # Step 1: a parameter read through the control's view, from the instance
        try:
            config_param = {'refused': False, 'value': self.IGlobal.config.greeting}
        except ConfigError as e:
            config_param = {'refused': True, 'error': _refusal(e)}

        # Step 2: the whole record
        return {
            'caller': self.caller._asdict(),
            'node': settings.node._asdict(),
            'global': self.IGlobal.observed,
            'configLabel': self.IGlobal.config.label,
            'configParam': config_param,
            'envKeys': sorted(self.IGlobal.config.env_keys),
            'settings': {key: settings[key] for key in settings},
            'settingsPaths': {key: settings.path_of(key) for key in settings},
            'paramKeys': sorted(settings.param_keys),
            'traceId': self.traceId,
        }

    def _op_processEnv(self, op: Dict[str, Any]) -> List[str]:
        """
        The NAMES of the engine process's environment variables, never their values.

        A node runs user code in this process, so what the server leaves in its
        environment is what any node could read; the test checks the names.
        """
        return sorted(os.environ)

    # ---- Sub-pipes ----------------------------------------------------------------

    def _sub_call(self, ops: List[Dict[str, Any]], caller: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        """
        Run a script through a sub-pipe of this binding and return the nested report.

        Args:
            ops: The nested call's operations.
            caller: Fields to forge over this binding's caller on the sub-pipe
                before its instances are built (each one freezes what it
                finds); None keeps the caller ``getPipe`` set.

        Returns:
            The nested call's results, as the nested probe reported them.

        Raises:
            LookupError: The sub-pipe returned no report.
        """
        # The engine's default object, as tool_pipe opens its sub-pipeline: an
        # object URL must name a protocol the engine registered
        entry = getObject()

        # Step 1: a sub-pipe of THIS binding: same trace, same caller, unless forged
        pipe = self.getPipe()
        try:
            if caller is not None:
                envelope = dict(self.instance.caller or {})
                envelope.update(caller)
                pipe.caller = envelope

            # Step 2: one object through the whole chain; the response node
            # of the sub-pipe leaves the nested report on the entry
            pipe.open(entry)
            pipe.writeText(json.dumps({'ops': ops}))
            pipe.close()
            response = entry.response.toDict()
        finally:
            # Step 3: the sub-pipe's instances end and its caller is cleared
            self.putPipe(pipe)

        # Step 4: the nested probe's own report
        texts = response.get('text') or []
        if not texts:
            raise LookupError(f'the sub-pipe returned no report (response keys: {sorted(response)})')
        return json.loads(texts[0])['results']

    def _op_subpipe(self, op: Dict[str, Any]) -> List[Dict[str, Any]]:
        """Run ``ops`` in a sub-pipe of this binding, the caller optionally forged by ``caller``."""
        return self._sub_call(list(op.get('ops') or []), op.get('caller'))

    def _op_recurse(self, op: Dict[str, Any]) -> Dict[str, Any]:
        """
        Open a sub-pipe that opens a sub-pipe, ``depth`` times, until the engine refuses one.

        Returns:
            ``{"depth", "nested": <the nested call's results>}``, or
            ``{"bottom": True}`` at depth 0; a refused ``getPipe`` is the
            nested result's error at the level that hit it.
        """
        depth = int(op.get('depth') or 0)
        if depth <= 0:
            return {'bottom': True}
        return {'depth': depth, 'nested': self._sub_call([{'op': 'recurse', 'depth': depth - 1}])}

    # ---- self.state -------------------------------------------------------------

    def _op_state_get(self, op: Dict[str, Any]) -> Any:
        """``self.state.get(key, default)``."""
        return self.state.get(op['key'], op.get('default'))

    def _op_state_put(self, op: Dict[str, Any]) -> None:
        """``self.state.put(key, value, ttl)``."""
        self.state.put(op['key'], op.get('value'), op.get('ttl'))

    def _op_state_delete(self, op: Dict[str, Any]) -> bool:
        """``self.state.delete(key)``."""
        return self.state.delete(op['key'])

    def _op_state_incr(self, op: Dict[str, Any]) -> int:
        """``self.state.incr(key, amount, ttl)``."""
        return self.state.incr(op['key'], op.get('amount', 1), op.get('ttl'))

    def _op_state_lockedAppend(self, op: Dict[str, Any]) -> List[Any]:
        """
        A read-modify-write under ``self.state.lock``: append ``value`` to the list at ``key``.

        Returns:
            The list as written.
        """
        key = op['key']
        with self.state.lock(key):
            # Step 1: the current list (absent = empty), then the new one written back
            items = list(self.state.get(key) or [])
            items.append(op.get('value'))
            self.state.put(key, items)
        return items

    # ---- self.files -------------------------------------------------------------

    def _op_files_write(self, op: Dict[str, Any]) -> int:
        """``self.files.write(path, text)``; returns the bytes written."""
        data = op.get('text', '').encode('utf-8')
        self.files.write(op['path'], data)
        return len(data)

    def _op_files_read(self, op: Dict[str, Any]) -> str:
        """``self.files.read(path)`` decoded as UTF-8."""
        return self.files.read(op['path']).decode('utf-8')

    def _op_files_putJson(self, op: Dict[str, Any]) -> int:
        """``self.files.put_json(path, value)``."""
        return self.files.put_json(op['path'], op.get('value'))

    def _op_files_getJson(self, op: Dict[str, Any]) -> Any:
        """``self.files.get_json(path)``."""
        return self.files.get_json(op['path'])

    def _op_files_stream(self, op: Dict[str, Any]) -> int:
        """
        A streaming write: ``open_write``, one ``write_chunk`` per chunk, ``close_write``.

        Returns:
            The bytes written.
        """
        handle = self.files.open_write(op['path'])
        written = 0
        try:
            # Step 1: each chunk is its own request
            for chunk in op.get('chunks', []):
                written += self.files.write_chunk(handle, str(chunk).encode('utf-8'))
        finally:
            # Step 2: the close commits, even after a refused chunk
            self.files.close_write(handle)
        return written

    def _op_files_list(self, op: Dict[str, Any]) -> List[str]:
        """``self.files.list_dir(path)``: the entry names, sorted."""
        listing = self.files.list_dir(op.get('path', ''))
        return sorted(str(entry.get('name')) for entry in listing.get('entries', []))

    def _op_files_stat(self, op: Dict[str, Any]) -> Dict[str, Any]:
        """``self.files.stat(path)``."""
        return self.files.stat(op['path'])

    def _op_files_mkdir(self, op: Dict[str, Any]) -> None:
        """``self.files.mkdir(path)``."""
        self.files.mkdir(op['path'])

    def _op_files_rename(self, op: Dict[str, Any]) -> None:
        """``self.files.rename(old, new, overwrite)``."""
        self.files.rename(op['old'], op['new'], bool(op.get('overwrite')))

    def _op_files_delete(self, op: Dict[str, Any]) -> None:
        """``self.files.delete(path)``."""
        self.files.delete(op['path'])

    def _op_files_url(self, op: Dict[str, Any]) -> str:
        """``self.files.get_url(path, expires_in)``."""
        return self.files.get_url(op['path'], op.get('expiresIn'))

    # ---- self.logger() ----------------------------------------------------------

    def _op_sse(self, op: Dict[str, Any]) -> None:
        """Send one SSE event through the binding's captured logger."""
        self.logger().sendSSE(str(op.get('type') or 'probe'), **dict(op.get('data') or {}))

    # ---- Stepping outside -------------------------------------------------------

    def _op_stash(self, op: Dict[str, Any]) -> str:
        """
        Leave this call's doors on the control's IGlobal for a later call to try.

        Returns:
            The binding the stashed doors name.
        """
        self.IGlobal.stashed = (self.state, self.files)
        return self.caller.correlationId

    def _stashed(self) -> tuple:
        """The doors an earlier call stashed; raises when none did."""
        if self.IGlobal.stashed is None:
            raise LookupError('no earlier call of this control stashed its doors')
        return self.IGlobal.stashed

    def _op_stale_state_get(self, op: Dict[str, Any]) -> Any:
        """``get`` through an earlier call's state door."""
        return self._stashed()[0].get(op['key'])

    def _op_stale_state_put(self, op: Dict[str, Any]) -> None:
        """``put`` through an earlier call's state door."""
        self._stashed()[0].put(op['key'], op.get('value'))

    def _op_stale_files_read(self, op: Dict[str, Any]) -> str:
        """``read`` through an earlier call's files door."""
        return self._stashed()[1].read(op['path']).decode('utf-8')

    def _op_stale_files_write(self, op: Dict[str, Any]) -> None:
        """``write`` through an earlier call's files door."""
        self._stashed()[1].write(op['path'], op.get('text', '').encode('utf-8'))

    def _node_id(self, op: Dict[str, Any]) -> str:
        """The node id an operation names, else this node's own."""
        return str(op.get('nodeId') or self.settings.node.id)

    def _op_forge_state_get(self, op: Dict[str, Any]) -> Any:
        """A state door built by the node itself over a binding of its choosing: ``get``."""
        return NodeState(op['binding'], self._node_id(op)).get(op['key'])

    def _op_forge_state_put(self, op: Dict[str, Any]) -> None:
        """A state door built by the node itself over a binding of its choosing: ``put``."""
        NodeState(op['binding'], self._node_id(op)).put(op['key'], op.get('value'))

    def _op_forge_files_write(self, op: Dict[str, Any]) -> None:
        """A files door built by the node itself over a binding of its choosing: ``write``."""
        NodeFiles(op['binding']).write(op['path'], op.get('text', '').encode('utf-8'))

    def _op_forge_files_read(self, op: Dict[str, Any]) -> str:
        """A files door built by the node itself over a binding of its choosing: ``read``."""
        return NodeFiles(op['binding']).read(op['path']).decode('utf-8')

    def _op_otherNode_state_put(self, op: Dict[str, Any]) -> None:
        """This call's own binding, another node id: the one prefix part the engine side names."""
        NodeState(self.caller.correlationId, op['nodeId']).put(op['key'], op.get('value'))

    def _op_otherNode_state_get(self, op: Dict[str, Any]) -> Any:
        """This call's own binding, another node id: ``get``."""
        return NodeState(self.caller.correlationId, op['nodeId']).get(op['key'])

    def _op_otherNode_state_delete(self, op: Dict[str, Any]) -> bool:
        """This call's own binding, another node id: ``delete``."""
        return NodeState(self.caller.correlationId, op['nodeId']).delete(op['key'])

    def _op_mutate(self, op: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
        """
        Try every write a read-only door must refuse.

        Returns:
            Per attempt, whether it was refused and how.
        """
        caller, settings, config = self.caller, self.settings, self.IGlobal.config
        node_id = settings.node.id

        # Each attempt is one write into what the engine or the server owns
        attempts: Dict[str, Callable[[], Any]] = {
            'caller.userId': lambda: setattr(caller, 'userId', 'mallory'),
            'caller.orgId': lambda: setattr(caller, 'orgId', 'other-org'),
            'caller.params': lambda: caller.params.__setitem__(node_id, {'greeting': 'forged'}),
            'caller.env': lambda: caller.env.__setitem__('ROCKETRIDE_FORGED', 'x'),
            'caller.rebind': lambda: setattr(self, '_caller', {'userId': 'mallory', 'correlationId': 'forged'}),
            'node.id': lambda: setattr(settings.node, 'id', 'other_node'),
            'settings.attr': lambda: setattr(settings, 'greeting', 'forged'),
            'settings.item': lambda: settings.__setitem__('greeting', 'forged'),
            'settings.delete': lambda: settings.__delitem__('greeting'),
            'config.attr': lambda: setattr(config, 'label', 'forged'),
        }
        if node_id in caller.params:
            # A call that carried params: its node's own map is read-only too
            attempts['caller.params.node'] = lambda: caller.params[node_id].__setitem__('greeting', 'forged')
        outcome = {name: _attempt(action) for name, action in attempts.items()}

        # The caller as it stands after every attempt, so the test sees nothing moved
        outcome['callerAfter'] = {'refused': True, 'value': _plain(self.caller._asdict())}
        return outcome
