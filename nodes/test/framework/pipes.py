# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""
Open a data pipe on a freshly started pipeline, absorbing the source's startup race.

``client.use()`` returns as soon as the task is registered. The pipeline's source
node binds its data target a little later, and a data ``open()`` that arrives
before that fails with a "no registered source target" error. The failure ends
the task, so the only recovery is a fresh ``use()``.
"""

from typing import Any, Dict, Tuple

from rocketride.core.exceptions import PipeException

# Marker of the server's "source has not bound its target yet" error.
TARGET_NOT_READY = 'registered source target'

OPEN_ATTEMPTS = 3


def is_target_not_ready(error: BaseException) -> bool:
    """
    Tell whether a pipe ``open()`` error is the source-not-ready race.

    Args:
        error: The exception raised by ``pipe.open()``.

    Returns:
        True only for a PipeException carrying the "no registered source target" message.
    """
    return isinstance(error, PipeException) and TARGET_NOT_READY in str(error)


async def use_and_open(
    client, pipeline: Dict[str, Any], *, objinfo: Dict[str, Any], mime_type: str, **use_kwargs
) -> Tuple[str, Any]:
    """
    Start a pipeline and open a data pipe on it, restarting it if its source was not ready.

    Any other open error is raised unchanged. A pipeline abandoned by a retry is
    terminated before the next attempt.

    Args:
        client: Connected RocketRide client.
        pipeline: The pipeline to start.
        objinfo: Object info for the pipe.
        mime_type: MIME type for the pipe.
        **use_kwargs: Extra arguments for ``client.use()``.

    Returns:
        ``(token, pipe)``: the running task's token and its opened pipe. The caller
        terminates the token.
    """
    for attempt in range(1, OPEN_ATTEMPTS + 1):
        token = (await client.use(pipeline=pipeline, **use_kwargs))['token']
        try:
            pipe = await client.pipe(token, objinfo=objinfo, mime_type=mime_type)
            await pipe.open()
            return token, pipe
        except Exception as error:
            try:
                await client.terminate(token)
            except Exception:
                pass
            if attempt == OPEN_ATTEMPTS or not is_target_not_ready(error):
                raise
    raise AssertionError('unreachable')
