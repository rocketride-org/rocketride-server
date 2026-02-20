from time import time
from typing import Any, Dict

from ai.web import Body, error, exception, Header, Query, Request, response, Result
from rocketlib import ILoader, warning

from .remote import pipes


def remote_create(
    request: Request,
    pipeline: Dict[str, Any] = Body({}, description='The configuration of the pipeline to create'),
    pipe: str = Query(None, description='The name of the pipeline to create'),
    authorization: str = Header(..., description='Bearer API key in the Authorization header'),
) -> Result:
    """
    Create a new pipeline based on the provided configuration.

    Route POST /remote.
    """
    try:
        # Check arguments
        if not pipe:
            return error('Pipe is not specified')

        # Get our server instance
        server = request.app.state.server

        # Validate the API key
        apikey = server.validateApikey(authorization)

        # Construct the unique pipeline key
        pipeKey = f'{apikey}.{pipe}'

        # Drop disconnected pipelines
        for _pipeKey in list(pipes.keys()):
            _control = pipes[_pipeKey]

            # Check if the pipeline is disconnected
            disconnected = _control.get('disconnected')
            if disconnected and (
                time() - disconnected > 300  # 5 minutes
                or _pipeKey == pipeKey
            ):  # a test task
                warning('Remove disconnected pipeline', pipe)

                # Stop the data loader associated with the pipeline
                _control['loader'].endLoad()

                # Explicitly release resources
                _control['loader'] = None

                # Drop the pipeline
                del pipes[_pipeKey]

        # Ensure the pipeline does not already exist
        if pipeKey in pipes:
            return error(f'Pipe {pipe} already exists')

        # Instantiate a data loader and initialize it with the provided pipeline configuration
        loader = ILoader()
        loader.beginLoad(pipeline)

        # Store pipeline metadata for future reference
        control = {'loader': loader, 'apikey': apikey}

        # Add the pipeline to the global tracking dictionary
        pipes[pipeKey] = control

        # Return a success response
        return response()

    except Exception as e:
        # Raise it as a runtime error
        return exception(e)
