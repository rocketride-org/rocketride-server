from typing import Any, Dict, Optional
from rocketlib import validatePipeline
from ai.web import response, exception, ResultBase, Request


async def pipe_Validate(request: Request, pipeline: Dict[str, Any], source: Optional[str] = None) -> ResultBase:
    """
    Validate a processing pipeline configuration.

    Source resolution follows the same logic as execute:
    1. Explicit ``source`` parameter (if provided)
    2. ``source`` field inside the pipeline config
    3. Implied source: the single component whose config.mode == 'Source'

    Args:
        pipeline (Dict[str, Any]): The configuration for the pipeline to validate.
        source (str, optional): Override source component ID.

    Returns:
        ResultBase: A standardized response indicating success or failure.
    """
    try:
        # Resolve source: explicit param > pipeline field > implied from components
        resolved_source = source or pipeline.get('source', None)
        if not resolved_source:
            for component in pipeline.get('components', []):
                config = component.get('config', {})
                if config.get('mode', '') == 'Source':
                    if resolved_source is not None:
                        raise ValueError('Pipeline has multiple source components, please specify one explicitly')
                    resolved_source = component.get('id', None)

        # Build the C++ payload with resolved source and default version
        inner = {**pipeline, 'version': pipeline.get('version', 1)}
        if resolved_source:
            inner['source'] = resolved_source

        data = validatePipeline({'pipeline': inner})
        return response(data)

    except Exception as e:
        return exception(e)
