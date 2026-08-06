// =============================================================================
// downloadFile — trigger a browser file download from in-memory data
// =============================================================================

/**
 * Triggers a browser download of `data` as a file named `filename`.
 *
 * Wraps the data in a Blob, creates a temporary object URL, clicks a hidden
 * anchor, and revokes the URL. SaaS-only — used by the rocket-ui sidebar's
 * "Export" pipeline action (the VS Code host uses its own native save dialog).
 */
export function downloadTextFile(filename: string, data: string, mimeType = 'application/json'): void {
	const blob = new Blob([data], { type: mimeType });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	a.remove();
	// Deferred revoke: revoking in the same task makes WebKit abort the
	// still-queued download before it starts.
	setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Serializes `data` as pretty-printed JSON and downloads it as `filename`. */
export function downloadJson(filename: string, data: unknown): void {
	downloadTextFile(filename, JSON.stringify(data, null, 2), 'application/json');
}
