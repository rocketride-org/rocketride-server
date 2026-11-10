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


def resolve_parameter_tokens(pipeline: Dict[str, Any]) -> Dict[str, Any]:
    """Decode parameter tokens in the engine before environment substitution.

    Both deployment-key and legacy tokens can contain environment references.
    The child never needs the deployment key. Only the active profile and
    parameters are decoded, matching the engine's credential precedence.
    """
    components = pipeline.get('components', [])

    def has_token(component: Any) -> bool:
        if not isinstance(component, dict) or not isinstance(component.get('config'), dict):
            return False
        config = component['config']
        profile = config.get('profile')
        sections = (config.get('parameters'), config.get(profile) if isinstance(profile, str) else None)
        return any(isinstance(section, dict) and 'secureParameters' in section for section in sections)

    if not isinstance(components, list) or not any(has_token(component) for component in components):
        return pipeline

    from rocketlib import resolveSecureParameters

    try:
        return resolveSecureParameters(pipeline)
    except Exception:
        raise ValueError('Unable to decode secure pipeline parameters.') from None
