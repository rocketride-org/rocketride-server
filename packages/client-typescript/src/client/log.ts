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
 * Run-log API namespace for the RocketRide TypeScript SDK.
 *
 * Provides typed access to the per-task run-log continuum via the
 * `rrext_log` DAP command (dispatched by `subcommand`): chapters (tracks)
 * for the activity bar, ranged/paged event reads for replay, and log
 * deletion. The server (EaaS) is the ONE read path — it composes store
 * segments and local spool via the stream's control file; clients never
 * touch storage.
 */

import type { RocketRideClient } from './client.js';
import { LogEventStream } from './log-stream.js';
import type {
	LogChaptersResult,
	LogDeleteResult,
	LogReadParams,
	LogReadResult,
	LogSegmentParams,
	LogSegmentResult,
	LogStreamRef,
} from './types/log.js';

// =============================================================================
// LOG API CLASS
// =============================================================================

/**
 * Typed wrapper around the `rrext_log` DAP command and its subcommands.
 *
 * Accessed via `client.log` — not instantiated directly. All methods
 * delegate to {@link RocketRideClient.call} which handles envelope
 * unwrapping and error propagation.
 */
export class LogApi {
	/** @param client - The parent RocketRideClient that owns this namespace. */
	constructor(private client: RocketRideClient) {}

	// =========================================================================
	// RUN LOG
	// =========================================================================

	/**
	 * Opens a DVR session over one source continuum.
	 *
	 * The session is the replay/monitoring surface: position-based
	 * `seek`/`get*`/`play` over reconstructed events — storage layout
	 * (segments, keyframes, deltas) is invisible. Dispose with
	 * {@link LogEventStream.closeEventStream} when done.
	 *
	 * @param stream - Identity tuple (projectId + source + runKind).
	 * @returns A new, unpositioned session (call `seek()` first).
	 */
	openEventStream(stream: LogStreamRef): LogEventStream {
		return new LogEventStream(this.client, stream);
	}

	/**
	 * Lists a stream's chapters (tracks) and activity-bar metadata.
	 *
	 * Everything the timeline needs from one small read: per-run begin/end
	 * times + starting seq + outcome, segment activity spans, the stream's
	 * retained window, and the retention horizon.
	 *
	 * @param stream - Identity tuple (projectId + source + runKind).
	 * @returns Chapters, activity spans, and stream timeline metadata.
	 */
	async chapters(stream: LogStreamRef): Promise<LogChaptersResult> {
		return this.client.call<LogChaptersResult>('rrext_log', {
			subcommand: 'chapters',
			...stream,
		});
	}

	/**
	 * Reads a seq/time range of events from the continuum, paged.
	 *
	 * Range forms: `fromSeq`/`toSeq`, `fromTime`/`toTime` (omit the upper
	 * bound for "to now"), or `fromTime` → `toSegment`. When the response
	 * carries `nextSeq`, pass it back as `cursor` to continue; a
	 * `truncatedAtSeq` flag means the request reached below the retention
	 * horizon.
	 *
	 * @param stream - Identity tuple (projectId + source + runKind).
	 * @param params - Range, paging, and filter options.
	 * @returns The page of events plus paging/truncation metadata.
	 */
	async read(stream: LogStreamRef, params: LogReadParams = {}): Promise<LogReadResult> {
		return this.client.call<LogReadResult>('rrext_log', {
			subcommand: 'read',
			...stream,
			...params,
		});
	}

	/**
	 * Fetches one segment's raw JSONL bytes, chunked by byte offset.
	 *
	 * The bulk replay path: the server does no line scanning, filtering, or
	 * parsing — it hands over the immutable segment content in
	 * whole-line-aligned chunks (each response ends on a newline, so every
	 * chunk parses standalone). Repeat with the returned `nextOffset` until
	 * `final`. The active segment is served up to its current length; the
	 * live subscription covers growth past that. The segment table (ids +
	 * time extents) comes from {@link chapters}.
	 *
	 * @param stream - Identity tuple (projectId + source + runKind).
	 * @param segment - Segment id within the stream.
	 * @param params - Byte offset to continue from + optional chunk ceiling.
	 * @returns One raw chunk plus paging metadata.
	 */
	async segment(stream: LogStreamRef, segment: number, params: LogSegmentParams = {}): Promise<LogSegmentResult> {
		return this.client.call<LogSegmentResult>('rrext_log', {
			subcommand: 'segment',
			...stream,
			segment,
			...params,
		});
	}

	/**
	 * Deletes log data for a stream (destructive).
	 *
	 * Provide `beforeTime` to drop segments wholly older than the cutoff
	 * (chapters trimmed, horizon advanced), or `all: true` to remove the
	 * entire stream including its control file.
	 *
	 * @param stream - Identity tuple (projectId + source + runKind).
	 * @param options - Cutoff time and/or the delete-all flag.
	 * @returns The number of segments deleted.
	 */
	async delete(
		stream: LogStreamRef,
		options: { beforeTime?: number; all?: boolean },
	): Promise<LogDeleteResult> {
		const { beforeTime, all } = options;
		return this.client.call<LogDeleteResult>('rrext_log', {
			subcommand: 'delete',
			...stream,
			...(beforeTime !== undefined && { beforeTime }),
			...(all !== undefined && { all }),
		});
	}
}
