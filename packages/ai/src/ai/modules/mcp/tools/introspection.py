# Copyright 2026 Aparavi Software AG. MIT License.
"""Authoring / introspection tools: `list_components`, `describe_component`,
`validate_pipeline`, `describe_pipeline`.

These are read-only / static-analysis tools -- no task tokens, no execution.
`validate_pipeline` is engine-authoritative (zero client-side validation rules,
so zero drift from the engine's own rules). `describe_pipeline` has no backing
SDK method; it is synthesized client-side via a static parse of the pipeline
plus a best-effort `get_service` lookup per component provider.
"""

import time
from typing import Any, Dict

from .. import credentials as credentials_mod
from ..errors import _bad
from ..tooling import ToolRegistry
from ._common import engine_call
from ._common import load_pipeline

# One overall budget for describe_pipeline's per-provider lookups: without it a
# client-supplied pipeline with many distinct providers against a wedged engine
# holds the tool call open for providers x per-call timeout. Providers left
# unresolved when the budget elapses fall back to the pipeline's own metadata.
DESCRIBE_LOOKUP_BUDGET_SECONDS = 30

_PIPELINE_SCHEMA = {
    'type': 'object',
    'properties': {
        'pipeline': {'type': 'object', 'description': 'Inline pipeline definition'},
    },
    'required': ['pipeline'],
}


async def _list_components(client, tasks, args: Dict[str, Any]) -> dict:
    services, err = await engine_call(client.get_services(), 'list_components')
    if err:
        return err
    definitions = (services or {}).get('services') or {}
    catalog = credentials_mod.load_catalog()
    # Only pay for the env-keys round trip when a credentialed node is
    # actually present in this engine's definitions; a catalog entry with no
    # matching node here is irrelevant to this call.
    has_credentialed_node = any(name in catalog for name in definitions)
    env_keys = await credentials_mod.fetch_env_keys(client) if has_credentialed_node else None

    components = []
    skipped = 0
    for name, definition in definitions.items():
        # One malformed (non-mapping) definition must not block discovery
        # for the whole catalog.
        if not isinstance(definition, dict):
            continue
        entry = {
            'name': name,
            'category': definition.get('classType'),
            'summary': definition.get('description'),
        }
        spec = catalog.get(name)
        if spec is not None:
            state = credentials_mod.evaluate(spec, env_keys)
            if state['status'] != 'configured':
                # Not ready to use: omit rather than list a component the
                # caller can't actually run yet (env_error included -- a
                # read failure must never be mistaken for readiness).
                skipped += 1
                continue
            entry['wiring'] = state['wiring']
        components.append(entry)

    result = {'ok': True, 'components': components}
    if skipped:
        result['note'] = f'{skipped} integrations need setup - call list_integrations.'
    return result


async def _describe_component(client, tasks, args: Dict[str, Any]) -> dict:
    name = args.get('name')
    if not name:
        return _bad('name is required', 'pick a name from list_components')

    service, err = await engine_call(client.get_service(name), 'describe_component')
    if err:
        return err
    if service is None:
        return _bad(f'Unknown component: {name}', 'call list_components for valid names')

    # Merge order: spread the engine's own service definition first, then
    # layer MCP-added keys ('ok', 'credentials') on top. No service*.json in
    # the current tree defines a top-level 'credentials' field, but if one
    # ever did, this ordering deliberately shadows it with the readiness
    # block -- consistent with how 'ok' already shadows any same-named key.
    result = {**service, 'ok': True}
    spec = credentials_mod.load_catalog().get(name)
    if spec is not None:
        env_keys = await credentials_mod.fetch_env_keys(client)
        state = credentials_mod.evaluate(spec, env_keys)
        result['credentials'] = credentials_mod.describe_state(spec, state)
    return result


async def _validate_pipeline(client, tasks, args: Dict[str, Any]) -> dict:
    pipeline = load_pipeline(args)  # raises ValueError -> normalized by the dispatch layer
    # The engine requires the {'pipeline': {...}} envelope and treats a missing
    # version as legacy v0; add both the same way /pipe/validate does, but never
    # double-wrap an already-enveloped config.
    if isinstance(pipeline.get('pipeline'), dict):
        payload = pipeline
    else:
        payload = {'pipeline': {**pipeline, 'version': pipeline.get('version', 1)}}
    validated, err = await engine_call(client.validate(payload), 'validate_pipeline')
    if err:
        return err
    result = validated or {}
    errors = result.get('errors') or []
    warnings = result.get('warnings') or []
    return {'ok': not errors, 'errors': errors, 'warnings': warnings}


async def _resolve_config(client, tasks, args: Dict[str, Any]) -> dict:
    provider = args.get('provider')
    if not provider:
        return _bad('provider is required', 'pick a provider from list_components')

    # Default only an absent config: `or {}` would coerce [] and skip this check.
    config = args.get('config')
    if config is None:
        config = {}
    if not isinstance(config, dict):
        return _bad('config must be an object', "pass the component's config block, or omit it for defaults")

    resolved, err = await engine_call(client.resolve_config(provider, config), 'resolve_config')
    if err:
        return err

    result = resolved or {}
    # Surface the discard rather than leaving it to be inferred from an absence:
    # a key written beside 'profile' instead of inside it never reaches the node.
    dropped = result.get('dropped') or []
    out = {'ok': True, **result}
    if dropped:
        out['hint'] = (
            f'{len(dropped)} config key(s) were discarded because a profile is set: {", ".join(dropped)}. '
            f'Move them inside the "{result.get("profile")}" object to take effect.'
        )
    return out


async def _describe_pipeline(client, tasks, args: Dict[str, Any]) -> dict:
    pipeline = load_pipeline(args)  # raises ValueError -> normalized by the dispatch layer

    service_cache: Dict[str, Any] = {}
    components = []
    lookup_deadline = time.monotonic() + DESCRIBE_LOOKUP_BUDGET_SECONDS
    for comp in pipeline.get('components', []) or []:
        # Client-supplied pipeline: a non-mapping entry must not abort the
        # whole parse (same guard as _list_components).
        if not isinstance(comp, dict):
            continue
        provider = comp.get('provider')
        service = None
        if provider is not None:
            if provider not in service_cache:
                if time.monotonic() >= lookup_deadline:
                    service_cache[provider] = None  # budget spent; static parse continues
                else:
                    try:
                        resolved, _timeout_err = await engine_call(client.get_service(provider), 'describe_pipeline')
                        service_cache[provider] = resolved  # a timed-out lookup caches as None
                    except Exception:  # noqa: BLE001 - unknown/broken provider must not abort the parse
                        service_cache[provider] = None
            service = service_cache[provider]

        components.append(
            {
                'id': comp.get('id'),
                'provider': provider,
                'title': (service or {}).get('title', comp.get('title')),
                'classType': (service or {}).get('classType', comp.get('classType')),
                'inputs': comp.get('input', []),
            }
        )

    return {
        'ok': True,
        'source': pipeline.get('source'),
        'components': components,
    }


def register(registry: ToolRegistry) -> None:
    """Register the authoring/introspection tools against ``registry``."""
    registry.register(
        'list_components',
        'List RocketRide components ready to use now (zero-config plus integrations you have configured). '
        'Call describe_component for a config schema, list_integrations for integrations needing setup.',
        {'type': 'object', 'properties': {}},
    )(_list_components)

    registry.register(
        'describe_component',
        'Describe a single RocketRide component: full metadata, lanes, and config schema.',
        {
            'type': 'object',
            'properties': {
                'name': {'type': 'string', 'description': 'Component name from list_components'},
            },
            'required': ['name'],
        },
    )(_describe_component)

    registry.register(
        'resolve_config',
        'Show what a component config resolves to at load: the engine applies profile and default '
        'merging, so the .pipe rarely says what the node receives. Reports discarded keys.',
        {
            'type': 'object',
            'properties': {
                'provider': {'type': 'string', 'description': 'Component provider, e.g. llm_openai'},
                'config': {'type': 'object', 'description': "The component's config block; omit for defaults"},
            },
            'required': ['provider'],
        },
    )(_resolve_config)

    registry.register(
        'validate_pipeline',
        "Validate a pipeline against the engine's own rules (zero client-side rules -- zero drift).",
        _PIPELINE_SCHEMA,
    )(_validate_pipeline)

    registry.register(
        'describe_pipeline',
        'Statically describe a pipeline source and components (id, provider, title, classType, inputs).',
        _PIPELINE_SCHEMA,
    )(_describe_pipeline)
