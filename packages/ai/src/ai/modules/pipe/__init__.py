from typing import Any, Dict
from ai.web import WebServer
from .pipe_validate import pipe_Validate


def initModule(server: WebServer, config: Dict[str, Any]):
    """
    Initialize the module by registering API routes related to pipe management.

    Args:
        server (WebServer): The web server instance where routes will be registered.
        config (Dict[str, Any]): Configuration settings for the module.

    Routes:
        - DELETE `/pipe`: Calls `pipe_Delete` to handle pipe deletion requests.
        - POST `/pipe`: Calls `pipe_Create` to handle pipe creation requests.
        - PUT `/pipe/process`: Calls `pipe_Process` to handle pipe processing requests.

    """
    # Register our routes
    server.add_route('/pipe/validate', pipe_Validate, methods=['POST'], public=True)
