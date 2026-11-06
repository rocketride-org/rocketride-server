# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
End-to-end guard for the lane-forwarding contract (#2041), measured on a real engine.

The engine's default forward lives in compiled C++, so a unit test can only re-state it.
This measures it: one payload through two pipelines, counting deliveries at a response
sink.

    webhook -> response_<lane>                      (baseline)
    webhook -> anomaly_detector -> response_<lane>  (node under test)

anomaly_detector is the one node in #2041 that can be driven offline: pure standard
library, no API key, no model download, and both of its lanes accept direct injection.
The other four need a HuggingFace model, an Exa key, a LlamaParse key or the Mistral SDK,
so they are covered by the engine-free tests in test_lane_forward_once_nodes.py instead.
"""

import json
import uuid
from typing import Any, Dict

# Text carrying no digits: evaluate_text() passes non-numeric text through unchanged, so
# the sentinel survives byte for byte and can be counted.
SENTINEL = 'RocketRideLaneForwardSentinel'
TEXT_PAYLOAD = f'{SENTINEL} moves data through pipelines.'.encode('utf-8')
DOCUMENT_PAYLOAD = json.dumps([{'page_content': f'{SENTINEL} document body.'}]).encode('utf-8')

DETECTOR = {'id': 'detect_1', 'provider': 'anomaly_detector', 'config': {'profile': 'z_score'}}


def _chain(lane: str, middle: Dict[str, Any] | None = None) -> Dict[str, Any]:
    """
    Build a straight webhook -> [middle] -> response_<lane> pipeline.

    Args:
        lane: The lane to carry and to sink.
        middle: The component under test, or None for the baseline pipeline.

    Returns:
        A pipeline dict for `client.use()`, with a fresh `project_id` so repeated runs
        never collide with a still-registered pipeline.
    """
    components = [{'id': 'webhook_1', 'provider': 'webhook', 'config': {}, 'input': []}]

    prev = 'webhook_1'
    if middle is not None:
        components.append({**middle, 'input': [{'lane': lane, 'from': prev}]})
        prev = middle['id']

    components.append(
        {
            'id': 'response_1',
            'provider': f'response_{lane}',
            'config': {},
            'input': [{'lane': lane, 'from': prev}],
        }
    )
    return {'project_id': str(uuid.uuid4()), 'source': 'webhook_1', 'components': components}


async def _run(client, pipeline: Dict[str, Any], lane: str, payload: bytes):
    """
    Run one payload through a pipeline and return the sink's entries for the lane.

    Args:
        client: Connected RocketRide client (fixture).
        pipeline: The pipeline to register and run.
        lane: The lane to inject on and read back.
        payload: The bytes to write into the pipe.

    Returns:
        The list the response sink captured on that lane.
    """
    result = await client.use(pipeline=pipeline)
    token = result['token']

    try:
        pipe = await client.pipe(token, objinfo={'name': f'lane_forward_{lane}'}, mime_type=f'lane/{lane}')
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

    return response.get(lane) or []


async def test_documents_lane_delivered_once(client):
    """
    A document must reach the sink once, not twice.

    Args:
        client: Connected RocketRide client (fixture).
    """
    baseline = len(await _run(client, _chain('documents'), 'documents', DOCUMENT_PAYLOAD))
    assert baseline == 1, f'the source itself delivered {baseline} documents, expected 1'

    forwarded = len(await _run(client, _chain('documents', DETECTOR), 'documents', DOCUMENT_PAYLOAD))
    assert forwarded == baseline, (
        f'anomaly_detector delivered {forwarded} documents where the source delivered {baseline}. '
        f'It forwards enriched copies explicitly, so writeDocuments must call preventDefault() '
        f'or the engine delivers the un-enriched originals too'
    )


async def test_text_lane_delivered_once(client):
    """
    Text must reach the sink once, not twice.

    response_text concatenates everything it receives into a single entry, so the entry
    count is always 1 and only the sentinel count reveals a double delivery.

    Args:
        client: Connected RocketRide client (fixture).
    """
    baseline_entries = await _run(client, _chain('text'), 'text', TEXT_PAYLOAD)
    baseline = ''.join(baseline_entries).count(SENTINEL)
    assert baseline == 1, f'the source itself delivered the text {baseline} times, expected 1'

    forwarded_entries = await _run(client, _chain('text', DETECTOR), 'text', TEXT_PAYLOAD)
    forwarded = ''.join(forwarded_entries).count(SENTINEL)
    assert forwarded == baseline, (
        f'anomaly_detector delivered the text {forwarded} times where the source delivered '
        f'{baseline}. writeText forwards explicitly, so it must call preventDefault()'
    )
