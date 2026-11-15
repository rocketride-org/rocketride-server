"""Pipeline utility functions for source resolution and variable substitution."""

import json
import re
from typing import Dict, Any, Optional

# Only environment variables with this prefix are permitted to resolve in pipelines.
# All other env vars are blocked to prevent exfiltration of secrets via ${VAR} expansion.
ALLOWED_ENV_PREFIX = 'ROCKETRIDE_'

# A ``${NAME}`` placeholder in the serialized pipeline
PLACEHOLDER = re.compile(r'\$\{([^}]+)\}')


class MultipleSourcesError(ValueError):
    """Source inference requires an explicit choice between multiple source components."""


def resolve_pipeline_env(pipeline: Dict[str, Any], env: Dict[str, str]) -> Dict[str, Any]:
    """Replace ``${KEY}`` placeholders in a pipeline dict with environment values.

    Only variables whose names start with :data:`ALLOWED_ENV_PREFIX` are
    resolved.  All other references are replaced with ``<REDACTED>`` to
    prevent secret exfiltration.

    Args:
        pipeline: Pipeline configuration dictionary.
        env: Merged environment dict (e.g. .env → org → team → user secrets).

    Returns:
        New dictionary with resolved environment variables.
    """
    pipeline_str = json.dumps(pipeline)

    def replacer(match: re.Match) -> str:
        env_var = match.group(1)
        if env_var.startswith(ALLOWED_ENV_PREFIX):
            value = env.get(env_var, match.group(0))
            if value == match.group(0):
                return value  # placeholder not found — keep as-is
            return json.dumps(value)[1:-1]  # escape but strip outer quotes
        return '<REDACTED>'

    resolved_str = PLACEHOLDER.sub(replacer, pipeline_str)
    return json.loads(resolved_str)


def validate_placeholders(pipeline: Dict[str, Any]) -> list:
    """
    Check where a pipeline uses ``${...}`` placeholders (plan 6.2).

    A placeholder is legal in exactly one place: a component's CONFIG value,
    naming a ``ROCKETRIDE_*`` variable the caller's environment fills at run
    time. Anywhere else (a component id, a provider, a connection, the source)
    it would change what the pipeline IS per caller, which a shared engine
    cannot be; a name outside the ``ROCKETRIDE_`` prefix would reach into the
    server's own environment.

    Args:
        pipeline: The pipeline dict.

    Returns:
        Error entries ``{id, message}``; empty when every placeholder is legal.
    """
    errors = []
    components = pipeline.get('components') or []
    # Step 1: the pipeline's STRUCTURE outside the components: the source
    # names a component and is part of the address, so it cannot vary per
    # caller (display fields such as name/description are not checked here;
    # diagnostics a client sends along are not pipeline content)
    for name in PLACEHOLDER.findall(json.dumps({'source': pipeline.get('source')})):
        errors.append(
            {'id': 'pipeline', 'message': f'placeholder ${{{name}}} is only allowed in a component config value'}
        )
    for component in components:
        if not isinstance(component, dict):
            continue
        component_id = str(component.get('id') or component.get('provider') or 'component')
        shell = {k: v for k, v in component.items() if k != 'config'}
        for name in PLACEHOLDER.findall(json.dumps(shell)):
            errors.append(
                {'id': component_id, 'message': f'placeholder ${{{name}}} is only allowed in a component config value'}
            )
        # Step 2: inside config values, the name must be the caller's environment
        for name in PLACEHOLDER.findall(json.dumps(component.get('config') or {})):
            if not name.startswith(ALLOWED_ENV_PREFIX):
                errors.append(
                    {
                        'id': component_id,
                        'message': f'placeholder ${{{name}}} must name a {ALLOWED_ENV_PREFIX}* variable',
                    }
                )
    return errors


def references_env(pipeline: Dict[str, Any]) -> bool:
    """Whether the pipeline has a ``${...}`` placeholder that resolves from the environment.

    Others are redacted by :func:`resolve_pipeline_env` whatever the environment holds.
    """
    return any(name.startswith(ALLOWED_ENV_PREFIX) for name in PLACEHOLDER.findall(json.dumps(pipeline)))


def resolve_implied_source(pipeline: Dict[str, Any]) -> Optional[str]:
    """Find the implied source component from a pipeline's components list.

    Scans components for exactly one with config.mode == 'Source'.

    Returns:
        The source component ID, or None if no source component found.

    Raises:
        ValueError: If multiple source components are found.
    """
    seen_source = False
    source_id = None
    for component in pipeline.get('components', []):
        config = component.get('config', {})
        if config.get('mode', '') == 'Source':
            if seen_source:
                raise MultipleSourcesError('Pipeline has multiple source components, please specify one explicitly')
            seen_source = True
            source_id = component.get('id', None)
    return source_id


def substituted_env(pipeline: Dict[str, Any], env: Dict[str, str]) -> Dict[str, str]:
    """Map each ``${NAME}`` that :func:`resolve_pipeline_env` fills in ``pipeline`` to its value."""
    found = {}
    for name in PLACEHOLDER.findall(json.dumps(pipeline)):
        reference = '${' + name + '}'
        if name.startswith(ALLOWED_ENV_PREFIX) and env.get(name, reference) != reference:
            found[name] = env[name]
    return found
