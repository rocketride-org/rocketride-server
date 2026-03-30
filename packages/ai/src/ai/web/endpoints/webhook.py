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

import hashlib
import hmac
import logging
import os
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from ai.web import Request, Result, error, exception, response
from ai.web.scheduler.models import WebhookResponse

logger = logging.getLogger(__name__)

# Maximum concurrent webhook-triggered executions.
# Configurable via ROCKETRIDE_MAX_WEBHOOK_CONCURRENT env var.
_MAX_CONCURRENT = int(os.environ.get('ROCKETRIDE_MAX_WEBHOOK_CONCURRENT', '20'))

# In-flight tracking
_active_tasks: Dict[str, Dict[str, Any]] = {}
_running_count: int = 0


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
        # 3. Rate-limit check
        # ----------------------------------------------------------------
        if _running_count >= _MAX_CONCURRENT:
            return error(message=f'Too many concurrent webhook executions (limit: {_MAX_CONCURRENT})', httpStatus=429)

        # ----------------------------------------------------------------
        # 4. Create a task token and start execution
        # ----------------------------------------------------------------
        token = str(uuid.uuid4())
        now = datetime.now(timezone.utc)

        _active_tasks[token] = {
            'pipeline_id': pipeline_id,
            'status': 'accepted',
            'created_at': now.isoformat(),
        }

        _running_count += 1

        # In a full implementation this would dispatch to the pipeline
        # engine asynchronously. For now we record the task and mark it
        # as accepted so the caller can poll /webhook/{id}/status/{token}.
        logger.info('Webhook triggered pipeline %s — token=%s', pipeline_id, token)

        webhook_resp = WebhookResponse(
            token=token,
            pipeline_id=pipeline_id,
            status='accepted',
            created_at=now,
        )

        return response(data=webhook_resp.model_dump(mode='json'))

    except Exception as e:
        return exception(e)


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

        return response(data=task)

    except Exception as e:
        return exception(e)
