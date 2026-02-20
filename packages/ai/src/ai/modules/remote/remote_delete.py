from ai.web import error, exception, Header, Query, Request, response, Result

from .remote import pipes


def remote_delete(request: Request, pipe: str = Query(None, description='The name of the pipeline to create'), authorization: str = Header(..., description='Bearer API key in the Authorization header')) -> Result:
    """
    Delete an existing pipeline.

    Route DELETE /remote.
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

        # Ensure the pipeline exists before attempting deletion
        if pipeKey not in pipes:
            return error(f'Pipe {pipe} does not exist')

        # Retrieve and remove the pipeline from the global dictionary
        control = pipes.pop(pipeKey)

        # Stop the data loader associated with the pipeline
        control['loader'].endLoad()

        # Explicitly release resources
        control['loader'] = None
        control = None  # Remove reference to the control object

        # Return a success response
        return response()

    except Exception as e:
        return exception(e)
