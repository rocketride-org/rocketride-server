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
LaserData adapter for the Listener node.

Consumes ``agent.<agent_id>.inbox`` under consumer group ``<agent_id>`` with
the Laser SDK's ``spawn_agent`` (at-least-once, dedup, retry, dead-letter). For
each task it records ``picked_up``, runs the pipeline, replies on the task's
``reply_to`` topic and records ``replied``; the SDK commits the bookmark only
after the handler returns. A raise means no commit: the SDK retries, then
dead-letters. Replies to tasks this agent sent run the pipeline too but emit no
events (the sending side already traced them).
"""

from __future__ import annotations

import os
from typing import Any, Awaitable, Callable, Dict, Optional

from nodes.core import laserdata_tasking as tasking

Handle = Callable[[str, str], Awaitable[str]]
_DEFAULT_MAX_ATTEMPTS = 3
_MAX_DETAIL = 500


class LaserDataAdapter:
    """Delivers an agent's LaserData inbox to the pipeline."""

    def __init__(self, config: Dict[str, Any]):
        """Validate config: connection string (or env fallback), stream, agent id, max attempts."""
        raw = str(config.get('connection_string') or os.environ.get('LASER_CONNECTION_STRING', '')).strip()
        if not raw:
            raise ValueError(
                'listener: a LaserData connection string is required (node config or LASER_CONNECTION_STRING)'
            )
        self.connection_string = tasking.normalize_connection_string(raw)
        self.stream = str(config.get('stream') or tasking.DEFAULT_STREAM).strip() or tasking.DEFAULT_STREAM
        self.agent_id = tasking.validate_agent_id(config.get('agent_id'))
        try:
            self.max_attempts = max(1, int(config.get('max_attempts') or _DEFAULT_MAX_ATTEMPTS))
        except (TypeError, ValueError):
            self.max_attempts = _DEFAULT_MAX_ATTEMPTS
        self.inbox = tasking.inbox_topic(self.agent_id)
        self._laser: Any = None
        self._agent: Any = None
        self._handle: Optional[Handle] = None

    async def start(self, handle: Handle) -> None:
        """Connect, ensure topics, join the consumer group, and wait until polling."""
        import laser_sdk

        self._handle = handle
        self._laser = await laser_sdk.Laser.connect(self.connection_string, stream=self.stream)
        for name in (self.inbox, tasking.EVENTS_TOPIC):
            await self._laser.topic(name).ensure(1)
        self._agent = self._laser.spawn_agent(
            self.agent_id,
            self.inbox,
            self._on_message,
            consumer_group=self.agent_id,
            ack_on_pickup=False,
            retry_max_attempts=self.max_attempts,
        )
        await self._agent.ready()

    async def stop(self) -> None:
        """Stop consuming and close the connection."""
        if self._agent is not None:
            await self._agent.shutdown()
        if self._laser is not None:
            await self._laser.__aexit__(None, None, None)

    async def _event(self, kind: str, env: Any, detail: str = '') -> None:
        """Append one event for ``env`` to the events topic."""
        await (
            self._laser.topic(tasking.EVENTS_TOPIC)
            .publish(tasking.event(kind, env, agent=self.agent_id, detail=detail))
            .send()
        )

    async def _on_message(self, ctx: Any, message: Any) -> None:
        """spawn_agent handler: one inbox record through the pipeline."""
        env = tasking.decode(tasking.record_json(message))
        # The object URL must use a protocol the engine has registered (the
        # node's own listener://); laserdata:// fails with InvalidSchema.
        name = f'listener://{self.agent_id}/{env.task_id}'
        if env.kind == 'reply':
            await self._handle(tasking.label(env), name)
            return
        await self._event('picked_up', env)
        try:
            answer = await self._handle(tasking.label(env), name)
        except Exception as exc:
            await self._event('failed', env, detail=str(exc)[:_MAX_DETAIL])
            raise
        await ctx.reply_on(env.reply_to, tasking.encode(tasking.make_reply(env, sender=self.agent_id, body=answer)))
        await self._event('replied', env)
