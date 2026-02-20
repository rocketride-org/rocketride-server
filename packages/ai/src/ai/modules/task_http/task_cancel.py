from ai.web import WebServer, exception, response, Request, Query, Header, ResultBase
from rocketride import RocketRideClient


async def task_Cancel(
    request: Request,
    token: str = Query(..., description='Token returned from task execute'),
    authorization: str = Header(..., description='Bearer API key'),
) -> ResultBase:
    """
    Cancel a task.

    Args:
        token (str): The task token received from task_Execute.
        authorization (str): API key for authentication.
    """
    client = None

    try:
        # Get our server
        server: WebServer = request.app.state.server

        # Get the port we are serving
        port = server.get_port()

        # Create the client
        client = RocketRideClient(
            uri=f'http://localhost:{port}',
            auth=request.state.account.auth,
        )

        # Connect to the socket interface
        await client.connect()

        # Lookup the task
        await client.terminate(token)

        # Disconnect the socket
        try:
            await client.disconnect()
        except Exception:
            pass

        # Return current status
        return response()

    except Exception as e:
        return exception(e)

    finally:
        # Always disconnect the client to clean up resources
        if client:
            await client.disconnect()
