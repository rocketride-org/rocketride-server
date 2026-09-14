# MIT License
#
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

"""
Run-log API namespace for the RocketRide Python SDK.

Provides typed access to the per-task run-log continuum via the
``rrext_log`` DAP command (dispatched by ``subcommand``): chapters (tracks)
for the activity bar, ranged/paged event reads for replay, and log
deletion. The server (EaaS) is the ONE read path — it composes store
segments and local spool via the stream's control file; clients never touch
storage.

Pass ``team_id`` to address that team's DEPLOY continuum (deploy runs
execute as the team and log into its tree — any teammate with monitor
rights can watch/replay). Omit it for your OWN stream, where the optional
``run_kind`` selects the continuum: ``''``/``'dev'`` is your dev stream;
``'deploy'`` is your PERSONAL (@me) deploy stream — deploy-kind but
user-owned, the one case team-presence cannot express.

Usage:
    timeline = await client.log.chapters('proj-1', 'chat_1')
    page = await client.log.read('proj-1', 'chat_1', from_seq=0)
    deploy = await client.log.chapters('proj-1', 'tools_1', team_id='team-prod')
    await client.log.delete('proj-1', 'chat_1', all=True)
"""

from __future__ import annotations

from typing import TYPE_CHECKING, List, Optional

from .log_stream import LogEventStream
from .types.log import LogChaptersResult, LogDeleteResult, LogReadResult, LogSegmentResult

if TYPE_CHECKING:
    from .client import RocketRideClient


class LogApi:
    """
    Run-log namespace on RocketRideClient.

    Accessed via ``client.log`` — not instantiated directly. All methods
    delegate to the parent client's ``call()`` method which handles envelope
    construction, sending, error detection, and tracing.
    """

    def __init__(self, client: RocketRideClient) -> None:
        """
        Bind this namespace to its parent client.

        Args:
            client: The RocketRideClient instance that owns this namespace.
        """
        self._client = client

    # =========================================================================
    # RUN LOG
    # =========================================================================

    def open_event_stream(
        self, project_id: str, source: str, *, team_id: str = '', run_kind: str = ''
    ) -> LogEventStream:
        """
        Open a DVR session over one source continuum.

        The session is the replay/monitoring surface: position-based
        ``seek``/``get_*``/``play`` over reconstructed events — storage
        layout (segments, keyframes, deltas) is invisible. Dispose with
        ``close_event_stream()`` when done.

        Args:
            project_id: Pipeline project id.
            source: Source component id.
            team_id: A team id addresses that team's deploy continuum;
                omitted = your own stream (see run_kind).
            run_kind: Teamless-scope selector: ''/'dev' = your dev stream;
                'deploy' = your personal (@me) deploy stream. Ignored when
                team_id is set.

        Returns:
            A new, unpositioned session (call ``seek()`` first).
        """
        return LogEventStream(self._client, project_id, source, team_id=team_id, run_kind=run_kind)

    async def chapters(
        self, project_id: str, source: str, *, team_id: str = '', run_kind: str = ''
    ) -> LogChaptersResult:
        """
        List a stream's chapters (tracks) and activity-bar metadata.

        Everything the timeline needs from one small read: per-run begin/end
        times + starting seq + outcome, segment activity spans, the stream's
        retained window, and the retention horizon.

        Args:
            project_id: Pipeline project id.
            source: Source component id.
            team_id: A team id addresses that team's deploy continuum;
                omitted = your own dev stream.

        Returns:
            Chapters, activity spans, and stream timeline metadata.
        """
        kwargs: dict = {'subcommand': 'chapters', 'projectId': project_id, 'source': source}
        if team_id:
            kwargs['teamId'] = team_id
        elif run_kind == 'deploy':
            kwargs['runKind'] = run_kind
        return await self._client.call('rrext_log', **kwargs)

    async def read(
        self,
        project_id: str,
        source: str,
        *,
        team_id: str = '',
        run_kind: str = '',
        from_seq: Optional[int] = None,
        to_seq: Optional[int] = None,
        from_time: Optional[float] = None,
        to_time: Optional[float] = None,
        to_segment: Optional[int] = None,
        cursor: Optional[int] = None,
        max_events: Optional[int] = None,
        max_bytes: Optional[int] = None,
        types: Optional[List[str]] = None,
    ) -> LogReadResult:
        """
        Read a seq/time range of events from the continuum, paged.

        Range forms: seq bounds, time bounds (omit the upper bound for "to
        now"), or from-time → to-segment. When the response carries
        ``nextSeq``, pass it back as ``cursor`` to continue; a
        ``truncatedAtSeq`` flag means the request reached below the
        retention horizon.

        Args:
            project_id: Pipeline project id.
            source: Source component id.
            team_id: A team id addresses that team's deploy continuum;
                omitted = your own dev stream.
            from_seq: Inclusive seq lower bound.
            to_seq: Inclusive seq upper bound.
            from_time: Inclusive eventTime lower bound (epoch seconds).
            to_time: Inclusive eventTime upper bound (epoch seconds).
            to_segment: Read up to and including this segment id.
            cursor: Continuation seq from a previous page's ``nextSeq``.
            max_events: Page limit (server clamps to its maximum).
            max_bytes: Page byte limit (server clamps to its maximum).
            types: Server-side event-type filter (e.g. ['output']).

        Returns:
            The page of events plus paging/truncation metadata.
        """
        kwargs: dict = {'subcommand': 'read', 'projectId': project_id, 'source': source}
        if team_id:
            kwargs['teamId'] = team_id
        elif run_kind == 'deploy':
            kwargs['runKind'] = run_kind
        # Only send provided range/paging options over the wire.
        for key, value in (
            ('fromSeq', from_seq),
            ('toSeq', to_seq),
            ('fromTime', from_time),
            ('toTime', to_time),
            ('toSegment', to_segment),
            ('cursor', cursor),
            ('maxEvents', max_events),
            ('maxBytes', max_bytes),
            ('types', types),
        ):
            if value is not None:
                kwargs[key] = value
        return await self._client.call('rrext_log', **kwargs)

    async def segment(
        self,
        project_id: str,
        source: str,
        segment: int,
        *,
        team_id: str = '',
        run_kind: str = '',
        offset: int = 0,
        max_bytes: Optional[int] = None,
    ) -> LogSegmentResult:
        """
        Fetch one segment's raw JSONL bytes, chunked by byte offset.

        The bulk replay path: the server does no line scanning, filtering, or
        parsing — it hands over the immutable segment content in
        whole-line-aligned chunks (every chunk ends on a newline, so each
        parses standalone). Repeat with the returned ``nextOffset`` until
        ``final``. The active segment is served up to its current length;
        the live subscription covers growth past that. The segment table
        (ids + time extents) comes from ``chapters()``.

        Args:
            project_id: Pipeline project id.
            source: Source component id.
            segment: Segment id within the stream.
            team_id: A team id addresses that team's deploy continuum;
                omitted = your own dev stream.
            offset: Byte offset to continue from (0 = segment start).
            max_bytes: Chunk ceiling (server clamps; omit for the default).

        Returns:
            One raw chunk plus paging metadata.
        """
        kwargs: dict = {
            'subcommand': 'segment',
            'projectId': project_id,
            'source': source,
            'segment': segment,
            'offset': offset,
        }
        if team_id:
            kwargs['teamId'] = team_id
        elif run_kind == 'deploy':
            kwargs['runKind'] = run_kind
        if max_bytes is not None:
            kwargs['maxBytes'] = max_bytes
        return await self._client.call('rrext_log', **kwargs)

    async def delete(
        self,
        project_id: str,
        source: str,
        *,
        team_id: str = '',
        run_kind: str = '',
        before_time: Optional[float] = None,
        all: bool = False,
    ) -> LogDeleteResult:
        """
        Delete log data for a stream (destructive).

        Provide ``before_time`` to drop segments wholly older than the
        cutoff (chapters trimmed, horizon advanced), or ``all=True`` to
        remove the entire stream including its control file.

        Args:
            project_id: Pipeline project id.
            source: Source component id.
            team_id: A team id addresses that team's deploy continuum
                (requires control rights on the team); omitted = your own
                dev stream.
            before_time: Epoch-seconds cutoff (exclusive).
            all: Remove the entire stream.

        Returns:
            The number of segments deleted.
        """
        kwargs: dict = {'subcommand': 'delete', 'projectId': project_id, 'source': source}
        if team_id:
            kwargs['teamId'] = team_id
        elif run_kind == 'deploy':
            kwargs['runKind'] = run_kind
        if before_time is not None:
            kwargs['beforeTime'] = before_time
        if all:
            kwargs['all'] = True
        return await self._client.call('rrext_log', **kwargs)
