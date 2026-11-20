// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// EXTERNAL LINK — open a URL from the project editor
// =============================================================================
//
// With `browser`, opens the URL in the system browser via the VS Code shell
// (used by sandboxed CTAs like the Free/Enterprise plan links). Otherwise
// opens it in an embedded WebviewPanel with an iframe, bridging theme
// colors, env vars, clipboard, file dialogs, and drag-and-drop to the
// iframe (none of which a sandboxed iframe can reach itself in VS Code).
// =============================================================================

import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { getLogger } from '../../shared/util/output';
import { assertExternalUrl } from 'shared/ops/hostOps';

/**
 * Opens a URL — system browser (`browser: true`, scheme-allowlisted) or an
 * embedded bridged iframe panel.
 *
 * @param url - The URL to open.
 * @param displayName - The embedded panel's tab title.
 * @param browser - Open in the system browser instead of embedding.
 */
export function openExternalLink(url: string, displayName?: string, browser = false): void {
	const logger = getLogger();
	if (browser) {
		// URL comes from a webview message — the shared host.openExternal
		// guard (ONE scheme allowlist, not a parallel copy) gates it.
		try {
			void vscode.env.openExternal(vscode.Uri.parse(assertExternalUrl(url)));
		} catch (error) {
			logger.error(`[PipelineProvider] ${error}`);
		}
		return;
	}
	// The embedded path takes the SAME scheme gate as the browser path (the
	// URL comes off a webview message), and its origin feeds the CSP below.
	let frameOrigin: string;
	try {
		frameOrigin = new URL(assertExternalUrl(url)).origin;
	} catch (error) {
		logger.error(`[PipelineProvider] ${error}`);
		return;
	}

	const panel = vscode.window.createWebviewPanel('rocketride.page.external', displayName || 'Pipeline', vscode.ViewColumn.One, {
		enableScripts: true,
		retainContextWhenHidden: true,
	});

	const nonce = randomBytes(24).toString('base64url');
	// The URL lands inside an HTML attribute — escape it so it cannot break
	// out of the attribute into markup of this (privileged) webview.
	const frameSrc = `${url}${url.includes('?') ? '&' : '?'}_t=${Date.now()}`.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

	panel.webview.html = `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${frameOrigin}; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">body{margin:0;padding:0}iframe{width:100%;height:100vh;border:none}</style>
</head><body>
<iframe id="app-iframe" src="${frameSrc}" allow="clipboard-read; clipboard-write"></iframe>
<script nonce="${nonce}">
(function() {
	const vscode = acquireVsCodeApi();
	const iframe = document.getElementById('app-iframe');
	const envVars = { devMode: true };
	let iframeOrigin = '*';
	try { iframeOrigin = new URL(iframe.src).origin; } catch(e) {}

	['dragenter', 'dragover'].forEach(eventName => {
		document.addEventListener(eventName, (e) => {
			e.preventDefault();
			e.stopPropagation();
			try { iframe.contentWindow.postMessage({ type: 'dragHover', x: e.clientX, y: e.clientY }, iframeOrigin); } catch(err) {}
		});
	});
	document.addEventListener('dragleave', (e) => {
		if (e.relatedTarget === null) {
			try { iframe.contentWindow.postMessage({ type: 'dragLeave' }, iframeOrigin); } catch(err) {}
		}
	});
	document.addEventListener('drop', async (e) => {
		e.preventDefault();
		e.stopPropagation();
		const files = e.dataTransfer && e.dataTransfer.files;
		if (!files || files.length === 0) return;
		const fileDataArray = [];
		for (let i = 0; i < files.length; i++) {
			const file = files[i];
			const buffer = await file.arrayBuffer();
			fileDataArray.push({ name: file.name, type: file.type || 'application/octet-stream', size: file.size, lastModified: file.lastModified, buffer: buffer });
		}
		try {
			iframe.contentWindow.postMessage({ type: 'bridgedFileDrop', files: fileDataArray }, iframeOrigin, fileDataArray.map(f => f.buffer));
			iframe.contentWindow.postMessage({ type: 'dragLeave' }, iframeOrigin);
		} catch (err) { console.error('[Parent] Error bridging file drop to iframe:', err); }
	});

	function getVSCodeThemeColors() {
		const style = getComputedStyle(document.body);
		const getColor = (varName, fallback = '') => { const value = style.getPropertyValue(varName).trim(); return value || fallback; };
		return {
			'--bg-primary': getColor('--vscode-editor-background'),
			'--bg-secondary': getColor('--vscode-sideBar-background'),
			'--bg-tertiary': getColor('--vscode-editorWidget-background'),
			'--bg-hover': getColor('--vscode-list-hoverBackground'),
			'--text-primary': getColor('--vscode-editor-foreground'),
			'--text-secondary': getColor('--vscode-descriptionForeground'),
			'--text-muted': getColor('--vscode-disabledForeground'),
			'--border-color': getColor('--vscode-panel-border'),
			'--border-hover': getColor('--vscode-focusBorder'),
			'--accent-primary': getColor('--vscode-focusBorder'),
			'--accent-secondary': getColor('--vscode-button-background'),
			'--accent-hover': getColor('--vscode-button-hoverBackground'),
			'--success-color': getColor('--vscode-terminal-ansiGreen'),
			'--error-color': getColor('--vscode-errorForeground'),
			'--warning-color': getColor('--vscode-editorWarning-foreground'),
			'--info-color': getColor('--vscode-editorInfo-foreground'),
			'--code-bg': getColor('--vscode-textCodeBlock-background'),
			'--input-bg': getColor('--vscode-input-background'),
			'--input-border': getColor('--vscode-input-border'),
			'--shadow-sm': getColor('--vscode-widget-shadow'),
			'--shadow-md': getColor('--vscode-widget-shadow'),
			'--shadow-lg': getColor('--vscode-widget-shadow')
		};
	}

	function sendDataToIframe() {
		const colors = getVSCodeThemeColors();
		try { iframe.contentWindow.postMessage({ type: 'vscodeData', env: envVars, theme: colors }, iframeOrigin); }
		catch (error) { console.error('[Parent] Error sending data to iframe:', error); }
	}

	window.addEventListener('message', (event) => {
		if (event.source === iframe.contentWindow) {
			if (event.data.type === 'view:ready') sendDataToIframe();
			if (event.data.type === 'requestPaste') vscode.postMessage({ type: 'requestPaste' });
			if (event.data.type === 'copyText' && event.data.text) vscode.postMessage({ type: 'copyText', text: event.data.text });
			if (event.data.type === 'requestFileDialog') vscode.postMessage({ type: 'requestFileDialog' });
		}
		const msg = event.data;
		if (msg.type === 'themeChanged') setTimeout(() => sendDataToIframe(), 50);
		if (msg.type === 'pasteContent' && msg.text && iframe.contentWindow) iframe.contentWindow.postMessage({ type: 'paste', text: msg.text }, iframeOrigin);
		if (msg.type === 'nativeFilesSelected' && iframe.contentWindow) iframe.contentWindow.postMessage({ type: 'nativeFilesSelected', files: msg.files }, iframeOrigin);
	});
})();
</script>
</body></html>`;

	// Bridge clipboard requests from the embedded iframe.  The chat-ui
	// (and any future embedded web app) cannot read the OS clipboard from
	// inside a VSCode webview iframe — VSCode intercepts native paste at
	// the Electron layer.  The iframe posts {type:'requestPaste'} up to
	// the bridge script, which forwards it here via vscode.postMessage;
	// we read the clipboard via the extension-host API and post the text
	// back to the webview, where the bridge relays it into the iframe.
	panel.webview.onDidReceiveMessage(async (msg) => {
		if (msg?.type === 'requestPaste') {
			const text = await vscode.env.clipboard.readText();
			panel.webview.postMessage({ type: 'pasteContent', text });
		} else if (msg?.type === 'copyText' && typeof msg.text === 'string') {
			await vscode.env.clipboard.writeText(msg.text);
		} else if (msg?.type === 'requestFileDialog') {
			// The embedded app's "Browse" button can't open an OS file picker from
			// inside the sandboxed iframe, so it posts {type:'requestFileDialog'} up to
			// the bridge, which forwards it here. Open the native dialog on the host,
			// read the chosen files, and post them back as {type:'nativeFilesSelected'};
			// the bridge relays that into the iframe. Buffers go as number[] so they
			// survive webview message serialization.
			try {
				const uris = await vscode.window.showOpenDialog({ canSelectMany: true, openLabel: 'Select' });
				if (!uris || uris.length === 0) return;
				const files = await Promise.all(
					uris.map(async (uri) => ({
						name: uri.path.split('/').pop() || 'file',
						type: '',
						lastModified: Date.now(),
						buffer: Array.from(await vscode.workspace.fs.readFile(uri)),
					}))
				);
				panel.webview.postMessage({ type: 'nativeFilesSelected', files });
			} catch (error) {
				logger.error(`[PipelineProvider] Native file dialog failed: ${error}`);
			}
		}
	});
}
