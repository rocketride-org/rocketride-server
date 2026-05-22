"""Pipeline utility functions for source resolution and variable substitution."""

import json
import re
from typing import Dict, Any, Optional

# Only environment variables with this prefix are permitted to resolve in pipelines.
# All other env vars are blocked to prevent exfiltration of secrets via ${VAR} expansion.
ALLOWED_ENV_PREFIX = 'ROCKETRIDE_'


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

    resolved_str = re.sub(r'\$\{([^}]+)\}', replacer, pipeline_str)
    return json.loads(resolved_str)


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
                raise ValueError('Pipeline has multiple source components, please specify one explicitly')
            seen_source = True
            source_id = component.get('id', None)
    return source_id
