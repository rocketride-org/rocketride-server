// Preserve a prerendered capture's content across React's createRoot clear.
//
// The marketing routes are served as prerendered static captures (the shell's
// own rendered DOM), marked `<html data-prerendered="1">` by the prerender
// step. A JS-rendering crawler (e.g. Googlebot) runs the inline bootstrap, the
// shell boots, and `createRoot(#root).render()` CLEARS #root. The shell then
// waits on its WebSocket before it has app content — but a crawler opens no
// sockets, so ShellLayout would paint the connection-error surface over what
// was good content, and search engines score it a Soft 404.
//
// `capturePrerenderedContent()` snapshots #root's HTML BEFORE createRoot clears
// it; while the shell has no app UI, ShellLayout re-renders that snapshot back
// INTO #root (via dangerouslySetInnerHTML, so its scripts do not re-run and its
// #root styling context is preserved) instead of the error surface. Once real
// app UI mounts, React replaces it. All a no-op unless the document is a capture.

let capturedHtml: string | null = null;

export function capturePrerenderedContent(): void {
	if (document.documentElement.dataset.prerendered !== '1') return;
	const root = document.getElementById('root');
	if (root && root.innerHTML.trim().length > 0) capturedHtml = root.innerHTML;
}

export function getPrerenderedCapture(): string | null {
	return capturedHtml;
}
