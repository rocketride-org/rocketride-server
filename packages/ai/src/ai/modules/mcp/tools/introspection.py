# Copyright 2026 Aparavi Software AG. MIT License.
"""Authoring / introspection tools: `list_components`, `describe_component`,
`validate_pipeline`, `describe_pipeline`.

Four of these are read-only; `validate_pipeline`'s single-component form runs
a provider probe (see its hints). None of them issues a task token or starts a
run. `describe_pipeline` has no backing
SDK method; it is synthesized client-side via a static parse of the pipeline
plus a best-effort `get_service` lookup per component provider.
"""

import time
from typing import Any, Dict

from .. import credentials as credentials_mod
from .. import result_size
from ..errors import _bad
from ..tooling import ToolHints, ToolRegistry
from ._common import engine_call
from ._common import load_pipeline

# One overall budget for describe_pipeline's per-provider lookups: without it a
# client-supplied pipeline with many distinct providers against a wedged engine
# holds the tool call open for providers x per-call timeout. Providers left
# unresolved when the budget elapses fall back to the pipeline's own metadata.
DESCRIBE_LOOKUP_BUDGET_SECONDS = 30

# Sent in `truncated` when list_components is cut to fit the result size limit.
_COMPONENTS_HINT = (
    "Not every component fits in one reply. Call describe_component with a component's name to read about one "
    'that is not listed.'
)
_COMPONENTS_STEPS = (result_size.rows('components'),)
# Where a service definition lists one schema branch per profile.
_PROFILE_BRANCHES = ('schema', 'dependencies', 'profile', 'oneOf')

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
    has_hosted_node = any(name in credentials_mod.HOSTED_INTEGRATIONS for name in definitions)
    hosted_models = await credentials_mod.fetch_hosted_models(client) if has_hosted_node else False

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
            state = credentials_mod.evaluate(spec, env_keys, hosted_models)
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
    result_size.fit(result, _COMPONENTS_STEPS, hint=_COMPONENTS_HINT)
    return result


def _profiles_note(section: str):
    """Note how many of a section's profile branches were kept, and how to read the rest."""
    name = '.'.join((section, *_PROFILE_BRANCHES))

    def note(payload: dict, notes: Dict[str, Any], kept: int, full: list) -> None:
        notes[name] = {'returned': kept, 'total': len(full)}
        notes['hint'] = (
            f'{section}.schema shows the settings of the first {kept} of {len(full)} profiles. Every profile name '
            f'is still in {section}.schema.properties.profile.enum. To see what one profile resolves to, call '
            'resolve_config with config {profile: <name>}.'
        )

    return note


def _describe_steps(service: Dict[str, Any]) -> list:
    """How a service definition over the size limit shrinks, in order.

    First every config section's ``ui`` block, which lays out the visual
    editor's form, then each section's profile branches from the end.
    """
    sections = [
        key for key, value in service.items() if isinstance(value, dict) and 'schema' in value and 'ui' in value
    ]
    steps = [result_size.drop((section, 'ui'), {}) for section in sections]
    for section in sections:
        steps.append(result_size.rows((section, *_PROFILE_BRANCHES), note=_profiles_note(section)))
    return steps


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
        hosted_models = (
            await credentials_mod.fetch_hosted_models(client) if name in credentials_mod.HOSTED_INTEGRATIONS else False
        )
        state = credentials_mod.evaluate(spec, env_keys, hosted_models)
        result['credentials'] = credentials_mod.describe_state(spec, state)
    result_size.fit(result, _describe_steps(result))
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
    payload = {'ok': not errors, 'errors': errors, 'warnings': warnings}
    # Warnings go first: the errors are what has to be fixed.
    result_size.fit(payload, (result_size.rows('warnings'), result_size.rows('errors')))
    return payload


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


_VALIDATE_PIPELINE_DESCRIPTION = (
    "Validate a pipeline with the engine's validator, which also checks each component's provider, control "
    "entries and lanes against this engine's services. ok is false when errors is non-empty. "
    'A whole pipeline is checked statically; '
    "the single-component form {version, component} instead runs that provider's configuration probe, which "
    'may contact the configured provider or database.'
)


def register(registry: ToolRegistry) -> None:
    """Register the authoring/introspection tools against ``registry``."""
    registry.register(
        'list_components',
        'List RocketRide components ready to use now (zero-config plus integrations you have configured). '
        'Call describe_component for a config schema, list_integrations for integrations needing setup.',
        {'type': 'object', 'properties': {}},
        hints=ToolHints.reads(
            "Reads the engine catalog and the caller's variable names; writes nothing; bounded to this engine "
            'and account.'
        ),
        always_load=True,
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
        hints=ToolHints.reads('Reads one service definition and its credential readiness; writes nothing.'),
        always_load=True,
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
        hints=ToolHints.reads('Computes the merged config the engine would load for a component; nothing is saved.'),
    )(_resolve_config)

    registry.register(
        'validate_pipeline',
        _VALIDATE_PIPELINE_DESCRIPTION,
        _PIPELINE_SCHEMA,
        hints=ToolHints(
            read_only=False,
            destructive=True,
            open_world=True,
            reason='Whole-pipeline validation is a static engine check, but the accepted single-component form '
            "{version, component} runs that provider's own configuration probe inside the engine: LLM nodes "
            'send a small completion request to the configured endpoint, a charge that cannot be undone, '
            'and store nodes connect to the configured database with the supplied credentials. Destinations '
            'are caller-configured, so the tool is open-world. No run is started and nothing is saved.',
        ),
        always_load=True,
    )(_validate_pipeline)

    registry.register(
        'describe_pipeline',
        'Statically describe a pipeline source and components (id, provider, title, classType, inputs).',
        _PIPELINE_SCHEMA,
        hints=ToolHints.reads(
            'Parses caller-supplied pipeline JSON with best-effort catalog lookups; nothing is saved or run.'
        ),
    )(_describe_pipeline)
