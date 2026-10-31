// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// DEV PREVIEW PAGE — the builder-AUTHORED preview document (blob transport)
// =============================================================================
//
// The web App Builder serves its own preview pages, exactly like the VS Code
// dev server serves (and templates) the pages it proxies: fetch the engine's
// stitched shell index once, inject the dev boot config + a <base>, and mint
// a blob URL. A blob: URL inherits ITS CREATOR'S origin, so the page is a
// first-class same-origin shell — engine assets, localStorage session, the
// websocket, and the builder's module blobs all work — but its HTML states
// the facts the engine's anonymous static index cannot know:
//
//   window.__rrDevBoot = { appId }  →  dev flavor + dev hooks + session lock
//   <base href>                     →  root-relative assets resolve to the
//                                      engine (a blob document has no base)
//
// Consequences, all deliberate:
//   - no `rrdev=1`, no URL-convention probe, no 403 noise;
//   - no tab-session keys leak into the top shell (nothing is persisted);
//   - the page's lifetime is VISIBLY chained to the builder: the blob URL
//     dies with the builder document, so an orphaned debug tab cannot
//     half-boot into a generic shell and time out confused.
// =============================================================================

/** One authored page per (appId, index snapshot); revoked by the caller. */
export interface DevPreviewPage {
	/** The blob URL to load (iframe src / window.open target). */
	url: string;
	/** Releases the blob. Already-loaded documents keep running. */
	revoke: () => void;
}

/**
 * Authors the dev preview document for an app and mints its blob URL.
 *
 * @param appId - The app under development (`local.myApp`).
 * @returns The authored page handle.
 * @throws When the shell index cannot be fetched (disconnected engine) —
 *         the caller falls back to the legacy `?appid&rrdev=1` URL.
 */
export async function createDevPreviewPage(appId: string): Promise<DevPreviewPage> {
	const res = await fetch('/shell/index.html', { cache: 'no-store' });
	if (!res.ok) throw new Error(`shell index fetch failed: HTTP ${res.status}`);
	const html = await res.text();

	// step: the config script must run before the flavor picker (end of
	// body) AND the <base> must precede every asset reference — the start
	// of <head> satisfies both with one insertion.
	const inject =
		`<base href="${window.location.origin}/">` +
		`<script>window.__rrDevBoot=${JSON.stringify({ appId })};</script>`;
	const headAt = html.indexOf('<head>');
	const authored = headAt >= 0
		? `${html.slice(0, headAt + '<head>'.length)}${inject}${html.slice(headAt + '<head>'.length)}`
		: inject + html;

	const url = URL.createObjectURL(new Blob([authored], { type: 'text/html' }));
	return { url, revoke: () => URL.revokeObjectURL(url) };
}
