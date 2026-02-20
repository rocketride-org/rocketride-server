from rocketlib import getVersion
from ai.web import exception, Result, response


def version() -> Result:
    """
    Version Endpoint.

    Returns the version of the cloud Engine.

    Returns:
        Result: The version string.
    """
    try:
        # Return the version of the Engine
        return response(getVersion())

    except Exception as e:
        return exception(e)
