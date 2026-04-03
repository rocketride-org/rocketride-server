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

import asyncio
import hashlib
import hmac
import logging
import os
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from ai.web import Request, Result, error, response
from ai.web.scheduler.models import WebhookResponse

logger = logging.getLogger(__name__)

# Maximum concurrent webhook-triggered executions.
# Configurable via ROCKETRIDE_MAX_WEBHOOK_CONCURRENT env var.
_MAX_CONCURRENT = int(os.environ.get('ROCKETRIDE_MAX_WEBHOOK_CONCURRENT', '20'))

# In-flight tracking.
# NOTE: These are process-local. In a multi-worker or horizontally-scaled
# deployment, task state and concurrency limits are per-process.  This is
# acceptable for the current single-process deployment model.  A future
# iteration should move state to a shared store (e.g. Redis) if horizontal
# scaling is required.
_active_tasks: Dict[str, Dict[str, Any]] = {}
_running_count: int = 0
_running_lock = asyncio.Lock()

# TTL for completed/expired task entries (seconds).
_TASK_TTL = 3600  # 1 hour


def _cleanup_expired_tasks() -> None:
    """Remove task entries older than _TASK_TTL to prevent unbounded growth."""
    now = time.monotonic()
    expired = [k for k, v in _active_tasks.items() if now - v.get('_monotonic_created', 0) > _TASK_TTL]
    for k in expired:
        del _active_tasks[k]


def _verify_signature(payload: bytes, signature: str, secret: str) -> bool:
    """
    Verify an HMAC-SHA256 signature against the request payload.

    Uses hmac.compare_digest for timing-safe comparison to prevent
    timing side-channel attacks.

    Args:
        payload: Raw request body bytes.
        signature: The signature provided in the X-Webhook-Signature header.
        secret: The shared webhook secret.

    Returns:
        True if the signature is valid, False otherwise.
    """
    expected = hmac.new(secret.encode('utf-8'), payload, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature)


async def webhook_trigger(request: Request, pipeline_id: str, body: Optional[Dict[str, Any]] = None) -> Result:
    """
    Webhook Trigger Endpoint.

    Triggers a pipeline execution via an HTTP webhook call. The request
    must include a valid HMAC-SHA256 signature in the X-Webhook-Signature
    header. The webhook secret is read from the ROCKETRIDE_WEBHOOK_SECRET
    environment variable.

    Args:
        request: The incoming HTTP request.
        pipeline_id: The pipeline to trigger.
        body: Optional JSON input data for the pipeline.

    Returns:
        Result: A response containing the task token for tracking execution.
    """
    global _running_count  # noqa: PLW0603

    try:
        # ----------------------------------------------------------------
        # 0. Housekeeping — prune expired task entries
        # ----------------------------------------------------------------
        _cleanup_expired_tasks()

        # ----------------------------------------------------------------
        # 1. Verify webhook secret / signature
        # ----------------------------------------------------------------
        secret = os.environ.get('ROCKETRIDE_WEBHOOK_SECRET', '')
        if not secret:
            logger.error('ROCKETRIDE_WEBHOOK_SECRET is not configured')
            return error(message='Webhook secret is not configured on the server', httpStatus=500)

        signature = request.headers.get('x-webhook-signature', '')
        if not signature:
            return error(message='Missing X-Webhook-Signature header', httpStatus=401)

        raw_body = await request.body()
        if not _verify_signature(raw_body, signature, secret):
            return error(message='Invalid webhook signature', httpStatus=401)

        # ----------------------------------------------------------------
        # 2. Validate pipeline_id
        # ----------------------------------------------------------------
        if not pipeline_id or not pipeline_id.strip():
            return error(message='pipeline_id is required', httpStatus=400)

        # ----------------------------------------------------------------
        # 3. Rate-limit check (atomic via asyncio.Lock)
        # ----------------------------------------------------------------
        async with _running_lock:
            if _running_count >= _MAX_CONCURRENT:
                return error(message=f'Too many concurrent webhook executions (limit: {_MAX_CONCURRENT})', httpStatus=429)
            _running_count += 1

        try:
            # ----------------------------------------------------------------
            # 4. Create a task token and start execution
            # ----------------------------------------------------------------
            token = str(uuid.uuid4())
            now = datetime.now(timezone.utc)

            _active_tasks[token] = {
                'pipeline_id': pipeline_id,
                'status': 'accepted',
                'created_at': now.isoformat(),
                'input_data': body,
                '_monotonic_created': time.monotonic(),
            }

            # Dispatch the pipeline execution as a background task so the
            # webhook caller receives a response immediately and can poll
            # /webhook/{pipeline_id}/status/{token} for progress.
            asyncio.create_task(_execute_pipeline(token, pipeline_id, body))

            logger.info('Webhook triggered pipeline %s — token=%s', pipeline_id, token)

            webhook_resp = WebhookResponse(
                token=token,
                pipeline_id=pipeline_id,
                status='accepted',
                created_at=now,
            )

            return response(data=webhook_resp.model_dump(mode='json'))
        except Exception:
            # Ensure the concurrency counter is released on unexpected errors
            # before re-raising into the outer handler.
            async with _running_lock:
                _running_count -= 1
            raise

    except Exception:
        logger.exception('Unexpected error in webhook_trigger for pipeline %s', pipeline_id)
        return error(message='Internal server error', httpStatus=500)


async def webhook_status(request: Request, pipeline_id: str, token: str) -> Result:
    """
    Webhook Status Endpoint.

    Check the execution status of a webhook-triggered pipeline run.

    Args:
        request: The incoming HTTP request.
        pipeline_id: The pipeline that was triggered.
        token: The task token returned by the trigger endpoint.

    Returns:
        Result: Current status of the task.
    """
    try:
        task = _active_tasks.get(token)
        if task is None:
            return error(message=f'Task token {token!r} not found', httpStatus=404)

        if task['pipeline_id'] != pipeline_id:
            return error(message='Token does not belong to the specified pipeline', httpStatus=404)

        # Return a copy without internal bookkeeping fields.
        public_task = {k: v for k, v in task.items() if not k.startswith('_')}
        return response(data=public_task)

    except Exception:
        logger.exception('Unexpected error in webhook_status for pipeline %s, token %s', pipeline_id, token)
        return error(message='Internal server error', httpStatus=500)


async def _execute_pipeline(token: str, pipeline_id: str, input_data: Optional[Dict[str, Any]]) -> None:
    """Execute a pipeline in the background and update task state.

    Called via ``asyncio.create_task`` from :func:`webhook_trigger` so that
    the HTTP response is returned immediately while the pipeline runs.

    The concurrency counter (``_running_count``) is decremented in the
    ``finally`` block to guarantee it is released even on failure.
    """
    global _running_count  # noqa: PLW0603

    try:
        _active_tasks[token]['status'] = 'running'

        # TODO: Replace with actual pipeline engine dispatch once the
        # integration interface is finalised.  For now this is a placeholder
        # that marks the task as completed immediately.
        logger.info('Executing pipeline %s for token %s', pipeline_id, token)
        _active_tasks[token]['status'] = 'completed'
    except Exception:
        logger.exception('Pipeline execution failed for token %s (pipeline %s)', token, pipeline_id)
        if token in _active_tasks:
            _active_tasks[token]['status'] = 'failed'
    finally:
        async with _running_lock:
            _running_count -= 1


def register_webhook_routes(server: Any) -> None:
    """Register webhook endpoints with the server.

    Call this from the server setup code to wire the webhook trigger and
    status handlers into the application router.

    Args:
        server: The RocketRide server instance (must have an ``add_route`` method).
    """
    server.add_route('/webhook/{pipeline_id}/trigger', webhook_trigger, ['POST'])
    server.add_route('/webhook/{pipeline_id}/status/{token}', webhook_status, ['GET'])
