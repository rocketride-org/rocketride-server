# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
End-to-end guard for embedding_transformer's batched document forwarding (#2051).

The engine's default forward lives in compiled C++, so a unit test can only re-state
it. This measures it: one payload through two pipelines, counting deliveries at a
response sink that appends one entry per document.

    webhook -> response_documents                           (baseline)
    webhook -> embedding_transformer -> response_documents  (node under test)

64 documents in one write flushes inside writeDocuments, the path that doubled. 63
leaves the buffer short so nothing flushes until close(), which must not
preventDefault or Parent::close() is suppressed and the chunks never arrive.
"""

import json
import uuid
from typing import Any, Dict

import pytest

# The node downloads miniLM, which is why conftest keeps it in skip_nodes (RR-1120).
# That set filters only the generated tests, so this file carries its own marker:
#
#     builder nodes:test --pytest="-m skip_node -k lane_batch_forward_once"
pytestmark = pytest.mark.skip_node

# IInstance.maxDocuments, the buffer size that triggers a flush.
MAX_DOCUMENTS = 64

EMBEDDING = {'id': 'embed_1', 'provider': 'embedding_transformer', 'config': {'profile': 'miniLM'}}


def _documents_payload(count: int) -> bytes:
    """
    Build count chunks as a single lane/documents write.

    A JSON array arrives as one writeDocuments call, which is how a preprocessor
    emits an object's chunks and what makes the flush threshold reachable in one hop.

    Args:
        count: How many chunks to put in the write.

    Returns:
        The UTF-8 JSON payload.
    """
    return json.dumps([{'page_content': f'RocketRide chunk number {i}.'} for i in range(count)]).encode('utf-8')


def _chain(middle: Dict[str, Any] | None = None) -> Dict[str, Any]:
    """
    Build a straight webhook -> [middle] -> response_documents pipeline.

    Args:
        middle: The component under test, or None for the baseline pipeline.

    Returns:
        A pipeline dict for `client.use()`, with a fresh `project_id` so repeated
        runs never collide with a still-registered pipeline.
    """
    components = [{'id': 'webhook_1', 'provider': 'webhook', 'config': {}, 'input': []}]

    prev = 'webhook_1'
    if middle is not None:
        components.append({**middle, 'input': [{'lane': 'documents', 'from': prev}]})
        prev = middle['id']

    components.append(
        {
            'id': 'response_1',
            'provider': 'response_documents',
            'config': {},
            'input': [{'lane': 'documents', 'from': prev}],
        }
    )
    return {'project_id': str(uuid.uuid4()), 'source': 'webhook_1', 'components': components}


async def _deliveries(client, pipeline: Dict[str, Any], payload: bytes) -> int:
    """
    Run one payload through a pipeline and count the documents that reached the sink.

    Args:
        client: Connected RocketRide client (fixture).
        pipeline: The pipeline to register and run.
        payload: The bytes to write into the pipe.

    Returns:
        The number of entries the response sink captured on the documents lane.
    """
    result = await client.use(pipeline=pipeline)
    token = result['token']

    try:
        pipe = await client.pipe(token, objinfo={'name': 'batch_forward_once'}, mime_type='lane/documents')
        await pipe.open()
        await pipe.write(payload)
        response = await pipe.close()
    finally:
        # Two pipelines run back to back; leaving them registered piles up live tasks
        # and later pipe.open() calls get refused. Same teardown as framework/runner.py.
        try:
            await client.terminate(token)
        except Exception:
            pass

    return len(response.get('documents') or [])


async def _assert_forwarded_once(client, count: int, reason: str):
    """
    Assert the node delivers the same number of documents as the bare source.

    The baseline is asserted first so a wrong count cannot be blamed on the source.

    Args:
        client: Connected RocketRide client (fixture).
        count: How many chunks to send in a single write.
        reason: What a disagreeing node-side count means.
    """
    payload = _documents_payload(count)

    baseline = await _deliveries(client, _chain(), payload)
    assert baseline == count, (
        f'the source itself delivered {baseline} documents, expected {count} - the run is not a valid baseline'
    )

    forwarded = await _deliveries(client, _chain(EMBEDDING), payload)
    assert forwarded == baseline, (
        f'embedding_transformer delivered {forwarded} documents where the source delivered {baseline}. {reason}'
    )


async def test_full_batch_delivered_once(client):
    """
    A full batch must reach the sink once, not twice.

    Args:
        client: Connected RocketRide client (fixture).
    """
    await _assert_forwarded_once(
        client,
        MAX_DOCUMENTS,
        'A full batch is flushed with an explicit self.instance.writeDocuments(), so writeDocuments '
        'must call preventDefault() to stop the engine forwarding the incoming batch on top of it',
    )


async def test_partial_batch_delivered_once_on_close(client):
    """
    One document below the threshold, so nothing flushes until close().

    Args:
        client: Connected RocketRide client (fixture).
    """
    await _assert_forwarded_once(
        client,
        MAX_DOCUMENTS - 1,
        'Below maxDocuments the buffer is flushed from close(), which must forward without '
        'preventDefault() so Parent::close() still runs',
    )
