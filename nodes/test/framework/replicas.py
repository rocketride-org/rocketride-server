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
The two-replica harness (plan 4.3): one node, two replicas, one shared state and file backend.

The balancer sends one control's calls to different replicas and the idle
sweep forgets a control's globals, so a node is correct only when any replica
gives the answer the first would have given: whatever must survive a call
lives behind ``self.state`` / ``self.files``, never on the IGlobal or at module
scope (plan 4.1 rules 1 and 3). Two real engine processes would also need a
shared state backend, and the OSS server keeps its state in-process, so the
harness builds the closest thing in one process:

- each ``Replica`` imports the node package afresh under its own module name
  (its own module state, as a second process would have), builds its own
  IGlobal per control, and constructs a fresh IInstance per call with the
  caller bound once, as the engine does;
- both replicas reach ONE ``ReplicaServer``: the real server-side handlers of
  the node doors (``ai.modules.task.node_doors``) over one ``StateStore`` and
  the file store, dispatched through the real channel handler. A request
  carries only its binding's ``traceId``; the server names the owning control
  from the claims it recorded, exactly as EaaS does from its trace owners.

``run`` plays a list of ``Call``s on the given replicas in turn; a test plays
the same list alternately on two replicas and on one reference replica of a
fresh server, and asserts the answers are identical (the balancer test) and
that no owner's answers move when another owner's calls are interleaved (the
leak test).
"""

from __future__ import annotations

import asyncio
import contextvars
import importlib.util
import itertools
import sys
import types
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

import rocketlib
from rocketlib import APERR, Ec, IGlobalBase

from ai.account.state_store import MemoryStateStore, install_state_store
from ai.constants import CONST_CHANNEL_CHUNK
from ai.modules.task import node_doors  # noqa: F401  (registers the state.* and fs_* channel commands)
from ai.modules.task.task_channel import CONST_CHANNEL_READ, ChannelStreams, handle

# ==== Constants ==================================================================

#: The catalog's node packages.
NODES_DIR = Path(__file__).resolve().parents[2] / 'src' / 'nodes'

# ==== Who calls ==================================================================


@dataclass(frozen=True)
class Owner:
    """
    A control as the server's record carries it: everything the node doors read.

    Attributes:
        orgId: The control's organization.
        userId: The control's user.
        teamId: The control's team.
        address: The pipe address (``developerId.pipelineId.source``).
        rung: The rung that answered.
        owner_kind: ``'user'`` or ``'team'``.
        project_id: The pipeline's short id.
        ttl: The control's idle ttl (0 = values never expire).
        config: The node's stored config for this control.
        control_id: The control's transient id.
    """

    orgId: str
    userId: str
    teamId: str = 'team-1'
    address: str = 'acme.monitor.webhook'
    rung: str = 'spec'
    owner_kind: str = 'user'
    project_id: str = 'monitor'
    ttl: int = 0
    config: Tuple[Tuple[str, Any], ...] = ()
    control_id: str = field(default_factory=lambda: uuid.uuid4().hex)

    @property
    def owner_type(self) -> str:
        """``'team'`` or ``'user'`` (the server's TaskControl.owner_type)."""
        return self.owner_kind

    @property
    def owner_id(self) -> str:
        """The owning user or team (the server's TaskControl.owner_id)."""
        return self.teamId if self.owner_kind == 'team' else self.userId


@dataclass
class Call:
    """
    One request: who calls, with which per-call params, and what reaches the node.

    Attributes:
        owner: The calling control.
        invoke: ``(instance) -> None``: drives the node (``writeText``, ...).
        params: The admitted params of the node, by leaf path.
    """

    owner: Owner
    invoke: Callable[[Any], None]
    params: Dict[str, Any] = field(default_factory=dict)


# ==== The server both replicas reach =============================================


class _Client:
    """The response envelope the channel handler builds answers with."""

    @staticmethod
    def build_response(message: Dict[str, Any], body: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """A success response."""
        return {'success': True, 'command': message.get('command'), 'body': body or {}}

    @staticmethod
    def build_error(message: Dict[str, Any], text: str) -> Dict[str, Any]:
        """A refusal."""
        return {'success': False, 'command': message.get('command'), 'message': text}


class ReplicaEngine:
    """The server's record of one replica's engine: its id, its streams, its claimed bindings."""

    def __init__(self, server: 'ReplicaServer', engine_id: int):
        """
        Record an engine.

        Args:
            server: The server the replica reaches.
            engine_id: This launch's id.
        """
        self.engine_id = engine_id
        self.streams = ChannelStreams()
        self._server = server

    def binding_control(self, trace_id: Any) -> Optional[Owner]:
        """The control that owns a binding of this engine: claimed bindings only, as on a shared engine."""
        return self._server.owner_of(self.engine_id, trace_id)


class ReplicaServer:
    """
    The one server: the real node-door handlers over one in-process state store.

    Use as a context manager: it installs its state store and the rocketlib
    channel for the duration and removes them after.
    """

    def __init__(self) -> None:
        """Start with an empty store and no claims."""
        self.state = MemoryStateStore()
        self._owners: Dict[Tuple[int, int], Owner] = {}
        self._engines = itertools.count(1)
        self._current: contextvars.ContextVar = contextvars.ContextVar('replica_engine')

    def __enter__(self) -> 'ReplicaServer':
        """Install the store and the channel."""
        install_state_store(self.state)
        rocketlib.setNodeChannel(self._request, CONST_CHANNEL_CHUNK)
        return self

    def __exit__(self, *exc: Any) -> None:
        """Remove them."""
        rocketlib.setNodeChannel(None)
        install_state_store(None)

    def engine(self) -> ReplicaEngine:
        """A new engine launch of this server."""
        return ReplicaEngine(self, next(self._engines))

    def claim(self, engine: ReplicaEngine, trace_id: int, owner: Owner) -> None:
        """Record that a binding belongs to a control (what cmd_data does at the open)."""
        self._owners[(engine.engine_id, trace_id)] = owner

    def release(self, engine: ReplicaEngine, trace_id: int) -> None:
        """Forget a binding at its close."""
        self._owners.pop((engine.engine_id, trace_id), None)

    def owner_of(self, engine_id: int, trace_id: Any) -> Optional[Owner]:
        """The control owning a binding, or None."""
        return self._owners.get((engine_id, trace_id)) if isinstance(trace_id, int) else None

    def serving(self, engine: ReplicaEngine) -> contextvars.Token:
        """Mark the engine whose node is making requests now."""
        return self._current.set(engine)

    def done(self, token: contextvars.Token) -> None:
        """Unmark it."""
        self._current.reset(token)

    def _request(self, command: str, arguments: Dict[str, Any], data: Optional[bytes]) -> Tuple[Dict[str, Any], Any]:
        """
        One node-door request through the real channel dispatch.

        Args:
            command: The channel command.
            arguments: Its arguments (the binding's traceId among them).
            data: A binary payload.

        Returns:
            ``(body, data)`` as the server answered; a streamed reply is pulled whole.

        Raises:
            RuntimeError: The server refused, with its reason.
        """
        engine = self._current.get()
        message = {'command': command, 'arguments': {**arguments, **({'data': data} if data is not None else {})}}
        response = asyncio.run(handle(engine, _Client(), engine.streams, message, startup_open=False))
        if not response.get('success'):
            raise RuntimeError(f'{command}: {response.get("message")}')
        body = dict(response.get('body') or {})
        payload = (response.get('arguments') or {}).get('data')
        stream = body.get('stream')
        if stream is None:
            return body, payload
        buffer = bytearray()
        while True:
            chunk = asyncio.run(
                handle(
                    engine,
                    _Client(),
                    engine.streams,
                    {'command': CONST_CHANNEL_READ, 'arguments': {'stream': stream}},
                    startup_open=False,
                )
            )
            buffer += (chunk.get('arguments') or {}).get('data') or b''
            if (chunk.get('body') or {}).get('eof'):
                return body, bytes(buffer)


# ==== A replica ==================================================================


class _EngineInstance:
    """The engine side of one binding's instance: ids, the current object, and what the node forwards."""

    def __init__(self, trace_id: int, node_id: str):
        """
        Start a binding.

        Args:
            trace_id: The binding's request tree.
            node_id: The component id.
        """
        self.traceId = trace_id
        self.pipeId = 1
        self.pipeType = SimpleNamespace(id=node_id)
        self.currentObject = SimpleNamespace(objectId=f'object-{trace_id}', name='', hasName=False)
        self.outputs: List[Tuple[str, Any]] = []

    def getListeners(self) -> List[str]:
        """Every lane listens."""
        return ['text', 'documents', 'json']

    def __getattr__(self, name: str) -> Callable[..., None]:
        """Record every ``write*`` the node forwards downstream."""
        if not name.startswith('write'):
            raise AttributeError(name)
        return lambda *args: self.outputs.append((name, args))


def _import_package(node_dir: Path, package: str) -> types.ModuleType:
    """
    Import a node directory as a package of its own name: a replica's own module state.

    Args:
        node_dir: The node package directory.
        package: A module name no other replica uses.

    Returns:
        The package; its submodules import relative to it.
    """
    spec = importlib.util.spec_from_file_location(
        package, node_dir / '__init__.py', submodule_search_locations=[str(node_dir)]
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[package] = module
    spec.loader.exec_module(module)
    return module


class Replica:
    """One engine process's worth of a node: its own import of the package, its own IGlobal per control."""

    def __init__(self, server: ReplicaServer, node_dir: Path, logical_type: str, node_id: str):
        """
        Load the node for one replica.

        Args:
            server: The server this replica reaches.
            node_dir: The node package directory.
            logical_type: The service's logical type (its schema's name).
            node_id: The component id the pipeline gives the node.
        """
        self.server = server
        self.engine = server.engine()
        self.logical_type = logical_type
        self.node_id = node_id
        package = f'replica_{self.engine.engine_id}_{uuid.uuid4().hex[:8]}'
        _import_package(Path(node_dir), package)
        self._instance_class = importlib.import_module(f'{package}.IInstance').IInstance
        self._global_class = (
            importlib.import_module(f'{package}.IGlobal').IGlobal
            if (Path(node_dir) / 'IGlobal.py').exists()
            else IGlobalBase
        )
        self._globals: Dict[str, Any] = {}
        self._traces = itertools.count(1)

    def _global_for(self, owner: Owner) -> Any:
        """This replica's IGlobal of a control, built on its first call (beginGlobal)."""
        glb = self._globals.get(owner.control_id)
        if glb is None:
            glb = self._global_class()
            glb.glb = SimpleNamespace(
                controlId=owner.control_id,
                id=self.node_id,
                name=self.node_id,
                logicalType=self.logical_type,
                physicalType='python',
                capabilities=0,
                connConfig=dict(owner.config),
            )
            glb.beginGlobal()
            self._globals[owner.control_id] = glb
        return glb

    def call(self, call: Call) -> List[Tuple[str, Any]]:
        """
        Run one call as one binding: a fresh instance, the caller bound once, the binding claimed.

        Args:
            call: The request.

        Returns:
            What the node forwarded downstream, in order.
        """
        trace_id = next(self._traces)
        owner = call.owner
        self.server.claim(self.engine, trace_id, owner)
        instance = self._instance_class()
        instance.IGlobal = self._global_for(owner)
        instance.IEndpoint = SimpleNamespace(endpoint=None)
        instance.instance = _EngineInstance(trace_id, self.node_id)
        # The engine's one write: the server-set caller context of this binding
        instance._caller = {
            'controlId': owner.control_id,
            'userId': owner.userId,
            'teamId': owner.teamId,
            'orgId': owner.orgId,
            'address': owner.address,
            'rung': owner.rung,
            'params': {self.node_id: dict(call.params)},
            'env': {},
            'traceLevel': 'none',
            'correlationId': uuid.uuid4().hex,
        }
        token = self.server.serving(self.engine)
        try:
            if hasattr(instance, 'beginInstance'):
                instance.beginInstance()
            try:
                call.invoke(instance)
            except APERR as e:
                if e.ec != Ec.PreventDefault:
                    raise
            if hasattr(instance, 'endInstance'):
                instance.endInstance()
        finally:
            self.server.done(token)
            self.server.release(self.engine, trace_id)
        return instance.instance.outputs

    def end(self) -> None:
        """The idle sweep: every control's IGlobal ends and is forgotten."""
        for glb in self._globals.values():
            glb.endGlobal()
        self._globals.clear()


# ==== Playing calls ==============================================================


def run(calls: Sequence[Call], replicas: Sequence[Replica]) -> List[List[Tuple[str, Any]]]:
    """
    Play the calls in order, call ``i`` on ``replicas[i % len(replicas)]``.

    Args:
        calls: The requests.
        replicas: The replicas taking turns (one replica is the reference).

    Returns:
        Each call's forwarded output.
    """
    return [replicas[index % len(replicas)].call(call) for index, call in enumerate(calls)]


def run_alternating_and_alone(
    node_dir: Path, logical_type: str, node_id: str, calls: Sequence[Call]
) -> Tuple[List[Any], List[Any]]:
    """
    The two-replica test: the calls alternately on two replicas, and the same calls on one replica of a fresh server.

    Args:
        node_dir: The node package directory.
        logical_type: The service's logical type.
        node_id: The component id.
        calls: The requests.

    Returns:
        ``(alternating, reference)``: each call's output both ways.
    """
    with ReplicaServer() as server:
        pair = [Replica(server, node_dir, logical_type, node_id) for _ in range(2)]
        alternating = run(calls, pair)
    with ReplicaServer() as server:
        reference = run(calls, [Replica(server, node_dir, logical_type, node_id)])
    return alternating, reference
