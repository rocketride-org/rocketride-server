from fastapi import WebSocket, WebSocketDisconnect
from time import time

from rocketlib import debug, error, ILoader, Lvl
from engLib import IServiceFilterInstance

from .remote import pipes


async def remote_pipe(webSocket: WebSocket):
    """
    Route WS /remote/pipe.
    """
    # Accept the WebSocket connection
    await webSocket.accept()

    # Output a debug message
    debug(Lvl.Remoting, 'Started remote pipe connection')

    # Extract query parameters from the WebSocket connection
    authorization = webSocket.headers.get('authorization')
    pipe = webSocket.query_params.get('pipe')

    # Get our server instance
    server = webSocket.app.state.server

    # Validate the API key
    apikey = server.validateApikey(authorization)

    # Construct the unique pipeline key
    pipeKey = f'{apikey}.{pipe}'

    # Make sure the pipe exists
    if pipeKey not in pipes:
        raise Exception(f'Pipe {pipe} does not exist')

    # Get the control info
    control = pipes[pipeKey]

    # Get a loader object
    debug(Lvl.Remoting, 'Getting loader')
    loader: ILoader = control['loader']

    # Grab a pipe
    pipe = loader.target.getPipe()

    try:
        # Get a handler for the WebSocket communication
        remote_server: IServiceFilterInstance = pipe.next
        while remote_server and remote_server.pipeType.logicalType != 'remote_server':
            remote_server = remote_server.next
        if not remote_server:
            raise Exception('remote_server node must be specified in remote pipeline')

        # Handle the WebSocket communication
        remote_server.pyInstance.handleWebSocket(webSocket)

    except WebSocketDisconnect:
        # Output a debug message
        debug(Lvl.Remoting, 'Closed remote pipe connection')

    except BaseException as e:
        # Output an error message
        error(e)

        # Close the WebSocket communication
        await webSocket.close()

    finally:
        # Release the pipe
        loader.target.putPipe(pipe)

        # And mark the pipe as disconnected
        control['disconnected'] = time()
