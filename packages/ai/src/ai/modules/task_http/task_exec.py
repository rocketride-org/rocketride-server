from typing import Any, Dict
from ai.web import WebServer, exception, Request, ResultBase, Header, Query, response
from rocketride import RocketRideClient


async def task_Execute(
    request: Request,
    pipeline: Dict[str, Any],
    token: str | None = Query(None, description='Optional token for the task'),
    threads: int = Query(4, ge=1, le=64, description='Optional number of threads to use (1–64)'),
    trace: str = Query(None, description='Optional trace flags for debugging'),
    authorization: str = Header(..., description='Bearer API key in the Authorization header'),
) -> ResultBase:
    """
    Execute a task.

    Args:
        pipeline (Dict[str, Any]): The configuration for the new pipeline.
        authorization (str): The API key for authentication, provided in the Authorization header.

    Returns:
        ResultBase: A standardized response indicating success or failure.

    Behavior:
        - Validates the API key.
        - Constructs a unique identifier (`pipeKey`) using the API key and pipeline name.
        - Checks if the pipeline already exists; if so, returns an error response.
        - Instantiates an `ILoader` and initializes it with the pipeline configuration.
        - Stores the pipeline control information in the global `pipes` dictionary.
        - Returns a success response upon successful creation.

    Example Request:
        >>> PUT / task
        Headers:
            Authorization: Bearer abc123
        Body:
            {
                "source": "s3://bucket/data",
                "transformations": ["filter", "aggregate"]
            }

    Example Response (Success):
        {
            "status": "OK",
            "data": {
                "token": "xyz"
            }
        }

    Example Response (Failure):
        {
            "status": "Error",
            "error": {
                "message": "Could not execute task"
            }
        }
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

        # Add any trace flags
        args = []
        if trace:
            args.append(f'--trace={trace}')

        # For launch/execute the apikey and token are in the arguments
        result = await client.use(
            token=token,  #
            pipeline=pipeline,
            threads=threads,
            args=args,
        )

        # Get the token
        token = result.get('token', '')

        # Return a success response
        return response({'token': token})

    except Exception as e:
        return exception(e)

    finally:
        # Always disconnect the client to clean up resources
        if client:
            await client.disconnect()
