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
End-to-end guard: a parse node and a torch-importing node in one task.

    webhook -> parse -> preprocessor_langchain (General Text) -> response_documents

On Linux this task died on start whenever torch was installed in the engine's Python:
parse's Tika loaded the jar's prebuilt 7-Zip-JBinding (bundled GCC libstdc++, GNU-unique
locale facet ids), General Text imported torch (through ``langchain-text-splitters`` <= 1.1.2
and ``transformers``), and torch's first number formatted through ``std::ostream`` hit the
corrupted facet table. The client saw ``RuntimeError: Received terminal system signal``.

The guard is only as strong as the environment: it needs torch installed and a General Text
whose import chain reaches torch (``langchain-text-splitters`` 1.1.3 imports it lazily). Where
that is not the case the test is skipped; ``test_sevenzip_binding_runtime.py`` holds
the environment-independent checks.
"""

from __future__ import annotations

import importlib.util
import uuid

import pytest

COMPONENTS = [
    {
        'id': 'webhook_1',
        'provider': 'webhook',
        'config': {'hideForm': True, 'mode': 'Source', 'parameters': {}, 'type': 'webhook'},
    },
    {'id': 'parse_1', 'provider': 'parse', 'config': {}, 'input': [{'lane': 'tags', 'from': 'webhook_1'}]},
    {
        'id': 'preprocessor_langchain_1',
        'provider': 'preprocessor_langchain',
        'config': {},
        'input': [{'lane': 'text', 'from': 'parse_1'}],
    },
    {
        'id': 'response_documents_1',
        'provider': 'response_documents',
        'config': {'laneName': 'documents'},
        'input': [{'lane': 'documents', 'from': 'preprocessor_langchain_1'}],
    },
]

_DOCUMENT = b'Seven-Zip bindings, a JVM and torch share one process.\n' * 40


def _pipeline() -> dict:
    """The staging pipeline with a fresh project id, so reruns never collide."""
    return {'project_id': str(uuid.uuid4()), 'source': 'webhook_1', 'components': COMPONENTS}


async def test_parse_then_general_text_starts_and_processes_a_document(client):
    """
    The task must start (parse's JVM up, General Text imported) and return for a document.

    Args:
        client: Connected RocketRide client (fixture).
    """
    if importlib.util.find_spec('torch') is None:
        pytest.skip('torch is not installed in the engine Python: the task cannot hit the libstdc++ hazard here')
    result = await client.use(pipeline=_pipeline())  # died here with the jar's binding + torch
    token = result['token']
    try:
        # parse skips an object whose size is 0; the size travels in objinfo, not in the bytes
        objinfo = {'name': 'guard.txt', 'size': len(_DOCUMENT)}
        pipe = await client.pipe(token, objinfo=objinfo, mime_type='text/plain')
        await pipe.open()
        await pipe.write(_DOCUMENT)
        response = await pipe.close()
        assert isinstance(response, dict), f'unexpected pipe result: {response!r}'
        # the document went through parse and General Text, not just the task start
        assert response.get('objectId'), f'no object came back: {response!r}'
    finally:
        await client.terminate(token)
