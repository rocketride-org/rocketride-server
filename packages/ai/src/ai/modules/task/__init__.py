import os
from typing import Dict, Any
from ai.web import WebServer
from .task_server import TaskServer
from depends import depends

requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
depends(requirements)


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
    # Create the TaskServer instance
    task_server = TaskServer(server=server, config=config)

    # Store task server in server state for access by other modules if needed
    server.app.state.task = task_server

    # Register our routes - authentication handled in listen() before accepting
    server.add_socket('/task/service', task_server.listen, public=True)
