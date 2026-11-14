# MIT License
# Copyright (c) 2026 Aparavi Software AG

"""Agent-facing Redis string tools, using RocketRide's standard dispatcher."""

import json

from ai.common.utils import normalize_tool_input
from rocketlib import IInstanceBase, tool_function

from .IGlobal import IGlobal
from .redis_client import MAX_TTL_SECONDS, MAX_VALUE_BYTES, RedisNodeError, bounded_result

_KEY = {
    'type': 'string',
    'minLength': 1,
    'maxLength': 256,
    'description': 'Logical UTF-8 key; namespace is always prepended. The complete namespaced key must fit in 256 bytes.',
}
_COMMON = {
    'success': {'type': 'boolean'},
    'error': {'type': 'string'},
    'error_code': {'type': 'string'},
    'outcome': {'type': 'string'},
}


def _input(properties, required):
    return {'type': 'object', 'properties': properties, 'required': required, 'additionalProperties': False}


def _output(properties):
    return {'type': 'object', 'properties': {**_COMMON, **properties}, 'required': ['success']}


class IInstance(IInstanceBase):
    """Expose only the seven explicitly supported Redis operations."""

    IGlobal: IGlobal

    def _run(self, operation, raw, allowed, required):
        try:
            # The shared normalizer deliberately returns {} on invalid input.
            # Validate the object first so SCAN cannot mistake that for a
            # legitimate request using its default cursor and count.
            if not isinstance(raw, dict):
                try:
                    if isinstance(raw, str):
                        raw = json.loads(raw)
                    else:
                        convert = getattr(raw, 'model_dump', None) or getattr(raw, 'dict', None)
                        raw = convert() if callable(convert) else None
                except Exception:
                    raise RedisNodeError('invalid_input', 'Tool arguments must be an object.') from None
            if not isinstance(raw, dict):
                raise RedisNodeError('invalid_input', 'Tool arguments must be an object.')
            args = normalize_tool_input(raw, tool_name=f'redis_{operation}')
            if set(args).difference(allowed) or any(args.get(name) is None for name in required):
                raise RedisNodeError('invalid_input', 'Missing required arguments or unsupported argument names.')
            # Some agents send JSON null for omitted optional arguments.
            args = {name: value for name, value in args.items() if value is not None}
            store = self.IGlobal.store
            if store is None:
                raise RedisNodeError('not_initialized', 'Redis node is not initialized.')
            return bounded_result({'success': True, **getattr(store, operation)(**args)})
        except RedisNodeError as exc:
            return {'success': False, 'error_code': exc.code, 'error': str(exc), 'outcome': exc.outcome}

    @tool_function(
        input_schema=_input({'key': _KEY}, ['key']),
        output_schema=_output(
            {
                'key': {'type': 'string'},
                'found': {'type': 'boolean'},
                'value': {'type': ['string', 'null']},
                'ttl_seconds': {'type': 'integer'},
            }
        ),
        description='Read a UTF-8 string from a namespaced Redis key. found=false means missing; an empty string is a hit. ttl_seconds is -2 for missing, -1 for persistent, otherwise remaining seconds. Oversized or binary values return errors.',
    )
    def redis_get(self, args):
        return self._run('get', args, ['key'], ['key'])

    @tool_function(
        input_schema=_input(
            {
                'key': _KEY,
                'value': {
                    'type': 'string',
                    'maxLength': MAX_VALUE_BYTES,
                    'description': 'UTF-8 text, at most 64 KiB encoded bytes or the smaller configured cap.',
                },
                'ttl_seconds': {
                    'type': 'integer',
                    'minimum': 0,
                    'maximum': MAX_TTL_SECONDS,
                    'description': 'Omit to use default TTL; 0 stores persistently; positive sets expiry in seconds.',
                },
                'condition': {
                    'type': 'string',
                    'enum': ['NX', 'XX'],
                    'description': 'NX stores only if absent; XX only if present.',
                },
            },
            ['key', 'value'],
        ),
        output_schema=_output(
            {'key': {'type': 'string'}, 'stored': {'type': 'boolean'}, 'requested_ttl_seconds': {'type': 'integer'}}
        ),
        description='Store a UTF-8 string in Redis. Requires allow_writes. Optional NX/XX may skip the write (stored=false). A successful write replaces the old value and expiry. No automatic retries: an unknown outcome must be checked before retrying.',
    )
    def redis_set(self, args):
        return self._run('set', args, ['key', 'value', 'ttl_seconds', 'condition'], ['key', 'value'])

    @tool_function(
        input_schema=_input({'key': _KEY}, ['key']),
        output_schema=_output(
            {
                'key': {'type': 'string'},
                'exists': {'type': 'boolean'},
                'has_expiry': {'type': 'boolean'},
                'ttl_seconds': {'type': 'integer'},
            }
        ),
        description='Inspect a namespaced Redis key without changing it: A TTL of -2 means missing, -1 means persistent, and nonnegative values are remaining seconds. Available in read-only mode.',
    )
    def redis_ttl(self, args):
        return self._run('ttl', args, ['key'], ['key'])

    @tool_function(
        input_schema=_input(
            {'key': _KEY, 'ttl_seconds': {'type': 'integer', 'minimum': 1, 'maximum': MAX_TTL_SECONDS}},
            ['key', 'ttl_seconds'],
        ),
        output_schema=_output(
            {'key': {'type': 'string'}, 'updated': {'type': 'boolean'}, 'requested_ttl_seconds': {'type': 'integer'}}
        ),
        description='Set a strictly positive expiry in seconds on a namespaced key. updated=false means missing. Requires allow_writes. No retries; connection failure may leave an unknown write outcome.',
    )
    def redis_expire(self, args):
        return self._run('expire', args, ['key', 'ttl_seconds'], ['key', 'ttl_seconds'])

    @tool_function(
        input_schema=_input(
            {
                'key': _KEY,
                'amount': {
                    'type': 'string',
                    'pattern': '^-?(0|[1-9][0-9]{0,18})$',
                    'description': 'Signed 64-bit decimal string; defaults to 1.',
                },
            },
            ['key'],
        ),
        output_schema=_output({'key': {'type': 'string'}, 'value_decimal': {'type': 'string'}}),
        description='Atomically increment a namespaced integer using INCRBY. Each successful call increments again: call once per requested increment and use redis_get to inspect, not another increment. Missing starts at zero; existing expiry is preserved, new keys are persistent. Returns the exact signed 64-bit value as a decimal string. Requires allow_writes. Never retry an unknown outcome blindly.',
    )
    def redis_incr(self, args):
        return self._run('incr', args, ['key', 'amount'], ['key'])

    @tool_function(
        input_schema=_input(
            {
                'cursor': {
                    'type': 'string',
                    'pattern': '^(0|[1-9][0-9]{0,19})$',
                    'description': 'Unsigned 64-bit decimal string; start at 0.',
                },
                'count': {'type': 'integer', 'minimum': 1, 'maximum': 500},
            },
            [],
        ),
        output_schema=_output(
            {
                'cursor': {'type': 'string'},
                'keys': {'type': 'array', 'items': {'type': 'string'}},
                'done': {'type': 'boolean'},
                'skipped': {'type': 'integer', 'minimum': 0},
            }
        ),
        description='Run one SCAN of the configured namespace. Returns logical keys, the number of invalid keys skipped, and the next cursor; only cursor 0 means done. COUNT is a hint, not a result limit; pages can be empty or contain duplicates. No snapshot guarantee. Oversized results return an error, never a truncated page.',
    )
    def redis_scan(self, args):
        return self._run('scan', args, ['cursor', 'count'], [])

    @tool_function(
        input_schema=_input({'keys': {'type': 'array', 'minItems': 1, 'maxItems': 100, 'items': _KEY}}, ['keys']),
        output_schema=_output({'deleted_count': {'type': 'integer'}}),
        description='Delete 1–100 explicit namespaced keys with DEL. Wildcard characters in key names are literal. Returns the number removed; missing keys do not count. Requires allow_writes. No automatic retries.',
    )
    def redis_delete(self, args):
        return self._run('delete', args, ['keys'], ['keys'])
