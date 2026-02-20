from ai.web import Result, response


def ping() -> Result:
    """
    Health Check Endpoint.

    Performs a simple health check to verify that the server is running.

    Returns:
        Result: A standardized response indicating the server is operational.

    Responses:
        200: Server is running.
    """
    return response()
