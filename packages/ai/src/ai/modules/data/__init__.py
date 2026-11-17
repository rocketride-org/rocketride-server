from typing import Dict, Any
from ai.web import WebServer
from .data_server import DataServer


def initModule(server: WebServer, config: Dict[str, Any]):
    """Register the /task/data WebSocket endpoint backed by a DataServer.

    The DataServer reads its target endpoint lazily from ``server.app.state.target``
    at WebSocket-connection time, so this module is safe to load before any
    source node has registered a target. Source nodes (webhook, telegram) set
    ``state.target`` in their ``_run()`` method, which may execute after this
    module has already been loaded (e.g. when ``node.py`` eager-loads ``data``
    in the shared subprocess web server).

    ``config['token_sha256']`` is the hex SHA-256 of the run's channel token,
    which every connection must present; without it the endpoint refuses
    every connection. ``config['on_closed']`` is called with the connection
    id when an accepted connection ends while the server still listens, so
    the task can tell the engine to reconnect.

    Args:
        server: The WebServer to register ``/task/data`` on.
        config: Module configuration; ``token_sha256`` is the hash of the run's
            channel token, ``on_closed`` the close callback.
    """
    # Create the DataServer instance with a reference to the server so it can
    # read state.target lazily. Do NOT capture state.target here — it may not
    # be set yet for sourceless pipelines (agentic, etc.).
    data_server = DataServer(
        server=server, token_sha256=config.get('token_sha256'), on_closed=config.get('on_closed'), config=config
    )

    # Register our routes
    server.add_socket('/task/data', data_server.listen)
