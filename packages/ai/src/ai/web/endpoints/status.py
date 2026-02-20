import time
from rocketlib import getVersion
from ai.web import response, exception, Request, Result


def status(request: Request) -> Result:
    """
    Compute the server status.
    """
    try:
        # Get the server we are talking to
        server = request.app.state.server

        status = {
            'server': {
                'version': getVersion(),
                'startTime': server._startTime,
                'uptime': int(time.time() - server._startTime),
            }
        }

        for callback in server._statusCallbacks:
            callback(status)

        # Return the response
        return response(status)

    except Exception as e:
        return exception(e)
