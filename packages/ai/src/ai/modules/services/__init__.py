from typing import Any, Dict
from ai.web import WebServer
from .services import services_get


def initModule(server: WebServer, config: Dict[str, Any]):
    """
    Initialize the module by registering API routes related to services management.

    Args:
        server (WebServer): The web server instance where routes will be registered.
        config (Dict[str, Any]): Configuration settings for the module.

    Routes:
        - GET `/services`: Calls `services_get` to handle full services content.

    """
    server.add_route('/services', services_get, methods=['GET'], public=True)
