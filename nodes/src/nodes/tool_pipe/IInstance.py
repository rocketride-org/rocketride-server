# =============================================================================
# RocketRide Engine
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
tool_pipe node instance.

Exposes a single ``run_pipeline`` tool that starts a sub-pipeline via the
RocketRide SDK, sends the agent's input through the webhook source, and
returns the configured response lane value.
"""

from __future__ import annotations

import asyncio
import json
import concurrent.futures

from rocketlib import IInstanceBase, tool_function, warning

from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['data'],
            'properties': {
                'data': {
                    'type': 'string',
                    'description': 'The input to send to the pipeline.',
                },
            },
        },
        description=lambda self: self.IGlobal.tool_description,
    )
    def run_pipeline(self, args):
        """Run a sub-pipeline with the given input and return its result."""
        args = _normalize_tool_input(args)
        data = args.get('data')
        if not data:
            raise ValueError('run_pipeline requires a `data` parameter')

        result = _run_in_new_loop(
            _invoke_pipeline(
                uri=self.IGlobal.uri,
                apikey=self.IGlobal.apikey,
                pipe_path=self.IGlobal.pipe_path,
                data=data,
                return_type=self.IGlobal.return_type,
            )
        )
        return {'result': result}


# ---------------------------------------------------------------------------
# Async pipeline driver — runs in a dedicated thread with its own event loop
# ---------------------------------------------------------------------------


async def _invoke_pipeline(
    uri: str,
    apikey: str,
    pipe_path: str,
    data: str,
    return_type: str,
) -> str:
    """Connect to the RocketRide server, run the sub-pipeline, return result."""
    from rocketride import RocketRideClient

    async with RocketRideClient(uri=uri, auth=apikey) as client:
        result = await client.use(filepath=pipe_path, ttl=0)
        token = result['token']
        try:
            response = await client.send(token, data)
        finally:
            try:
                await client.terminate(token)
            except Exception:
                pass

    return _extract_return_value(response, return_type)


def _extract_return_value(response: dict, return_type: str) -> str:
    """Extract the configured return lane value from the pipeline response."""
    if not isinstance(response, dict):
        return str(response) if response is not None else ''

    value = response.get(return_type)

    # answers is a list — return first item
    if return_type == 'answers' and isinstance(value, list):
        return str(value[0]) if value else ''

    # documents / table — serialise to JSON string for the agent
    if isinstance(value, (list, dict)):
        return json.dumps(value, ensure_ascii=False)

    return str(value) if value is not None else ''


def _run_in_new_loop(coro) -> str:
    """
    Run an async coroutine in a fresh event loop on a background thread.

    Using a ThreadPoolExecutor guarantees we never call asyncio.run() inside
    an already-running loop (which would raise RuntimeError), regardless of
    whether the engine itself is async.
    """
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(asyncio.run, coro)
        return future.result()


# ---------------------------------------------------------------------------
# Input normalisation (same pattern as tool_firecrawl)
# ---------------------------------------------------------------------------


def _normalize_tool_input(input_obj):
    """Normalise tool input into a plain dict."""
    if input_obj is None:
        return {}
    if hasattr(input_obj, 'model_dump') and callable(getattr(input_obj, 'model_dump')):
        input_obj = input_obj.model_dump()
    elif hasattr(input_obj, 'dict') and callable(getattr(input_obj, 'dict')):
        input_obj = input_obj.dict()
    if isinstance(input_obj, str):
        try:
            parsed = json.loads(input_obj)
            if isinstance(parsed, dict):
                input_obj = parsed
        except Exception:
            pass
    if not isinstance(input_obj, dict):
        warning(f'tool_pipe: unexpected input type {type(input_obj).__name__}: {input_obj!r}')
        return {}
    if 'input' in input_obj and isinstance(input_obj['input'], dict):
        inner = input_obj['input']
        extras = {k: v for k, v in input_obj.items() if k != 'input'}
        input_obj = {**inner, **extras}
    input_obj.pop('security_context', None)
    return input_obj
