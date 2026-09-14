// Copyright (c) 2026 Aparavi Software AG. MIT License.
import type { Response } from 'express';

/** NLB idle timeout is 350s and is fixed for TLS listeners, so the stream must
 *  speak more often than that on its own. 25s also clears the 60s idle default
 *  of most intermediate proxies. Returns a stop function; call it on close. */
export const HEARTBEAT_MS = 25_000;

export function startHeartbeat(res: Response, intervalMs = HEARTBEAT_MS): () => void {
	const timer = setInterval(() => {
		// A comment frame: valid SSE, ignored by EventSource, keeps the socket warm.
		try { res.write(': ping\n\n'); } catch { /* peer gone; close handler cleans up */ }
	}, intervalMs);
	// Never let the heartbeat hold the process open.
	if (typeof timer.unref === 'function') timer.unref();
	return () => clearInterval(timer);
}
