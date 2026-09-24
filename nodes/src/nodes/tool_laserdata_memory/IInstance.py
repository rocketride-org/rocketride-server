# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
LaserData memory node instance.

Exposes four agent tools backed by LaserData's Laser SDK ``memory`` primitive
(durable event streams on Apache Iggy):

  remember — append a statement to the durable memory topic; returns its id.
  recall   — fold the topic back and return the most relevant items.
  improve  — record positive/negative feedback on a recalled item.
  forget   — append a tombstone deleting one item.

and two agent-to-agent tasking tools (shared format in ``nodes.core.laserdata_tasking``):

  send_task — queue a task on another agent's inbox, optionally waiting for its reply.
  trace     — fold the ``agent.events`` topic into a timeline for a task or conversation.

Unlike the run-scoped ``memory_internal`` node, this store is persistent and
shared: every agent/run pointing at the same LaserData deployment and
namespace reads and writes the same memory, so it is never cleared on open.

The SDK is async (PyO3): each method resolves its inputs synchronously, then
submits one coroutine to the persistent bridge loop owned by ``IGlobal`` and
blocks on the result — the engine dispatches ``@tool_function`` methods
synchronously. Errors raise (``ValueError`` for bad input, ``RuntimeError``
for backend failures); they are never returned as error dicts.
"""

from __future__ import annotations

import asyncio
import math
import time
from typing import Any, Dict, List

from rocketlib import IInstanceBase, tool_function

from ai.common.utils import int_arg, normalize_tool_input, optional_str, require_str

from nodes.core import laserdata_tasking as tasking

from .IGlobal import _MAX_RECALL_LIMIT, IGlobal

# How often send_task polls the replies topic during an inline wait.
_WAIT_POLL_SECS = 0.25


class IInstance(IInstanceBase):
    """Node instance exposing LaserData memory as agent tools."""

    IGlobal: IGlobal

    # ------------------------------------------------------------------
    # Tools
    # ------------------------------------------------------------------

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['content'],
            'properties': {
                'content': {
                    'type': 'string',
                    'description': 'The statement to remember, stored verbatim.',
                },
                'conversation': {
                    'type': 'string',
                    'description': 'Optional conversation id scoping this memory to one session.',
                },
                'namespace': {
                    'type': 'string',
                    'description': 'Memory namespace to write to. Defaults to the node config value.',
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'memory_id': {'type': 'string', 'description': 'Time-ordered ULID of the stored item.'},
                'namespace': {'type': 'string'},
                'conversation': {'type': 'string'},
            },
        },
        description='Store a statement in durable, shared memory. Returns the memory id (a ULID) that later improve/forget calls reference. Use one namespace per subject (e.g. "customer:42") so this and other agents can recall it later.',
    )
    def remember(self, args):
        """Append a statement to the durable memory topic."""
        args = normalize_tool_input(args, tool_name='remember')

        content = args.get('content')
        if not isinstance(content, str) or not content.strip():
            raise ValueError('laserdata.remember: "content" is required and must be a non-empty string')

        namespace = self._namespace(args, 'remember')
        conversation = _opt_str(args, 'remember', 'conversation')

        cfg = self.IGlobal
        laser = self._laser('remember')
        memory_id = _run(cfg, 'remember', _remember_op(laser, namespace, content, conversation))

        out: Dict[str, Any] = {'memory_id': str(memory_id), 'namespace': namespace}
        if conversation:
            out['conversation'] = conversation
        return out

    @tool_function(
        input_schema={
            'type': 'object',
            'properties': {
                'query': {
                    'type': 'string',
                    'description': 'Optional text to rank by semantic similarity. Backends without an embedder ignore it and return the most recent items first.',
                },
                'limit': {
                    'type': 'integer',
                    'description': 'Max items to retrieve. Defaults to the node config value.',
                },
                'conversation': {
                    'type': 'string',
                    'description': 'Optional conversation id restricting recall to one session.',
                },
                'namespace': {
                    'type': 'string',
                    'description': 'Memory namespace to read. Defaults to the node config value.',
                },
                'strategy': {
                    'type': 'string',
                    'description': 'Optional backend ranking strategy, e.g. "recent".',
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'results': {
                    'type': 'array',
                    'items': {
                        'type': 'object',
                        'properties': {
                            'id': {'type': 'string'},
                            'text': {'type': 'string'},
                            'score': {'type': 'number'},
                            'conversation': {'type': 'string'},
                            'kind': {'type': 'string'},
                        },
                    },
                },
                'count': {'type': 'integer'},
            },
        },
        description="Recall items from durable, shared memory (most recent first unless the backend ranks semantically). Returns each item's id — pass it to improve/forget — plus its text. Use before answering questions the memory may already cover.",
    )
    def recall(self, args):
        """Fold the memory topic back and return matching items."""
        args = normalize_tool_input(args, tool_name='recall')
        cfg = self.IGlobal

        namespace = self._namespace(args, 'recall')
        conversation = _opt_str(args, 'recall', 'conversation')
        query = _opt_str(args, 'recall', 'query')
        strategy = _opt_str(args, 'recall', 'strategy')

        limit = int_arg(
            args, 'limit', default=cfg.recall_limit, lo=1, hi=_MAX_RECALL_LIMIT, tool_name='laserdata.recall'
        )

        laser = self._laser('recall')
        items = _run(
            cfg,
            'recall',
            _recall_op(
                laser,
                namespace,
                limit=limit,
                semantic=query,
                strategy=strategy,
                conversation=conversation,
                folded=cfg.folded,
            ),
        )

        results = _shape_items(items)
        return {'results': results, 'count': len(results)}

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['memory_id', 'weight'],
            'properties': {
                'memory_id': {
                    'type': 'string',
                    'description': 'Id (ULID) of a previously remembered or recalled item.',
                },
                'weight': {
                    'type': 'number',
                    'description': 'Feedback strength: positive promotes the item in future recalls, negative demotes it (e.g. 1.0 / -1.0).',
                },
                'conversation': {
                    'type': 'string',
                    'description': 'Optional conversation id the feedback applies to.',
                },
                'namespace': {
                    'type': 'string',
                    'description': 'Memory namespace. Defaults to the node config value.',
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'feedback_id': {'type': 'string', 'description': 'Id of the recorded feedback signal.'},
                'memory_id': {'type': 'string'},
            },
        },
        description='Reinforce or demote a memory with feedback after using it: positive weight when it proved helpful, negative when it was wrong or stale. Ranking backends fold the signal into future recalls.',
    )
    def improve(self, args):
        """Record feedback on a memory item."""
        args = normalize_tool_input(args, tool_name='improve')

        memory_id = require_str(args, 'memory_id', tool_name='laserdata.improve')
        weight = args.get('weight')
        if isinstance(weight, bool) or not isinstance(weight, (int, float)) or not math.isfinite(weight):
            raise ValueError('laserdata.improve: "weight" is required and must be a finite number')

        namespace = self._namespace(args, 'improve')
        conversation = _opt_str(args, 'improve', 'conversation')

        cfg = self.IGlobal
        laser = self._laser('improve')
        feedback_id = _run(cfg, 'improve', _improve_op(laser, namespace, memory_id, float(weight), conversation))
        return {'feedback_id': str(feedback_id), 'memory_id': memory_id}

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['memory_id'],
            'properties': {
                'memory_id': {
                    'type': 'string',
                    'description': 'Id (ULID) of the item to forget.',
                },
                'conversation': {
                    'type': 'string',
                    'description': 'Optional conversation id the item belongs to.',
                },
                'namespace': {
                    'type': 'string',
                    'description': 'Memory namespace. Defaults to the node config value.',
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'forgotten': {'type': 'boolean'},
                'memory_id': {'type': 'string'},
            },
        },
        description='Delete one item from durable memory by id (appends a tombstone; the audit stream keeps its history). Use when a remembered fact is wrong or must no longer be recalled.',
    )
    def forget(self, args):
        """Append a tombstone for a memory item."""
        args = normalize_tool_input(args, tool_name='forget')

        memory_id = require_str(args, 'memory_id', tool_name='laserdata.forget')
        namespace = self._namespace(args, 'forget')
        conversation = _opt_str(args, 'forget', 'conversation')

        cfg = self.IGlobal
        laser = self._laser('forget')
        _run(cfg, 'forget', _forget_op(laser, namespace, memory_id, conversation))
        return {'forgotten': True, 'memory_id': memory_id}

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['to', 'task'],
            'properties': {
                'to': {'type': 'string', 'description': 'agent_id of the receiving agent, e.g. "risk".'},
                'task': {
                    'type': 'string',
                    'description': 'The work to hand off, as plain text the receiving agent can act on.',
                },
                'wait_secs': {
                    'type': 'integer',
                    'description': 'Seconds to wait for the reply (0-120). 0 (default) returns immediately with status "queued".',
                },
                'conversation_id': {
                    'type': 'string',
                    'description': 'Conversation this task belongs to. When you are handling a task, pass the conversation id from its label so the whole journey traces as one.',
                },
                'parent_task_id': {
                    'type': 'string',
                    'description': 'The task you are handling when this one is a sub-task of it (its id is in the label).',
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'task_id': {'type': 'string'},
                'conversation_id': {'type': 'string'},
                'to': {'type': 'string'},
                'status': {
                    'type': 'string',
                    'description': '"done" (result included) or "queued" (durably queued; the receiver will pick it up).',
                },
                'result': {'type': 'string'},
            },
        },
        description='Hand a task to another agent through LaserData. The task is durably queued the moment this returns, even if the receiving agent is down. With wait_secs > 0, waits that long for its answer.',
    )
    def send_task(self, args):
        """Queue a task on another agent's inbox, optionally waiting for its reply."""
        args = normalize_tool_input(args, tool_name='send_task')
        cfg = self.IGlobal
        sender = self._agent_id('send_task')
        to = require_str(args, 'to', tool_name='laserdata.send_task')
        body = require_str(args, 'task', tool_name='laserdata.send_task')
        wait_secs = int_arg(
            args, 'wait_secs', default=0, lo=0, hi=tasking.MAX_WAIT_SECS, tool_name='laserdata.send_task'
        )
        env = tasking.make_task(
            sender=sender,
            to=to,
            body=body,
            inline=wait_secs > 0,
            conversation_id=_opt_str(args, 'send_task', 'conversation_id') or None,
            parent_task_id=_opt_str(args, 'send_task', 'parent_task_id') or None,
        )
        laser = self._laser('send_task')
        return _run(cfg, 'send_task', _send_task_op(cfg, laser, env, wait_secs), timeout=wait_secs + cfg.op_timeout)

    @tool_function(
        input_schema={
            'type': 'object',
            'properties': {
                'task_id': {'type': 'string', 'description': 'One task to trace.'},
                'conversation_id': {
                    'type': 'string',
                    'description': 'Trace every task in a conversation (the whole multi-agent journey).',
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'task_id': {'type': 'string'},
                'conversation_id': {'type': 'string'},
                'tasks': {'type': 'array', 'items': {'type': 'object'}},
            },
        },
        description='Show what happened to a task, or to every task in a conversation: who sent it to whom, status (queued / in_progress / done / failed), attempts, and timings (queue wait, work time, end-to-end, in ms).',
    )
    def trace(self, args):
        """Fold the events topic into a timeline for one task or conversation."""
        args = normalize_tool_input(args, tool_name='trace')
        task_id = _opt_str(args, 'trace', 'task_id') or None
        conversation_id = _opt_str(args, 'trace', 'conversation_id') or None
        if not task_id and not conversation_id:
            raise ValueError('laserdata.trace: pass task_id or conversation_id')
        cfg = self.IGlobal
        laser = self._laser('trace')
        return _run(cfg, 'trace', _trace_op(cfg, laser, task_id, conversation_id))

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _namespace(self, args: Dict[str, Any], tool_name: str) -> str:
        """Resolve the namespace: per-call override falling back to config."""
        cfg = self.IGlobal
        ns = _opt_str(args, tool_name, 'namespace')
        if ns and ns != cfg.namespace and not cfg.allow_namespace_override:
            raise ValueError(
                f'laserdata.{tool_name}: per-call namespace override is disabled — '
                'use the configured namespace or enable "Allow namespace override"'
            )
        ns = ns or cfg.namespace
        if not ns:
            raise ValueError(
                f'laserdata.{tool_name}: a namespace is required — pass it on the call or set it in node config'
            )
        return ns

    def _agent_id(self, tool_name: str) -> str:
        """This agent's configured identity; tasking tools need it."""
        agent_id = self.IGlobal.agent_id
        if not agent_id:
            raise ValueError(f'laserdata.{tool_name}: set "Agent id" in the node config to use tasking tools')
        return agent_id

    def _laser(self, tool_name: str) -> Any:
        """Fetch the shared connection, mapping connect failures to RuntimeError."""
        try:
            return self.IGlobal.get_laser()
        except RuntimeError:
            raise
        except Exception as exc:
            raise RuntimeError(f'laserdata.{tool_name}: connect failed: {_safe_error(self.IGlobal, exc)}') from None


# ---------------------------------------------------------------------------
# Module helpers
# ---------------------------------------------------------------------------


def _run(cfg: IGlobal, tool_name: str, coro, *, timeout: float | None = None) -> Any:
    """Run one SDK coroutine on the bridge loop, mapping failures to RuntimeError."""
    try:
        return cfg.run(coro, timeout=timeout)
    except (ValueError, RuntimeError):
        raise
    except Exception as exc:
        raise RuntimeError(f'laserdata.{tool_name}: {_safe_error(cfg, exc)}') from None


def _safe_error(cfg: IGlobal, exc: BaseException) -> str:
    """Render an SDK exception without leaking connection-string credentials.

    The connection string is a secure field of the form ``user:password@host``;
    a native client error could echo the DSN it was given, so both the full
    string and the bare password are scrubbed before the text reaches tool
    results or logs.
    """
    msg = str(exc) or type(exc).__name__
    cs = getattr(cfg, 'connection_string', '') or ''
    if cs:
        msg = msg.replace(cs, '<connection-string>')
        userinfo = cs.split('@', 1)[0]
        if '@' in cs and ':' in userinfo:
            password = userinfo.split(':', 1)[1]
            if password:
                msg = msg.replace(password, '****')
    return msg


def _opt_str(args: Dict[str, Any], tool_name: str, key: str) -> str:
    """Optional identifier-like string arg via the shared validator, stripped.

    Thin wrapper over :func:`ai.common.utils.optional_str` that normalizes the
    absent/None case to ``''`` and strips — these args (namespace, conversation,
    query, strategy) are identifiers or search text where surrounding
    whitespace is never meaningful.
    """
    return (optional_str(args, key, default='', tool_name=f'laserdata.{tool_name}') or '').strip()


def _shape_items(items: Any) -> List[Dict[str, Any]]:
    """Map SDK MemoryItem objects into the tool's output rows."""
    out: List[Dict[str, Any]] = []
    for item in items or []:
        text = getattr(item, 'text', None)
        if text is None:
            # Binary payloads have no text projection; surface a decodable body
            # rather than dropping the row.
            payload = getattr(item, 'payload', None)
            if isinstance(payload, (bytes, bytearray)):
                text = payload.decode('utf-8', errors='replace')
            else:
                text = ''
        row: Dict[str, Any] = {
            'id': str(getattr(item, 'id', '') or ''),
            'text': str(text),
        }
        score = getattr(item, 'score', None)
        if isinstance(score, (int, float)) and not isinstance(score, bool):
            row['score'] = float(score)
        conversation = getattr(item, 'conversation_id', None)
        if conversation:
            row['conversation'] = str(conversation)
        kind = getattr(item, 'kind', None)
        if kind:
            row['kind'] = str(kind)
        out.append(row)
    return out


# ---------------------------------------------------------------------------
# SDK coroutines (run on the IGlobal bridge loop; laser-sdk objects must only
# be touched from the loop thread)
# ---------------------------------------------------------------------------


async def _remember_op(laser: Any, namespace: str, payload: str, conversation: str) -> Any:
    """Append `payload` to the namespace's memory topic; return the new id."""
    memory = laser.memory(namespace)
    kwargs: Dict[str, Any] = {}
    if conversation:
        kwargs['conversation'] = conversation
    return await memory.remember(payload, **kwargs)


async def _recall_op(
    laser: Any,
    namespace: str,
    *,
    limit: int,
    semantic: str,
    strategy: str,
    conversation: str,
    folded: bool,
) -> Any:
    """Recall up to `limit` items from the namespace."""
    memory = laser.memory(namespace)
    kwargs: Dict[str, Any] = {'limit': limit, 'folded': folded}
    if semantic:
        kwargs['semantic'] = semantic
    if strategy:
        kwargs['strategy'] = strategy
    if conversation:
        kwargs['conversation'] = conversation
    return await memory.recall(**kwargs)


async def _improve_op(laser: Any, namespace: str, memory_id: str, weight: float, conversation: str) -> Any:
    """Record feedback on `memory_id`; return the feedback record's id."""
    memory = laser.memory(namespace)
    kwargs: Dict[str, Any] = {}
    if conversation:
        kwargs['conversation'] = conversation
    return await memory.improve(memory_id, weight, **kwargs)


async def _forget_op(laser: Any, namespace: str, memory_id: str, conversation: str) -> Any:
    """Append a tombstone for `memory_id`."""
    memory = laser.memory(namespace)
    kwargs: Dict[str, Any] = {}
    if conversation:
        kwargs['conversation'] = conversation
    return await memory.forget(memory_id, **kwargs)


async def _ensure(cfg: IGlobal, laser: Any, name: str) -> None:
    """Create a topic once per connection (one partition: strict order)."""
    if name not in cfg.ensured_topics:
        await laser.topic(name).ensure(1)
        cfg.ensured_topics.add(name)


async def _send_task_op(cfg: IGlobal, laser: Any, env: Any, wait_secs: int) -> Dict[str, Any]:
    """Append the task and its 'sent' event; optionally wait for the correlated reply."""
    import laser_sdk

    inbox = tasking.inbox_topic(env.to)
    await _ensure(cfg, laser, inbox)
    await _ensure(cfg, laser, tasking.EVENTS_TOPIC)
    cursor = None
    if wait_secs > 0:
        await _ensure(cfg, laser, env.reply_to)
        cursor = laser.topic(env.reply_to).replay()
        await cursor.poll()  # drain history: only replies after this send count
    await laser.send_agent(inbox, tasking.encode(env), laser_sdk.Provenance(**tasking.provenance_kwargs(env)))
    await laser.topic(tasking.EVENTS_TOPIC).publish(tasking.event('sent', env, agent=env.sender)).send()
    out: Dict[str, Any] = {
        'task_id': env.task_id,
        'conversation_id': env.conversation_id,
        'to': env.to,
        'status': 'queued',
    }
    if cursor is None:
        return out
    deadline = time.monotonic() + wait_secs
    while time.monotonic() < deadline:
        for rec in await cursor.poll():
            try:
                reply = tasking.decode(tasking.record_json(rec))
            except ValueError:
                continue
            if reply.kind == 'reply' and reply.task_id == env.task_id:
                return {**out, 'status': 'done', 'result': reply.body}
        await asyncio.sleep(_WAIT_POLL_SECS)
    return out


async def _trace_op(cfg: IGlobal, laser: Any, task_id: str | None, conversation_id: str | None) -> Dict[str, Any]:
    """Read the whole events topic and fold it into a timeline."""
    await _ensure(cfg, laser, tasking.EVENTS_TOPIC)
    cursor = laser.topic(tasking.EVENTS_TOPIC).replay()
    events: List[Any] = []
    while True:
        batch = await cursor.poll()
        if not batch:
            break
        for rec in batch:
            try:
                events.append(tasking.record_json(rec))
            except Exception:
                continue
    return tasking.build_timeline(events, task_id=task_id, conversation_id=conversation_id)
