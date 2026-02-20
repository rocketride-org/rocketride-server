from typing import Any, Dict
from ai.web import response, exception, Request, Query, Result, Body


def use(
    request: Request,
    name: str = Query(..., description='The name of the plugin or service to activate.'),
    config: Dict[str, Any] = Body(None, description='Optional configuration for the plugin.'),
) -> Result:
    """
    Plugin Activation Endpoint.

    Activates a plugin or service with the given name and configuration.

    Returns:
        Result: The search response.
    """
    try:
        # Get the server we are talking to
        server = request.app.state.server

        # Activate the plugin/service
        server.use(name, config)

        # Return the response
        return response()

    except Exception as e:
        return exception(e)
