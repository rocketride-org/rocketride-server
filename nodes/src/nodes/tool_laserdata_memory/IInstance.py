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

import math
from typing import Any, Dict, List

from rocketlib import IInstanceBase, tool_function

from ai.common.utils import normalize_tool_input

from .IGlobal import _MAX_RECALL_LIMIT, IGlobal


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

        namespace = self._namespace(args.get('namespace'), 'remember')
        conversation = _opt_str(args.get('conversation'), 'remember', 'conversation')

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

        namespace = self._namespace(args.get('namespace'), 'recall')
        conversation = _opt_str(args.get('conversation'), 'recall', 'conversation')
        query = _opt_str(args.get('query'), 'recall', 'query')
        strategy = _opt_str(args.get('strategy'), 'recall', 'strategy')

        raw_limit = args.get('limit', cfg.recall_limit)
        if isinstance(raw_limit, bool) or not isinstance(raw_limit, int):
            raw_limit = cfg.recall_limit
        limit = max(1, min(_MAX_RECALL_LIMIT, raw_limit))

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

        memory_id = _req_str(args.get('memory_id'), 'improve', 'memory_id')
        weight = args.get('weight')
        if isinstance(weight, bool) or not isinstance(weight, (int, float)) or not math.isfinite(weight):
            raise ValueError('laserdata.improve: "weight" is required and must be a finite number')

        namespace = self._namespace(args.get('namespace'), 'improve')
        conversation = _opt_str(args.get('conversation'), 'improve', 'conversation')

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

        memory_id = _req_str(args.get('memory_id'), 'forget', 'memory_id')
        namespace = self._namespace(args.get('namespace'), 'forget')
        conversation = _opt_str(args.get('conversation'), 'forget', 'conversation')

        cfg = self.IGlobal
        laser = self._laser('forget')
        _run(cfg, 'forget', _forget_op(laser, namespace, memory_id, conversation))
        return {'forgotten': True, 'memory_id': memory_id}

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _namespace(self, override: Any, tool_name: str) -> str:
        """Resolve the namespace: per-call override falling back to config."""
        cfg = self.IGlobal
        ns = _opt_str(override, tool_name, 'namespace')
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

    def _laser(self, tool_name: str) -> Any:
        """Fetch the shared connection, mapping connect failures to RuntimeError."""
        try:
            return self.IGlobal.get_laser()
        except RuntimeError:
            raise
        except Exception as exc:
            raise RuntimeError(f'laserdata.{tool_name}: connect failed: {exc}') from None


# ---------------------------------------------------------------------------
# Module helpers
# ---------------------------------------------------------------------------


def _run(cfg: IGlobal, tool_name: str, coro) -> Any:
    """Run one SDK coroutine on the bridge loop, mapping failures to RuntimeError."""
    try:
        return cfg.run(coro)
    except (ValueError, RuntimeError):
        raise
    except Exception as exc:
        raise RuntimeError(f'laserdata.{tool_name}: {exc}') from None


def _req_str(value: Any, tool_name: str, field: str) -> str:
    """Validate a required non-empty string argument (identifier-like: stripped)."""
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f'laserdata.{tool_name}: "{field}" is required and must be a non-empty string')
    return value.strip()


def _opt_str(value: Any, tool_name: str, field: str) -> str:
    """Validate an optional string argument; absent/empty normalizes to ''."""
    if value is None:
        return ''
    if not isinstance(value, str):
        raise ValueError(f'laserdata.{tool_name}: "{field}" must be a string')
    return value.strip()


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
