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

import argparse
import asyncio
import json
import sys
from collections.abc import Callable
from typing import Any

from ai.web import WebServer
from fastapi import Request
from fastapi.responses import PlainTextResponse
from rocketlib import (
    OPEN_MODE,
    IEndpointBase,
    IJson,
    getObject,
    monitorCompleted,
    monitorFailed,
    monitorOther,
    monitorStatus,
)

from .slack_events import TtlDedupCache, classify_event, verify_slack_signature

MAX_SLACK_REQUEST_BODY_BYTES = 1024 * 1024


class IEndpoint(IEndpointBase):
    """Receive verified Slack Events API callbacks and route them to output lanes."""

    target: IEndpointBase | None = None
    _signing_secret: str = ''
    _queue: asyncio.Queue | None = None
    _dedup: TtlDedupCache | None = None
    _consumer_task: asyncio.Task | None = None
    _delivery_task: asyncio.Task | None = None
    _accepting: bool = False

    async def _request_handler(self, request: Request):
        """Read, authenticate, and enqueue one Slack callback request."""
        body_chunks = []
        body_size = 0
        async for chunk in request.stream():
            body_size += len(chunk)
            if body_size > MAX_SLACK_REQUEST_BODY_BYTES:
                return PlainTextResponse('', status_code=413)
            body_chunks.append(chunk)
        raw_body = b''.join(body_chunks)
        timestamp = request.headers.get('X-Slack-Request-Timestamp', '')
        signature = request.headers.get('X-Slack-Signature', '')
        if not verify_slack_signature(self._signing_secret, timestamp, signature, raw_body):
            return PlainTextResponse('', status_code=401)
        try:
            envelope = json.loads(raw_body)
        except (TypeError, ValueError, json.JSONDecodeError):
            return PlainTextResponse('', status_code=400)
        if not isinstance(envelope, dict):
            return PlainTextResponse('', status_code=400)
        if envelope.get('type') == 'url_verification':
            return PlainTextResponse(str(envelope.get('challenge', '')))
        routed = classify_event(envelope)
        if routed is None:
            return PlainTextResponse('')
        if not self._accepting or self._queue is None or self._dedup is None:
            return PlainTextResponse('', status_code=503)
        if self._dedup.contains(envelope['event_id']):
            return PlainTextResponse('')
        try:
            self._queue.put_nowait(routed)
        except asyncio.QueueFull:
            return PlainTextResponse('', status_code=503)
        self._dedup.add(envelope['event_id'])
        return PlainTextResponse('')

    def _emit_event(self, routed) -> None:
        """Write one routed event to its target pipe."""
        envelope = routed.envelope
        event_id = envelope['event_id']
        team_id = envelope.get('team_id', '')
        entry = getObject(
            obj={
                'url': f'slack://{team_id}/{event_id}',
                'name': event_id,
            }
        )
        entry.fromDict({'metadata': envelope})
        payload_size = (
            len(routed.payload.encode('utf-8'))
            if routed.lane == 'text'
            else len(json.dumps(routed.payload, separators=(',', ':'), ensure_ascii=False).encode('utf-8'))
        )
        pipe = self.target.getPipe()
        try:
            pipe.open(entry)
            if routed.lane == 'text':
                pipe.writeText(routed.payload)
            else:
                pipe.writeJson(IJson(routed.payload))
            pipe.close()
            monitorCompleted(payload_size)
        except Exception:
            monitorFailed(payload_size)
        finally:
            self.target.putPipe(pipe)

    async def _consume_queue(self) -> None:
        """Deliver queued Slack events to the target pipe."""
        while True:
            routed = await self._queue.get()
            try:
                if routed is None:
                    return
                try:
                    self._delivery_task = asyncio.create_task(asyncio.to_thread(self._emit_event, routed))
                    await asyncio.shield(self._delivery_task)
                except Exception:
                    monitorFailed(0)
                finally:
                    if self._delivery_task.done():
                        self._delivery_task = None
            finally:
                self._queue.task_done()

    def _queue_capacity(self) -> int:
        """Return the configured bounded event queue capacity."""
        parameters = getattr(self.endpoint, 'serviceConfig', {}).get('parameters', {})
        return min(10000, max(1, int(parameters.get('queueCapacity', 1000))))

    def _dedup_ttl(self) -> int:
        """Return the configured event deduplication TTL."""
        parameters = getattr(self.endpoint, 'serviceConfig', {}).get('parameters', {})
        return min(3600, max(300, int(parameters.get('dedupTtlSeconds', TtlDedupCache.TTL_SECONDS))))

    async def _startup(self) -> None:
        """Initialize the callback queue and start its delivery worker."""
        self._accepting = True
        self._queue = asyncio.Queue(maxsize=self._queue_capacity())
        self._dedup = TtlDedupCache(ttl_seconds=self._dedup_ttl())
        self._consumer_task = asyncio.create_task(self._consume_queue())
        monitorStatus('Slack Events ready - waiting for events')

    async def _shutdown(self) -> None:
        """Stop intake, drain queued work, and finish active delivery safely."""
        self._accepting = False
        if self._queue is not None and self._consumer_task is not None:
            try:
                await asyncio.wait_for(self._queue.join(), timeout=5)
                await self._queue.put(None)
                await asyncio.wait_for(self._consumer_task, timeout=5)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                self._consumer_task.cancel()
                try:
                    await self._consumer_task
                except asyncio.CancelledError:
                    pass
            if self._delivery_task is not None:
                try:
                    await asyncio.shield(self._delivery_task)
                except Exception:
                    monitorFailed(0)
                finally:
                    self._delivery_task = None
            self._consumer_task = None
        self._signing_secret = ''
        monitorOther('usr', '')

    def _run(self) -> None:
        """Start the WebServer hosting the public Slack events endpoint."""
        parser = argparse.ArgumentParser(add_help=False)
        parser.add_argument('--data_host', type=str, default='localhost')
        parser.add_argument('--data_port', type=int, default=5567)
        args, _ = parser.parse_known_args(sys.argv)
        self._server = WebServer(
            config={'host': args.data_host, 'port': args.data_port},
            on_startup=self._startup,
            on_shutdown=self._shutdown,
        )
        self._server.app.state.target = self.target
        self._server.add_route('/slack/events', self._request_handler, ['POST'], public=True)
        self._server.run()

    def scanObjects(self, _path: str, _scan_callback: Callable[[dict[str, Any]], None]):
        """Start source execution when this endpoint is not in configuration mode."""
        self.target = self.endpoint.target
        if self.endpoint.openMode != OPEN_MODE.CONFIG:
            self._run()
