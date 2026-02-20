import os
from typing import Any, Literal, Optional, Dict
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from typing import List


class ResultBase(BaseModel):
    """
    Base class for API responses with a standardized format.

    - `status`: Always present, indicates if the response is "OK" or "Error".
    - `data`: Optional, contains the successful response data.
    - `error`: Optional, contains error details when `status` is "Error".
    """

    model_config = {'exclude_none': True}

    status: Literal['OK', 'Error']
    data: Optional[dict] = None
    error: Optional[dict] = None
    metrics: Optional[dict] = None
    warnings: Optional[List[str]] = None


class ResultSuccess(BaseModel):
    """
    Represents a successful API response with data.
    """

    model_config = {'exclude_none': True}

    status: Literal['OK'] = 'OK'
    data: Optional[dict] = None
    metrics: Optional[dict] = None
    warnings: Optional[List[str]] = None


class ResultError(BaseModel):
    """
    Represents an error API response.
    """

    model_config = {'exclude_none': True}

    status: Literal['Error'] = 'Error'
    error: Optional[dict] = None
    metrics: Optional[dict] = None
    warnings: Optional[List[str]] = None


class Result(ResultBase):
    """
    A generic result with no data.
    """

    pass


def response(data: Any = None, httpStatus: int = 200, warnings: Optional[List[str]] = None) -> Result:
    """
    Create a standardized success response.

    Args:
        data (Any, optional): Response data.
        httpStatus (int, optional): HTTP status code (default: 200).

    Returns:
        Result: A FastAPI JSONResponse.
    """
    content = ResultSuccess(data=data, warnings=warnings)
    return JSONResponse(content=content.model_dump(exclude_none=True), status_code=httpStatus)


def error_dap(response: Dict[str, Any], *, httpStatus: int = 400) -> Result:
    """
    Create a standardized error response from a dap response packet.

    Args:
        error (str): Error message.
        httpStatus (int, optional): HTTP status code (default: 400).

    Returns:
        Result: A FastAPI JSONResponse.
    """
    # Build the error packet
    error = {
        'error': response.get('message', 'Unknown error'),
        'file': response.get('trace', {}).get('file', None),
        'lineno': response.get('trace', {}).get('lineno', None),
    }

    # Build the result
    content = ResultError(error=error)

    # And return the error packet
    return JSONResponse(content=content.model_dump(exclude_none=True), status_code=httpStatus)


def error(message: str, *, httpStatus: int = 400, file: str = None, lineno: int = None) -> Result:
    """
    Create a standardized error response.

    Args:
        error (str): Error message.
        httpStatus (int, optional): HTTP status code (default: 400).

    Returns:
        Result: A FastAPI JSONResponse.
    """
    # Build the error packet
    error = {'error': message}

    # Add the file and line number if provided
    if file is not None:
        error['file'] = file
    if lineno is not None:
        error['lineno'] = (lineno,)

    # Build the result
    content = ResultError(error=error)

    # And return the error packet
    return JSONResponse(content=content.model_dump(exclude_none=True), status_code=httpStatus)


def formatException(e: Exception):
    """
    Format an exception into a standardized error response.

    This can accept either a standard exception, or if the exception is build from
    our Error class, then use the exception fields it stored away
    """
    # Is this a dap exception?
    if hasattr(e, '__dap_results__'):
        # Get the message and format it
        msg = str(e)

        # We going to return only the filename
        trace = e.__dap_results__.get('trace', {})
        filename = trace.get('file', None)
        lineno = trace.get('lineno', None)

        # Yes, it already has all the fields we need
        content = ResultError(error={'message': msg, 'file': filename, 'lineno': lineno})
        return content

    # Is this one of ours (essentially a mapped Error value)?
    elif hasattr(e, '__formatted'):
        # Get the message and format it
        msg = f'{type(e).__name__}: {e.message}'

        # We going to return only the filename
        filename = os.path.basename(e.filename)

        # Yes, it already has all the fields we need
        content = ResultError(error={'message': msg, 'file': filename, 'lineno': e.line})
        return content

    else:
        # Nope, we must find them
        tb = e.__traceback__
        if tb:
            while tb.tb_next:
                tb = tb.tb_next  # Navigate to the deepest traceback entry

            # Get the filename and line number where the error occurred
            filename = os.path.basename(tb.tb_frame.f_code.co_filename)
            line_number = tb.tb_lineno  # Get the line number of the error

            content = ResultError(error={'message': str(e), 'file': filename, 'lineno': line_number})
        else:
            content = ResultError(error={'message': str(e)})

        return content


def exception(e: Exception) -> Result:
    """
    Handle exceptions by returning a standardized error response including traceback details.

    Args:
        e (Exception): The exception instance.

    Returns:
        Result: A FastAPI JSONResponse.
    """
    content = formatException(e)
    return JSONResponse(content=content.model_dump(exclude_none=True), status_code=400)
