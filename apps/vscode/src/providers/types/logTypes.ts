// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Run-log session webview protocol (DVR/replay over the Project channel).
 *
 * Separated from `types.ts` so the extension host can import these without
 * pulling in `shared/modules/*` (the environmentTypes / deployTypes pattern).
 *
 * ProjectWebview implements the shared TaskEventSession contract over these
 * messages (component-owned refs, settled in its ONE useMessaging handler —
 * the standard protocol shape); the extension host proxies each call onto a
 * real `client.log.openEventStream(...)` session (the SDK stream IS the
 * session — cloud hands it to the components directly). `play` deliveries
 * stream back as `logsession:event` pushes tagged with the session id.
 * `teamId` present addresses a TEAM deploy continuum; absent = the caller's
 * dev stream (the scope IS the kind).
 */

// =============================================================================
// WEBVIEW -> HOST
// =============================================================================

/** Run-log session requests the webview sends to the extension host. */
export type LogSessionWebviewToHost =
	| {
			/** Open a session on one source's continuum. */
			type: 'logsession:open';
			/** Webview-allocated session identity (tags every later message). */
			sessionId: string;
			source: string;
			/** Team deploy continuum; absent = the dev stream. */
			teamId?: string;
	  }
	| {
			/** One promise-returning session call (seek / getStatus / getTrace). */
			type: 'logsession:call';
			sessionId: string;
			requestId: number;
			method: 'seek' | 'getStatus' | 'getTrace';
			args: unknown[];
	  }
	| {
			/** Start windowed delivery; items stream back as logsession:event. */
			type: 'logsession:play';
			sessionId: string;
			requestId: number;
			/** Epoch seconds | 'live' | null (null = resume from position). */
			pos: number | 'live' | null;
			speed: number;
	  }
	| {
			/** Stop delivery (the hook's runway throttle; resumed via play). */
			type: 'logsession:pause';
			sessionId: string;
	  }
	| {
			/** Feed one live event into the session (near-live merging). */
			type: 'logsession:ingest';
			sessionId: string;
			event: unknown;
	  }
	| {
			/** Dispose the host-side session. */
			type: 'logsession:close';
			sessionId: string;
	  }
	| {
			/** Chapters/timeline fetch for one source (session-independent). */
			type: 'logsession:chapters';
			requestId: number;
			source: string;
			/** Team deploy continuum; absent = the dev stream. */
			teamId?: string;
	  };

// =============================================================================
// HOST -> WEBVIEW
// =============================================================================

/** Run-log session replies/pushes the extension host sends to the webview. */
export type LogSessionHostToWebview =
	| {
			/** Settles one logsession:call / logsession:play / logsession:chapters. */
			type: 'logsession:result';
			requestId: number;
			result?: unknown;
			/** Present when the call failed (rejects the pending promise). */
			error?: string;
	  }
	| {
			/** One play-delivered item (the session's cb, forwarded). */
			type: 'logsession:event';
			sessionId: string;
			item: { event: unknown };
	  };
