/**
 * MIT License
 *
 * Copyright (c) 2026 Aparavi Software AG
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/**
 * Run-log type definitions for the RocketRide TypeScript SDK.
 *
 * A task's run log is ONE continuous JSONL event stream per identity
 * (`projectId.source.runKind`); individual runs are chapters (tracks)
 * inside it. Streams are addressed by the plain identity tuple — never by
 * token.
 */

// =============================================================================
// LOG TYPES
// =============================================================================

/** The two run kinds — separate continua per task identity. */
export type LogRunKind = 'dev' | 'deploy';

/** Identity tuple addressing one run-log stream. */
export interface LogStreamRef {
	projectId: string;
	source: string;
	runKind: LogRunKind;
}

/** One chapter (track) — a run inside the continuum. */
export interface LogChapter {
	/** Run start (epoch seconds). */
	beginTime: number;
	/** First continuum seq of the run. */
	beginSeq: number;
	/** Run end (epoch seconds); null while the run is live. */
	endTime?: number | null;
	/** 'ok' | 'error' | 'cancelled'; null while the run is live. */
	outcome?: string | null;
}

/** One activity span (segment time range) for the activity bar. */
export interface LogActivitySpan {
	/** Segment id — the raw segment fetch / DVR cache key. */
	id?: number;
	/** First continuum seq recorded in this segment. */
	seq?: number;
	startTime?: number | null;
	endTime?: number | null;
	/** A run begins within this span. */
	chapterStart: boolean;
}

/** Response of `client.log.chapters()` — the whole timeline in one read. */
export interface LogChaptersResult {
	chapters: LogChapter[];
	segments: LogActivitySpan[];
	/** Retained-window start (the horizon), epoch seconds. */
	startTime?: number | null;
	/** Latest activity, epoch seconds. */
	endTime?: number | null;
	/** First seq still retained after ring/age eviction. */
	horizonSeq: number;
	/** True when no run is currently writing the stream. */
	completed: boolean;
}

/** Range/paging options for `client.log.read()`. */
export interface LogReadParams {
	/** Inclusive seq lower bound. */
	fromSeq?: number;
	/** Inclusive seq upper bound. */
	toSeq?: number;
	/** Inclusive eventTime lower bound (epoch seconds). */
	fromTime?: number;
	/** Inclusive eventTime upper bound (epoch seconds); omit for "to now". */
	toTime?: number;
	/** Read up to and including this segment id. */
	toSegment?: number;
	/** Continuation seq from a previous page's `nextSeq`. */
	cursor?: number;
	/** Page limit (server clamps to its maximum). */
	maxEvents?: number;
	/** Page byte limit (server clamps to its maximum). */
	maxBytes?: number;
	/** Server-side event-type filter (e.g. ['output'] for the Log page). */
	types?: string[];
}

/**
 * The body of a stamped task event — the COMPLETE task-scoped record.
 *
 * The continuum stamps live here, beside the project_id/source identity the
 * server stamps at its forward choke point. The DAP envelope around this
 * body is pure protocol (its `seq` is per-connection bookkeeping,
 * meaningless to the continuum) and carries nothing of ours.
 */
export interface LogEventBody {
	/** Continuum emission time (epoch seconds, float), stamped at engine ingress. */
	eventTime: number;
	/** Continuum sequence — catalog-seeded, strictly monotonic per stream. */
	logSeq: number;
	[key: string]: unknown;
}

/**
 * One logged event — a stamped DAP event message line.
 *
 * There is ONE representation of the stamps: the body. Legacy v2 segments
 * (which carried the stamps at the header) are canonicalized into the body
 * at decode (see log-codec normalizeStamps), so consumers never read a
 * top-level stamp.
 */
export interface LogEvent {
	type: 'event';
	event: string;
	body: LogEventBody;
	[key: string]: unknown;
}

/** Response of `client.log.read()`. */
export interface LogReadResult {
	events: LogEvent[];
	/** Present when paged: pass as `cursor` to continue. */
	nextSeq?: number;
	/** Present when the request reached below the retention horizon. */
	truncatedAtSeq?: number;
}

/** Response of `client.log.delete()`. */
export interface LogDeleteResult {
	deletedSegments: number;
}

/** A position on the continuum: epoch seconds, or 'live' (pinned to now). */
export type LogPosition = number | 'live';

/** One trace (document) summary at the session position. */
export interface LogTraceSummary {
	/**
	 * Display id. For fold summaries this is the pipe SLOT (reused across
	 * requests); for getTrace results it is the begin seq. Always pass
	 * {@link beginSeq} (or a begin event's seq) to `getTrace` — that is the
	 * trace's permanent identity.
	 */
	id: number | string;
	/** The trace's begin-event continuum seq — its PERMANENT identity. */
	beginSeq?: number;
	/** Document/object name (the trace's display name). */
	doc?: string;
	/** Run start of this trace (epoch seconds). */
	beginTime?: number;
	/** Seconds from begin to close (closed traces only). */
	elapsed?: number;
	/** Number of component calls seen. */
	calls?: number;
	/** True while the trace is still in flight at the position. */
	open: boolean;
	/** Segment ids containing this trace's events (sparse expand list). */
	touched?: number[];
}

/** Response of `LogEventStream.getTraces()` — state at the position. */
export interface LogTracesResult {
	/** ALL in-flight traces at the position (bounded by real concurrency). */
	open: LogTraceSummary[];
	/** The most recently completed traces before the position (≤ n). */
	closed: LogTraceSummary[];
}

/** Response of `LogEventStream.getTrace()` — one trace's full event set. */
export interface LogTraceDetail {
	summary: LogTraceSummary;
	/** Every event belonging to this trace, seq-ordered, fully reconstructed. */
	events: LogEvent[];
}

/** Items delivered to the `play()` callback. */
export interface LogPlayItem {
	/** One reconstructed event, delivered in seq order. */
	event: LogEvent;
}

/** The `play()` callback. */
export type LogPlayCallback = (item: LogPlayItem) => void;

/** Options for `client.log.segment()`. */
export interface LogSegmentParams {
	/** Byte offset to continue from (0 = segment start). */
	offset?: number;
	/** Chunk ceiling in bytes (clamped by the server; 0/omitted = server default). */
	maxBytes?: number;
}

/**
 * Response of `client.log.segment()` — one whole-line-aligned chunk of a
 * segment's raw JSONL. Repeat with `nextOffset` until `final`.
 */
export interface LogSegmentResult {
	/** Segment id within the stream. */
	segment: number;
	/** Byte offset this chunk starts at. */
	offset: number;
	/** Raw JSONL text — every chunk ends on a line boundary, parse standalone. */
	data: string;
	/** Total segment size in bytes (grows while the segment is active). */
	size: number;
	/** Pass back as `offset` to continue; null when exhausted. */
	nextOffset: number | null;
	/** True when this chunk reached the end of the segment. */
	final: boolean;
}
