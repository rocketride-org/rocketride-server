from typing import Any, Dict
from rocketlib import validatePipeline
from ai.web import response, exception, ResultBase, Request


async def pipe_Validate(request: Request, pipeline: Dict[str, Any]) -> ResultBase:
    """
    Validate a processing pipeline configuration.

    Args:
        pipeline (Dict[str, Any]): The configuration for the pipeline to validate.
        authorization (str): The API key for authentication, provided in the Authorization header.

    Returns:
        ResultBase: A standardized response indicating success or failure.
    """
    try:
        data = validatePipeline(pipeline)
        return response(data)

    except Exception as e:
        return exception(e)
