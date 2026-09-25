"""Pipeline utility functions for source resolution and variable substitution."""

from typing import Dict, Any, Optional

from ai.common.env_resolve import resolve_env_placeholders

# Re-exported for backwards compatibility with callers that import it from here.
from ai.common.env_resolve import ALLOWED_ENV_PREFIX  # noqa: F401


def resolve_pipeline_env(pipeline: Dict[str, Any], env: Dict[str, str]) -> Dict[str, Any]:
    """Replace ``${KEY}`` placeholders in a pipeline dict with environment values.

    Only variables whose names start with ``ROCKETRIDE_`` are resolved. All
    other references are replaced with ``<REDACTED>`` to prevent secret
    exfiltration. Delegates to :func:`ai.common.env_resolve.resolve_env_placeholders`.

    Args:
        pipeline: Pipeline configuration dictionary.
        env: Merged environment dict (e.g. .env → org → team → user secrets).

    Returns:
        New dictionary with resolved environment variables.
    """
    return resolve_env_placeholders(pipeline, env)


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
