"""Pipeline utility functions for source resolution."""

from typing import Dict, Any, Optional


def resolve_implied_source(pipeline: Dict[str, Any]) -> Optional[str]:
    """Find the implied source component from a pipeline's components list.

    Scans components for exactly one with config.mode == 'Source'.

    Returns:
        The source component ID, or None if no source component found.

    Raises:
        ValueError: If multiple source components are found.
    """
    source = None
    for component in pipeline.get('components', []):
        config = component.get('config', {})
        if config.get('mode', '') == 'Source':
            if source is not None:
                raise ValueError('Pipeline has multiple source components, please specify one explicitly')
            source = component.get('id', None)
    return source
