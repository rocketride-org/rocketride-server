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

/** One logged event — a stamped DAP event message line. */
export interface LogEvent {
	type: 'event';
	event: string;
	/** Server-stamped emission time (epoch seconds, float). */
	eventTime: number;
	/** Server-stamped continuum seq (epoch-us seeded, monotonic). */
	seq: number;
	body?: Record<string, unknown>;
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
