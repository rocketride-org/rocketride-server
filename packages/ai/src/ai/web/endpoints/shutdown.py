from ai.web import exception, Result, Request, response


def shutdown(request: Request) -> Result:
    """
    Server Shutdown Endpoint.

    Gracefully shuts down the server.

    Returns:
        Result: Ok
    """
    try:
        # Get the server we are talking to
        server = request.app.state.server

        # Call the shutdown
        server.shutdown()

        # Return the response
        return response()

    except Exception as e:
        return exception(e)
